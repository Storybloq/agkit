// Secret resolution for `provider-key add` / `rotate` (T-217 §3A, A5 / R34; T-227 R7 / D0-H v2).
// The raw provider key NEVER rides argv — it enters by exactly three channels, resolved HERE:
//   1. `--api-key-env <VAR>` — env-name indirection (the scriptable/CI channel): the CLI reads
//      `process.env[VAR]` via the injected `runtime.env` seam (handlers stay pure — they never
//      touch `process`). The flag WINS even on a TTY (scriptability is explicit intent).
//   2. `--api-key-file <PATH>` (T-227) — the file channel: the CONTENT of a regular, owner-only,
//      identity-checked file is the secret. The hardened read lives in `core/config/secret-sources`
//      (a descriptor-bound ladder: O_NOFOLLOW → fstat → post-open lstat → read from the fd).
//   3. a TTY hidden prompt (R-D) — when NEITHER flag is present AND stdin is a TTY AND the shell
//      injected the echo-off `runtime.promptSecret` executor. Non-TTY (or no executor) without a
//      flag is a hard, static usage_error.
// Exactly ONE of the two flags may be given: naming a secret twice is ambiguous intent, and
// silently preferring one would make the other channel a no-op the operator believes in.
//
// THE ONE RESOLUTION CORE (T-227 R7). All three channels — and the MCP `SecretRef` object union the
// un-exclusion wave adds — funnel through `resolveSecretRef(ctx, ref, policy)`. The CLI argv
// adapter is thin (`resolveWireSecret` maps flags/prompt onto a `SecretRef`), so there is exactly
// one place where a secret is obtained, capped, and refused. `policy.channel` is the TRUST
// BOUNDARY: on `"cli"` the operator typed the flag and IS the authorization; on `"mcp"` the caller
// is NOT the operator, so `env`/`file` are honored only when the exact name/path was pre-declared
// in the profile's `secret_sources` allowlist. `inline` is always accepted on both (the caller
// already holds the value — honoring it creates no new exfiltration primitive).
//
// [R-H #2 — codex CRITICAL] EVERY error here is STATIC — it NEVER reproduces the flag value, the
// var name, or the path. The grammar gate `/^[A-Za-z_][A-Za-z0-9_]*$/` does NOT prove the value is
// a var name: a pasted secret like `SK_LIVE_a1b2c3` passes the grammar, reaches the missing-var
// branch, and would be echoed by an interpolated message. So no branch (message/detail/hint/
// envelope) interpolates the value or the name. This module is the ONLY env reader for these
// commands; it never logs and never attaches the value OR the name to any Error.
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Ctx } from "../types";
import { requireRuntime } from "../types";
import { CliLocalError } from "../../core/errors";
import {
  declaredSecretSources,
  findDeclaredEnv,
  findDeclaredFile,
  readDeclaredSecretFile,
  readSecretFile,
} from "../../core/config/secret-sources";
import type { SecretRef } from "./secret-ref";

/** A conservative POSIX-ish environment-variable NAME: letters/underscore first, then alnum/underscore. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The parsed shape both `add` and `rotate` expose to the resolver (the only keys it reads). */
export interface ProviderKeySecretInput {
  readonly "api-key-env"?: string;
  readonly "api-key-file"?: string;
}

// The three STATIC messages (zero interpolation — the whole point of R-H #2).
const GRAMMAR_DETAIL =
  "--api-key-env takes the NAME of an environment variable (letters, digits, underscore; not starting with a digit). Export the key first (e.g. export MY_PROVIDER_KEY=...) and pass the variable's NAME.";
const MISSING_ENV_DETAIL =
  "the environment variable named by --api-key-env is not set or is empty in this shell.";
const NO_CHANNEL_DETAIL =
  "provide --api-key-env <VAR_NAME> or --api-key-file <PATH> (non-interactive), or run in an interactive terminal for a hidden prompt.";
const EMPTY_PROMPT_DETAIL = "no API key provided.";
/** T-227: both secret flags at once. STATIC — it names the FLAGS, never either value. */
const BOTH_CHANNELS_DETAIL =
  "two secret channels were given at once — pass exactly one of --api-key-env <VAR_NAME> or --api-key-file <PATH> (or neither, for the interactive hidden prompt).";

/** The hidden-prompt question — a fixed string, never carrying any user-controlled value. */
export const SECRET_PROMPT_QUESTION = "Paste the provider API key (input hidden): ";

/**
 * T-219 A3 (ratified cap): the maximum size of a wire secret on EITHER channel (env value or
 * prompt answer), measured in UTF-8 ENCODED BYTES (r5-5: `Buffer.byteLength(v, "utf8")`, never JS
 * string `.length` — code units would let a multibyte payload ~4x the budget through). Real
 * provider/RevenueCat keys are ≤ ~200 bytes; 8 KiB is ~40x headroom yet blocks a pathological
 * multi-MB env payload from riding into a request body. Rejected PRE-network with a STATIC
 * message (names the limit — never the value or its length).
 */
