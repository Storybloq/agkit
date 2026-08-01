// The config.json schema + the CLOSED config-key registry (T-208, deliverable 1 +
// 3). Two closed sets converge here:
//
//   1. `configFileSchema` — a STRICT zod schema every byte of config.json is
//      validated against on load. NON-secrets only: it is `.strict()`, so an
//      unrecognized top-level key (INCLUDING `token`) is a validation error, and a
//      `token` key is additionally rejected by name with a pointed message (the
//      FORBIDDEN invariant: a `token` NEVER loads). Acceptance: a config.json with a
//      `token` key fails load.
//   2. `CONFIG_KEYS` — the REGISTERED CLOSED SET of user-settable keys reachable via
//      `config get|set|unset|list`. An unknown key -> `usage_error` (exit 2) + the
//      list of valid keys (config/set.ts). `token` is deliberately NOT a member.
//
// Everything is pure over plain data so the loader/commands stay testable.
import { z } from "zod";
import { ConfigError } from "./errors";

// --- the indirect-secret-source allowlist (T-227 D0-H v2) --------------------
// These shapes live HERE, in the schema module, rather than beside the reader in
// `secret-sources.ts`: `profileConfigSchema` needs them, and `secret-sources.ts`
// needs `loadConfig`/`saveConfig` — defining them there would make schema →
// secret-sources → config-file → schema a runtime cycle. The reader re-exports
// them, so callers still import the whole surface from one place.
//
// NOTHING HERE IS A SECRET. A declaration is a NAME (an env var, a path) plus,
// for a file, the inode identity approved for that path. That is why an operator
// allowlist can live in the non-secret, `.strict()`-validated config document at
// all — and why `.strict()` must stay: an unrecognized member on a declaration is
// a load error, not a field a future reader might honor.

/** At most this many declarations per profile — an allowlist is curated, not a store. */
export const MAX_SECRET_SOURCES = 64;

/**
 * A CANONICAL decimal string for a `dev`/`ino` (plan v6-2). JSON has no BigInt, so
 * the identity is persisted as TEXT — and the text form is pinned canonical (no
 * sign, no leading zeros, digits only) so two spellings of one inode can never both
 * validate and then compare unequal. A legacy numeric or a malformed string is
 * simply not a valid declaration (the reader turns that into re-authorization).
 */
export const decimalBigIntString = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "must be a canonical decimal integer string (no sign, no leading zeros)")
  .max(40);

/** `{kind:"env", name}` — the operator vouches for one environment-variable NAME. */
export const envSecretSourceSchema = z
  .object({ kind: z.literal("env"), name: z.string().min(1).max(256) })
  .strict();

/** `{kind:"file", path, dev, ino}` — a CANONICAL path plus the inode identity approved for it. */
export const fileSecretSourceSchema = z
  .object({
    kind: z.literal("file"),
    path: z.string().min(1).max(4096),
    dev: decimalBigIntString,
    ino: decimalBigIntString,
  })
  .strict();

/** One declaration. */
export const secretSourceSchema = z.discriminatedUnion("kind", [envSecretSourceSchema, fileSecretSourceSchema]);
export type SecretSource = z.infer<typeof secretSourceSchema>;

/** The per-profile declaration list. Bounded — a runaway allowlist is a smell, not a feature. */
export const secretSourcesSchema = z.array(secretSourceSchema).max(MAX_SECRET_SOURCES);

/** Per-profile NON-secret defaults (project intent + a profile-scoped API URL + the
 * operator's indirect-secret-source allowlist). A profile record NEVER holds a
 * secret — `.strict()` rejects a stray `token`/`key`, and `secret_sources` holds
 * only NAMES and inode identities (see above). */
export const profileConfigSchema = z
  .object({
    project: z.string().max(256).optional(),
    api_url: z.string().url().max(2048).optional(),
    secret_sources: secretSourcesSchema.optional(),
  })
  .strict();
export type ProfileConfig = z.infer<typeof profileConfigSchema>;

/**
 * The whole config.json document. `.strict()` is the schema-validation floor: any
 * key not enumerated here (a hand-added `token`, a typo) is a load error. `version`
 * pins the shape. `profiles` holds per-profile defaults; `confirmed_api_urls` is the
 * API-URL guard's persisted per-profile confirmation ledger (url-guard.ts).
 */
export const configFileSchema = z
  .object({
    version: z.literal(1).default(1),
    // --- the user-settable closed set (each optional; see CONFIG_KEYS) ----------
    api_url: z.string().url().max(2048).optional(),
    default_profile: z.string().max(256).optional(),
    telemetry: z.boolean().optional(),
    color: z.enum(["auto", "always", "never"]).optional(),
    // --- managed by profile.* / the guard (not by `config set`) -----------------
    profiles: z.record(z.string(), profileConfigSchema).optional(),
    confirmed_api_urls: z.record(z.string(), z.array(z.string().max(2048)).max(64)).optional(),
  })
  .strict();
export type ConfigData = z.infer<typeof configFileSchema>;

/** The empty, valid config used when the file is absent. */
export function emptyConfig(): ConfigData {
  return { version: 1 };
}

/**
 * Parse + validate a raw config object into `ConfigData`. FORBIDDEN invariant: a
 * `token` key is rejected BY NAME first (a clearer message than zod's generic
 * "unrecognized key"), then the strict schema catches every other unknown key /
 * type error. Throws `ConfigError` (usage_error, exit 2) — never a bare zod throw.
 */
