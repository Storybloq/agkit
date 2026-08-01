// The API-URL exfiltration guard (T-208, deliverable 4). A management base URL
// pointing at a NON-DEFAULT host means the CLI is about to send a bearer credential
// somewhere other than the trusted default — a classic credential-exfiltration
// vector (a poisoned env/config re-points the CLI at an attacker's collector). So:
//
//   default host                 -> proceed silently.
//   non-default + confirmed      -> proceed silently (confirmation is ONE-TIME,
//                                    per-profile, persisted in config; NEVER re-prompt).
//   non-default + UNconfirmed:
//     interactive (TTY)          -> LOUD stderr warning + a one-time y/N confirm;
//                                    on yes, persist the host and proceed.
//     non-interactive (non-TTY)  -> exit 2 (usage_error) with the confirm instruction
//                                    (there is no prompt to answer). Acceptance #3.
//
// The non-interactive confirm channel is AGKIT_API_URL_CONFIRMED (env.ts) — the
// same shape as PL-14's AGKIT_ALLOW_INSECURE_STORAGE=1: an explicit env opt-in is
// the sanctioned way to say "yes" where no TTY can. This guard MINTS NO NEW CODE —
// the non-TTY refusal is T-207's `usage_error` (ConfigError).
import { apiUrlConfirmedEnv } from "../auth/env";
import { DEFAULT_API_URL } from "./dirs";
import { ConfigError } from "./errors";
import { loadConfig, saveConfig } from "./config-file";
import { discoverRepoProject } from "./repo-project";
import { resolveContext, type ContextFlags } from "./context";
import type { ConfigData } from "./schema";
import type { ConfigDirDeps } from "./dirs";

/** Parse `url`, or null if it does not parse (a bare hostname, garbage, etc.). */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The host component of a URL, or null if it does not parse. */
export function hostOf(url: string): string | null {
  return parseUrl(url)?.host ?? null;
}

/**
 * Is `hostname` a loopback address? Cleartext (http) to loopback never leaves the
 * machine, so it is the one sanctioned exemption from the HTTPS floor (the standard
 * local-dev posture). `URL.hostname` excludes the port and brackets `[::1]`.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** The trusted default host (from DEFAULT_API_URL). */
export const DEFAULT_API_HOST = hostOf(DEFAULT_API_URL) ?? "api.agkit.cloud";

/**
 * Is `url` the trusted default? Host AND scheme must match: `http://api.agkit.cloud`
 * is NOT the default — a cleartext downgrade to the default host must never inherit
 * the silent-proceed path (it would send the bearer credential in the clear).
 */
export function isDefaultApiUrl(url: string): boolean {
  const u = parseUrl(url);
  return u !== null && u.protocol === "https:" && u.host === DEFAULT_API_HOST;
}

/** The guard verdict for an already-resolved (apiUrl, profile) against config. */
export type GuardStatus = "default" | "confirmed" | "unconfirmed";
export interface GuardVerdict {
  readonly status: GuardStatus;
  /** The effective host (null only if api_url is unparseable). */
  readonly host: string | null;
  readonly apiUrl: string;
}

/** Has `profile` already confirmed `host`? (per-profile ledger; NEVER cross-profile.) */
function isConfirmed(config: ConfigData, profile: string, host: string): boolean {
  const list = config.confirmed_api_urls?.[profile];
  return Array.isArray(list) && list.includes(host);
}

/**
 * The verdict for a resolved (apiUrl, profile). Pure — `status` reports this WITHOUT
 * enforcing (status is always exit 0). Default host -> `default`; else `confirmed`
 * iff the per-profile ledger already lists the host, else `unconfirmed`.
 */
export function guardVerdict(config: ConfigData, profile: string, apiUrl: string): GuardVerdict {
  const u = parseUrl(apiUrl);
  const host = u?.host ?? null;
  // `default` requires BOTH the trusted host AND https — a cleartext default-host URL
  // is treated as non-default so it can never silent-proceed (see isDefaultApiUrl).
  if (u !== null && u.protocol === "https:" && u.host === DEFAULT_API_HOST) {
    return { status: "default", host, apiUrl };
  }
  if (host !== null && isConfirmed(config, profile, host)) return { status: "confirmed", host, apiUrl };
  return { status: "unconfirmed", host, apiUrl };
}

/** Return a NEW config with `host` recorded as confirmed for `profile` (immutable, deduped). */
export function withConfirmedApiUrl(config: ConfigData, profile: string, host: string): ConfigData {
  const ledger = { ...(config.confirmed_api_urls ?? {}) };
  const existing = ledger[profile] ?? [];
  if (existing.includes(host)) return config;
  ledger[profile] = [...existing, host];
  return { ...config, confirmed_api_urls: ledger };
}

/**
 * Does the env opt-in confirm THIS host? It must name the EXACT host —
 * `AGKIT_API_URL_CONFIRMED=<host>`. A blanket `1`/`yes`/`true` is deliberately NOT
 * accepted: unlike PL-14's `AGKIT_ALLOW_INSECURE_STORAGE=1` (a LOCAL storage opt-in),
 * this authorizes sending a credential to a REMOTE host, so a stale/poisoned blanket
 * value would silently exfiltrate to whatever AGKIT_API_URL currently points at. Host
 * comparison is case-insensitive (URL hosts are already lowercased on parse).
 */
function envConfirms(env: NodeJS.ProcessEnv, host: string): boolean {
  const raw = apiUrlConfirmedEnv(env);
  if (raw === null) return false;
  return raw.toLowerCase() === host.toLowerCase();
}

