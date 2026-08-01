// Environment-derived gates + selectors for the credential chain (T-206). Pure
// functions over an injected `env` (+ the TTY seam) so the PL-14 double-opt-in
// truth table is exhaustively testable. Ratified env names (N-011 §E.4):
//   AGKIT_TOKEN, AGKIT_PROFILE, AGKIT_CREDENTIAL_HELPER, AGKIT_ALLOW_INSECURE_STORAGE.
//
// T-208 (canonical L2-CLI-06) EXTENDS this ONE env seam — it does not add a second
// place env is read — with the context/config selectors: AGKIT_PROJECT (project
// intent), AGKIT_API_URL (management base URL), AGKIT_CONFIG_DIR (config-dir
// override), and AGKIT_API_URL_CONFIRMED (the non-interactive channel for the
// API-URL exfiltration guard's one-time confirmation, mirroring PL-14's
// AGKIT_ALLOW_INSECURE_STORAGE env opt-in). Each is a raw reader returning the
// usably-set value or null so the precedence resolver can attribute a SOURCE.

/**
 * Is this a CI-like environment? Truthy `CI` EXCEPT the common falsey spellings
 * (`false` / `0` / empty), so a stray `CI=false` does not trip the gate (review
 * note). Used together with the non-interactive (`!isTTY`) signal.
 */
export function isCI(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI;
  if (ci === undefined) return false;
  return ci !== "" && ci !== "false" && ci !== "0";
}

/**
 * PL-14 predicate: does an insecure WRITE require the second opt-in? YES under CI
 * OR whenever stdin is not an interactive terminal (non-interactive). Defined
 * exactly (not "CI truthy" alone) so the gate is deterministic.
 */
export function requiresDoubleOptIn(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isCI(env) || !isTTY;
}

/** The second opt-in flag: `AGKIT_ALLOW_INSECURE_STORAGE=1` exactly. */
export function insecureDoubleOptInSatisfied(env: NodeJS.ProcessEnv): boolean {
  return env.AGKIT_ALLOW_INSECURE_STORAGE === "1";
}

/** Active profile name (keychain account / insecure-file key). Defaults to `default`. */
export function resolveProfile(env: NodeJS.ProcessEnv): string {
  const p = env.AGKIT_PROFILE?.trim();
  return p && p.length > 0 ? p : "default";
}

/** Small helper: an env var's trimmed value if usably set (non-empty), else null. */
function readTrimmed(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * The RAW `AGKIT_PROFILE` value (present-and-non-empty), or null (T-208). Distinct
 * from `resolveProfile`, which folds the default in: the precedence resolver needs
 * to know whether the env layer actually SUPPLIED the profile (to attribute the
 * `env` source) versus falling through to a lower layer.
 */
export function readEnvProfile(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.AGKIT_PROFILE);
}

/** The `AGKIT_PROJECT` value (project intent) if usably set, else null (T-208). */
export function readEnvProject(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.AGKIT_PROJECT);
}

/** The `AGKIT_API_URL` value (management base URL override) if usably set (T-208). */
export function readEnvApiUrl(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.AGKIT_API_URL);
}

/** The `AGKIT_CONFIG_DIR` override (the agentkit config dir itself) if set (T-208). */
export function readConfigDirEnv(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.AGKIT_CONFIG_DIR);
}

/** The `XDG_CONFIG_HOME` base (spec default `~/.config`) if set (T-208). */
export function readXdgConfigHome(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.XDG_CONFIG_HOME);
}

/**
 * The non-interactive confirmation channel for the API-URL exfiltration guard
 * (T-208). Under a non-TTY / CI shell there is no prompt, so an explicit env opt-in
 * is the sanctioned way to confirm "yes, send credentials to this non-default host".
 * The value MUST name the exact host (`AGKIT_API_URL_CONFIRMED=<host>`) — the guard
 * (url-guard.ts) rejects a blanket `1`/`yes`/`true`: unlike PL-14's LOCAL-storage
 * opt-in, this authorizes a REMOTE credential send, so a stale/poisoned blanket value
 * must not silently exfiltrate to whatever AGKIT_API_URL points at. Raw reader only —
 * the host-match interpretation lives in the guard.
 */
export function apiUrlConfirmedEnv(env: NodeJS.ProcessEnv): string | null {
  return readTrimmed(env.AGKIT_API_URL_CONFIRMED);
}

/**
 * The `AGKIT_TOKEN` value if usably set, else null. A present-but-empty /
 * whitespace-only variable is treated as UNSET (the least-surprising, standard
 * behavior) rather than as a bogus authenticated credential — documented; the
 * short-circuit's real contract is "a REAL token here skips the keychain".
 */
export function readEnvToken(env: NodeJS.ProcessEnv): string | null {
  const raw = env.AGKIT_TOKEN;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * The credential-helper EXECUTABLE path, if configured. Interim config surface for
 * T-206 is the `AGKIT_CREDENTIAL_HELPER` env var (the `config` command that will
 * own richer, structured helper config is a later ticket). It names an executable,
 * NOT a secret — spawned with `shell:false` and NO arguments (no shell parsing, no
 * injection).
 */
export function readHelperCommand(env: NodeJS.ProcessEnv): string | null {
  const h = env.AGKIT_CREDENTIAL_HELPER?.trim();
  return h && h.length > 0 ? h : null;
}