export function parseConfig(raw: unknown, where: string): ConfigData {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} is not a JSON object`);
  }
  // The named-and-shamed check: credentials NEVER live in config.json.
  if (Object.hasOwn(raw as object, "token")) {
    throw new ConfigError(
      `${where} contains a forbidden 'token' key — credentials are NEVER stored in config.json; ` +
        `use the OS keychain (agkit login) or AGKIT_TOKEN`,
      { hint: "remove the 'token' key from your config.json", extra: { forbidden_key: "token" } },
    );
  }
  const result = configFileSchema.safeParse(raw);
  if (!result.success) {
    // Surface the first issue's path + message (never the raw value — it is non-secret
    // but we keep messages terse and teachable).
    const issue = result.error.issues[0];
    const at = issue?.path.length ? ` at '${issue.path.join(".")}'` : "";
    throw new ConfigError(`${where} failed validation${at}: ${issue?.message ?? "invalid config"}`, {
      hint: "fix or remove the offending key; run `agkit config list` to see valid keys",
    });
  }
  return result.data;
}

// --- the registered closed config-key set (deliverable 3) --------------------
/** A user-settable config key: how to describe, parse-from-string, read, and edit it. */
export interface ConfigKeySpec {
  readonly key: string;
  readonly describe: string;
  /** Coerce a CLI string value into the typed value (throws ConfigError on bad input). */
  parse(raw: string): unknown;
  /** Read the current value from a config document (undefined = unset). */
  get(config: ConfigData): unknown;
  /** Return a NEW config document with the key set (immutably). */
  set(config: ConfigData, value: unknown): ConfigData;
  /** Return a NEW config document with the key removed. */
  unset(config: ConfigData): ConfigData;
}

/** Reject a raw value that does not parse, teachably (no new code — usage_error). */
function bad(key: string, expected: string): never {
  throw new ConfigError(`invalid value for config key '${key}' — expected ${expected}`);
}

function parseBool(key: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return bad(key, "a boolean (true/false)");
}

function parseUrl(key: string, raw: string): string {
  const v = raw.trim();
  const parsed = profileConfigSchema.shape.api_url.safeParse(v);
  if (!parsed.success) return bad(key, "an absolute URL (https://…)");
  return v;
}

/**
 * THE closed set of user-settable keys. Order is the `config list` display order.
 * `token` is intentionally absent — there is no config path to a credential.
 */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: "api_url",
    describe: "Management API base URL (a non-default host triggers the exfiltration guard).",
    parse: (raw) => parseUrl("api_url", raw),
    get: (c) => c.api_url,
    set: (c, v) => ({ ...c, api_url: v as string }),
    unset: (c) => {
      const { api_url: _drop, ...rest } = c;
      return rest;
    },
  },
  {
    key: "default_profile",
    describe: "Profile used when neither --profile nor AGKIT_PROFILE is set.",
    parse: (raw) => {
      const v = raw.trim();
      if (v.length === 0) return bad("default_profile", "a non-empty profile name");
      return v;
    },
    get: (c) => c.default_profile,
    set: (c, v) => ({ ...c, default_profile: v as string }),
    unset: (c) => {
      const { default_profile: _drop, ...rest } = c;
      return rest;
    },
  },
  {
    key: "telemetry",
    describe: "Opt-in flag for best-effort analytics telemetry (metadata only, never content).",
    parse: (raw) => parseBool("telemetry", raw),
    get: (c) => c.telemetry,
    set: (c, v) => ({ ...c, telemetry: v as boolean }),
    unset: (c) => {
      const { telemetry: _drop, ...rest } = c;
      return rest;
    },
  },
  {
    key: "color",
    describe: "Human-output color preference: auto | always | never.",
    parse: (raw) => {
      const v = raw.trim();
      if (v !== "auto" && v !== "always" && v !== "never") return bad("color", "auto | always | never");
      return v;
    },
    get: (c) => c.color,
    set: (c, v) => ({ ...c, color: v as ConfigData["color"] }),
    unset: (c) => {
      const { color: _drop, ...rest } = c;
      return rest;
    },
  },
];

const CONFIG_KEY_MAP: ReadonlyMap<string, ConfigKeySpec> = new Map(CONFIG_KEYS.map((k) => [k.key, k]));

/** The valid key names (for the unknown-key error's teachable list). */
export const CONFIG_KEY_NAMES: readonly string[] = CONFIG_KEYS.map((k) => k.key);

/**
 * Look up a registered config key, or throw `usage_error` (exit 2) naming the CLOSED
 * set — the ticket's "unknown key -> exit 2 + the list of valid keys" (deliverable 3
 * + acceptance). NEVER silently ignores an unknown key (FORBIDDEN).
 */
export function requireConfigKey(key: string): ConfigKeySpec {
  const spec = CONFIG_KEY_MAP.get(key);
  if (spec) return spec;
  throw new ConfigError(`unknown config key '${key}' — valid keys: ${CONFIG_KEY_NAMES.join(", ")}`, {
    hint: "agkit config list",
    extra: { unknown_key: key, valid_keys: [...CONFIG_KEY_NAMES] },
  });
}