export const MAX_SECRET_BYTES = 8192;

const OVERSIZE_DETAIL = `the provided secret exceeds the ${MAX_SECRET_BYTES}-byte limit.`;

/** Enforce the A3 cap on a resolved secret (either channel). STATIC failure — value-free. */
function assertSecretSize(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new CliLocalError("usage_error", { detail: OVERSIZE_DETAIL });
  }
  return value;
}

/**
 * Read the value of the env var NAMED by `--api-key-env` from the injected runtime env. The grammar
 * gate rejects a non-name (a pasted secret) BEFORE the env read; a set-but-empty or unset var is the
 * SAME static missing/empty error. Returns the raw secret value — NEVER logs, NEVER echoes.
 */
export function readSecretFromEnv(
  ctx: Ctx,
  varName: string,
  details: { grammarDetail: string; missingEnvDetail: string } = {
    grammarDetail: GRAMMAR_DETAIL,
    missingEnvDetail: MISSING_ENV_DETAIL,
  },
): string {
  if (!ENV_VAR_NAME.test(varName)) {
    // STATIC: never echo `varName` — a grammar-valid-looking paste must not surface here either.
    throw new CliLocalError("usage_error", { detail: details.grammarDetail });
  }
  const value = requireRuntime(ctx).env[varName];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliLocalError("usage_error", { detail: details.missingEnvDetail });
  }
  return assertSecretSize(value);
}

/**
 * Pre-flight the env-NAME channel WITHOUT retaining the secret. Grammar, presence and size are all
 * checkable BEFORE any mutation, so an orchestrator (`agkit init`) can refuse a bad channel at
 * GATHER time — after a shown-once mint the same failure could only be a committed partial. The
 * value is read and immediately DISCARDED; resolution (and custody) still happens at change-build
 * time via `resolveWireSecret`, which re-runs the identical checks (single source: this delegates
 * to `readSecretFromEnv`, never a copied predicate). STATIC failures only — R-H #2 holds here too.
 */
export function preflightEnvSecret(
  ctx: Ctx,
  varName: string,
  details: { grammarDetail: string; missingEnvDetail: string },
): void {
  void readSecretFromEnv(ctx, varName, details);
}

// ── the ONE resolution core (T-227 R7 / D0-H v2) ────────────────────────────────────────────────

/**
 * T-227 (plan v4-3): the floor on a secret resolved over the MCP channel, in UTF-8 bytes. Real
 * provider credentials are far longer; the bound exists so a degenerate one- or two-byte "secret"
 * cannot be pushed through the request-scoped suppression machinery as a sentinel that then masks
 * ordinary prose in every subsequent result. Fails CLOSED, before any network request. The CLI
 * channel does NOT carry it: the operator at the terminal may store whatever the provider issued.
 */
export const MCP_MIN_SECRET_BYTES = 16;

const UNDECLARED_ENV_DETAIL =
  "this environment variable is not a declared secret source for the active profile. Over MCP, an env-sourced secret is honored only when the operator pre-declared the exact variable NAME in the profile's secret_sources allowlist (declared from the CLI only). Nothing was read.";
const UNDECLARED_FILE_DETAIL =
  "this path is not a declared secret source for the active profile. Over MCP, a file-sourced secret is honored only when the operator pre-declared the exact CANONICAL path in the profile's secret_sources allowlist (declared from the CLI only). Nothing was read.";
const MIN_BYTES_DETAIL = `the resolved secret is shorter than the ${MCP_MIN_SECRET_BYTES}-byte minimum for this channel.`;

/**
 * The resolution POLICY — the trust boundary plus the byte bounds, supplied by the adapter that
 * built the `SecretRef`.
 *
 *   channel  — `"cli"`: the operator typed it, so `env`/`file` need no allowlist.
 *              `"mcp"`: the caller is not the operator, so `env`/`file` must be pre-declared.
 *   minBytes — a floor on the resolved value (MCP passes `MCP_MIN_SECRET_BYTES`; the CLI passes none).
 *   env      — the caller's STATIC grammar/missing messages for the env channel (R-H #2).
 *   inlineEmptyDetail — the caller's STATIC message for an empty inline value (the prompt path's).
 *
 * There is deliberately NO `maxBytes` knob: the CEILING is the single ratified `MAX_SECRET_BYTES`
 * for every source and every channel (plan v3-5), and the refusal message names that constant. A
 * per-call ceiling would let the message and the enforced bound drift apart.
 */
export interface SecretRefPolicy {
  readonly channel: "cli" | "mcp";
  readonly minBytes?: number;
  readonly env?: { readonly grammarDetail: string; readonly missingEnvDetail: string };
  readonly inlineEmptyDetail?: string;
}