/** The loud stderr warning shown before a first send to a non-default host. */
export function apiUrlWarningBanner(host: string): string {
  return (
    `agkit: WARNING — the management API URL points at a NON-DEFAULT host '${host}' ` +
    `(default: ${DEFAULT_API_HOST}). Your credentials WILL be sent to '${host}'. ` +
    `Confirm only if you trust this host.\n`
  );
}

/** Seams the imperative guard needs (all injected — the shell wires the real ones). */
export interface GuardDeps extends ConfigDirDeps {
  /** cwd for repo-binding discovery (affects the effective profile/api_url). */
  readonly cwd: string;
  /** The global --profile/--project flags (feed the precedence resolver). */
  readonly flags: ContextFlags;
  /** Interactive terminal? Gates the prompt vs the non-TTY exit-2. */
  readonly isTTY: boolean;
  /** Best-effort stderr sink (the loud warning). MUST NOT throw. */
  readonly warn: (message: string) => void;
  /** Interactive y/N confirm. Only ever called when isTTY (never non-TTY). */
  readonly confirm: (question: string) => Promise<boolean>;
}

/** What the enforcement resolved to (for the shell + tests). Carries the GUARD-APPROVED
 * effective context so downstream consumers (the T-211 capability-cache key, the client
 * wiring) key off the SAME resolution the guard enforced — never a second `resolveContext`
 * pass that a between-reads config change could make diverge (A32 cache-scoping). */
export interface GuardOutcome {
  readonly status: GuardStatus;
  readonly host: string | null;
  /** True if THIS call newly persisted the confirmation. */
  readonly justConfirmed: boolean;
  /** The effective profile THIS enforcement resolved (the guard's own precedence pass). */
  readonly profile: string;
  /** The effective api_url THIS enforcement approved sending credentials to. */
  readonly apiUrl: string;
}

/**
 * Enforce the guard before a credential-consuming command sends anything
 * (deliverable 4). Loads config, resolves the effective (profile, api_url) through
 * the precedence chain, and applies the truth table above. On a fresh confirmation
 * (TTY yes, or the env opt-in) it PERSISTS the host to config so it never re-prompts.
 * Throws `ConfigError` (usage_error, exit 2) on the non-TTY unconfirmed path or a
 * declined prompt.
 */
export async function enforceApiUrlGuard(deps: GuardDeps): Promise<GuardOutcome> {
  const { config } = loadConfig(deps);
  const repo = discoverRepoProject(deps.cwd)?.project ?? null;
  const ctx = resolveContext({ flags: deps.flags, env: deps.env, repo, config });
  const profile = ctx.profile.value;
  const apiUrl = ctx.apiUrl.value;

  // Scheme floor (runs BEFORE any confirmation): the management API carries a bearer
  // credential, so ONLY two schemes may ever send it — `https:` (any host), or `http:`
  // to a LOOPBACK host (local dev, bytes never leave the machine). EVERYTHING else
  // (cleartext http to a remote host, and non-web schemes like ftp:/ws:/file:) is
  // refused outright — no confirmation can opt into it. This also closes the
  // http://api.agkit.cloud downgrade (guardVerdict no longer calls that `default`).
  const parsed = parseUrl(apiUrl);
  if (parsed !== null) {
    const httpsOk = parsed.protocol === "https:";
    const httpLoopbackOk = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
    if (!httpsOk && !httpLoopbackOk) {
      throw new ConfigError(`refusing to send credentials to a non-HTTPS management API URL '${apiUrl}'`, {
        hint: "use an https:// URL (cleartext http is only permitted for localhost)",
        extra: { api_url: apiUrl, scheme: parsed.protocol.replace(/:$/, "") },
      });
    }
  }

  const verdict = guardVerdict(config, profile, apiUrl);

  if (verdict.status !== "unconfirmed") {
    return { status: verdict.status, host: verdict.host, justConfirmed: false, profile, apiUrl };
  }

  const host = verdict.host;
  if (host === null) {
    // An unparseable non-default URL: fail loud rather than send anywhere.
    throw new ConfigError(`the management API URL '${apiUrl}' is not a valid URL`, {
      hint: "unset AGKIT_API_URL or set a valid https:// URL",
      extra: { api_url: apiUrl },
    });
  }

  // The env opt-in confirms non-interactively (and persists, so future runs are quiet).
  if (envConfirms(deps.env, host)) {
    persist(deps, config, profile, host);
    return { status: "confirmed", host, justConfirmed: true, profile, apiUrl };
  }

  // Loud warning first — on EITHER interactive branch the user sees the host.
  deps.warn(apiUrlWarningBanner(host));

  if (!deps.isTTY) {
    // Non-interactive first use: there is no prompt to answer -> exit 2 with the instruction.
    throw new ConfigError(
      `refusing to send credentials to non-default API host '${host}' without confirmation (non-interactive)`,
      {
        hint: `run this command once in an interactive terminal to confirm, or set AGKIT_API_URL_CONFIRMED=${host}`,
        extra: { host, api_url: apiUrl, profile },
      },
    );
  }

  const ok = await deps.confirm(`credentials will be sent to '${host}'. Proceed? [y/N] `);
  if (!ok) {
    throw new ConfigError(`declined: not sending credentials to non-default host '${host}'`, {
      hint: `re-run and confirm, or set AGKIT_API_URL back to the default (${DEFAULT_API_HOST})`,
      extra: { host, api_url: apiUrl, profile },
    });
  }
  persist(deps, config, profile, host);
  return { status: "confirmed", host, justConfirmed: true, profile, apiUrl };
}

/** Persist a fresh confirmation to config (per-profile). */
function persist(deps: ConfigDirDeps, config: ConfigData, profile: string, host: string): void {
  saveConfig(deps, withConfirmedApiUrl(config, profile, host));
}