/** Enforce the policy floor (STATIC — names the minimum, never the value or its measured length). */
function assertMinBytes(value: string, policy: SecretRefPolicy): string {
  if (policy.minBytes !== undefined && Buffer.byteLength(value, "utf8") < policy.minBytes) {
    throw new CliLocalError("usage_error", { detail: MIN_BYTES_DETAIL });
  }
  return value;
}

/** The config/allowlist seam, read off the injected runtime (handlers never touch `process`). */
function secretSourceDeps(ctx: Ctx): { env: NodeJS.ProcessEnv; homeDir: string; cwd: string; flags: { profile?: string; project?: string } } {
  const runtime = requireRuntime(ctx);
  return { env: runtime.env, homeDir: runtime.homeDir, cwd: runtime.cwd, flags: runtime.flags };
}

/**
 * THE resolution core. One function obtains every secret this CLI sends, from every source, on
 * every channel — so the cap, the floor, the allowlist and the "never echo the material" rule have
 * exactly one implementation each.
 *
 *   inline — accepted on both channels; bounded above and below. The value is already in the
 *            caller's hands, so honoring it grants no read authority that did not already exist.
 *   env    — CLI: the as-built `readSecretFromEnv` ladder, byte for byte (grammar gate → injected
 *            `runtime.env` read → cap), because the operator typed the flag.
 *            MCP: the name must be EXACTLY declared in `secret_sources`. An undeclared name is
 *            refused WITHOUT READING ANY ENV VAR — the allowlist check precedes the read, so a
 *            hostile caller cannot even probe which variables exist.
 *   file   — CLI: the operator-typed path, read through the hardened descriptor ladder.
 *            MCP: the path must be EXACTLY declared (the STORED canonical path, compared verbatim
 *            — the caller's path is never realpath'd into a match), and the read additionally binds
 *            to the APPROVED inode identity; a replacement yields the re-authorization message.
 *
 * The resolved value is RETURNED and nothing else: never logged, never attached to an Error, never
 * persisted. Every refusal names the MECHANISM (the flag, the cap, the allowlist, `chmod 600`) and
 * never the content.
 */
export function resolveSecretRef(ctx: Ctx, ref: SecretRef, policy: SecretRefPolicy): string {
  switch (ref.source) {
    case "inline": {
      if (ref.value.length === 0) {
        throw new CliLocalError("usage_error", { detail: policy.inlineEmptyDetail ?? EMPTY_PROMPT_DETAIL });
      }
      return assertMinBytes(assertSecretSize(ref.value), policy);
    }
    case "env": {
      if (policy.channel === "mcp") {
        // Allowlist FIRST — before the grammar gate, before any read of `runtime.env`.
        const sources = declaredSecretSources(secretSourceDeps(ctx));
        if (findDeclaredEnv(sources, ref.name) === null) {
          throw new CliLocalError("usage_error", { detail: UNDECLARED_ENV_DETAIL });
        }
      }
      const details = policy.env ?? { grammarDetail: GRAMMAR_DETAIL, missingEnvDetail: MISSING_ENV_DETAIL };
      return assertMinBytes(readSecretFromEnv(ctx, ref.name, details), policy);
    }
    case "file": {
      if (policy.channel === "mcp") {
        const sources = declaredSecretSources(secretSourceDeps(ctx));
        const declared = findDeclaredFile(sources, ref.path);
        if (declared === null) {
          throw new CliLocalError("usage_error", { detail: UNDECLARED_FILE_DETAIL });
        }
        return assertMinBytes(readDeclaredSecretFile(declared, { maxBytes: MAX_SECRET_BYTES }), policy);
      }
      // CLI: the operator typed the path. Relative paths resolve against the invocation's cwd (the
      // injected seam — never `process.cwd()`), so the hardened reader always sees an absolute path.
      const cwd = requireRuntime(ctx).cwd;
      const absolute = isAbsolute(ref.path) ? ref.path : resolvePath(cwd, ref.path);
      return assertMinBytes(readSecretFile(absolute, { maxBytes: MAX_SECRET_BYTES }).value, policy);
    }
  }
}

/**
 * The static-message configuration a caller supplies to `resolveWireSecret` (B0 shared-core,
 * sub-wave B). EVERY field is a caller-owned STATIC constant (R-H #2: zero interpolation of any
 * value or var-name). `envArg` names the parsed-input key carrying the env-var NAME (e.g.
 * `"api-key-env"`, `"resource-id-env"`); the resolver reads `input[envArg]`, never `Ctx`.
 * `fileArg` (T-227, OPTIONAL) names the parsed-input key carrying a PATH — a caller that omits it
 * has no file channel and behaves exactly as it did before T-227.
 */
export interface WireSecretConfig {
  readonly envArg: string;
  readonly promptQuestion: string;
  readonly emptyDetail: string;
  readonly noChannelDetail: string;
  readonly grammarDetail: string;
  readonly missingEnvDetail: string;
  readonly fileArg?: string;
  readonly bothChannelsDetail?: string;
}

/** The provider-key resolver's exact configuration — the T-217 baseline plus T-227's file channel. */
const PROVIDER_KEY_SECRET_CONFIG: WireSecretConfig = {
  envArg: "api-key-env",
  fileArg: "api-key-file",
  promptQuestion: SECRET_PROMPT_QUESTION,
  emptyDetail: EMPTY_PROMPT_DETAIL,
  noChannelDetail: NO_CHANNEL_DETAIL,
  grammarDetail: GRAMMAR_DETAIL,
  missingEnvDetail: MISSING_ENV_DETAIL,
  bothChannelsDetail: BOTH_CHANNELS_DETAIL,
};

/** Read a configured argv key as a string, treating any non-string as absent. */
function flagValue<T extends object>(input: T, key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const raw = (input as Readonly<Record<string, unknown>>)[key];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Resolve a WIRE SECRET that must never ride argv (B0 shared-core, sub-wave B) — the generalization
 * of `resolveProviderKeySecret` shared by `provider-key` (T-217), `revenuecat set` (T-219), and
 * `voice-identity set` (T-220). This is the CLI ARGV ADAPTER: it maps flags/prompt onto a
 * `SecretRef` and hands it to the one core. Resolution order is identical to the original:
 *   0. `input[cfg.envArg]` AND `input[cfg.fileArg]` both present ⇒ static mutual-exclusion error.
 *   1. `input[cfg.envArg]` present ⇒ read the NAMED env var (the flag WINS even on a TTY — explicit
 *      scriptability); a non-name/pasted-secret ⇒ static grammar error; unset/empty ⇒ static missing.
 *   2. `input[cfg.fileArg]` present ⇒ the hardened file read (T-227).
 *   3. else TTY + injected `runtime.promptSecret` ⇒ ONE echo-off hidden prompt; empty/null ⇒ static.
 *   4. else static `usage_error` naming BOTH channels.
 * The value exists ONLY as the returned string (an outbound body member downstream) — never in argv,
 * never in a reconstructed invocation, never in ANY error (every message here is a STATIC constant).
 */
export async function resolveWireSecret<T extends object>(
  ctx: Ctx,
  input: T,
  cfg: WireSecretConfig,
): Promise<string> {
  const policy: SecretRefPolicy = {
    channel: "cli",
    env: { grammarDetail: cfg.grammarDetail, missingEnvDetail: cfg.missingEnvDetail },
    inlineEmptyDetail: cfg.emptyDetail,
  };
  const varName = flagValue(input, cfg.envArg);
  const filePath = flagValue(input, cfg.fileArg);
  if (varName !== undefined && filePath !== undefined) {
    throw new CliLocalError("usage_error", { detail: cfg.bothChannelsDetail ?? cfg.noChannelDetail });
  }
  if (varName !== undefined) return resolveSecretRef(ctx, { source: "env", name: varName }, policy);
  if (filePath !== undefined) return resolveSecretRef(ctx, { source: "file", path: filePath }, policy);

  const runtime = requireRuntime(ctx);
  if (runtime.isTTY && runtime.promptSecret !== undefined) {
    const answer = await runtime.promptSecret(cfg.promptQuestion);
    // A prompt answer IS an inline secret — the same core bounds it, so the TTY channel can never
    // drift from the object channel on the cap, the floor, or the empty-value refusal.
    if (answer === null) throw new CliLocalError("usage_error", { detail: cfg.emptyDetail });
    return resolveSecretRef(ctx, { source: "inline", value: answer }, policy);
  }
  throw new CliLocalError("usage_error", { detail: cfg.noChannelDetail });
}

/**
 * Resolve the provider API key for `add` / `rotate` (§3A.4 resolution order). Used by BOTH the
 * direct `add` handler and the async `rotate` change builder — the prompted value follows the
 * IDENTICAL no-echo/redaction rules as the env value (it exists only as the `api_key` body member,
 * chokepoint-masked; never in argv, never in a reconstructed invocation, never in any error).
 */
export async function resolveProviderKeySecret(ctx: Ctx, parsed: ProviderKeySecretInput): Promise<string> {
  // Behavior-preserving delegation to the B0 generalization (identical resolution order + STATIC
  // messages). The T-217 suite stays byte-green because the provider-key config carries its exact
  // constants (envArg "api-key-env", the same grammar/missing/empty/no-channel details).
  return resolveWireSecret(ctx, parsed, PROVIDER_KEY_SECRET_CONFIG);
}
