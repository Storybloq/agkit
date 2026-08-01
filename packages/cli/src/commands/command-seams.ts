// The auth-command + service-command I/O seams (T-213 / T-222). Extracted from `types.ts` to keep
// that file under the packages/cli max-lines cap; `types.ts` re-exports every name below, so every
// consumer keeps importing from `./types`. These are the injected seams a handler reads via
// `requireAuth(ctx)` / `requireService(ctx)` so it stays pure (no `process`/`node:fs`/network access
// in the handler itself). The type-only import of `Ctx` from `./types` is erased at build — there is
// no runtime cycle (this module has no runtime dependency on `types.ts`).
import type { CredentialRecord } from "../core/auth/record";
import type { StoreOptions } from "../core/auth/chain";
import type { CredentialSource } from "../core/auth/types";
import type { LoginIoSeams } from "../core/auth/login-flow";
import type { InstallFs } from "../core/housekeeping/install";
import type { Ctx } from "./types";

/** The guard-approved OAuth-boundary context a `login`/`logout` command sends credentials to. */
export interface ApprovedApiContext {
  /** The guard-approved management base URL (its origin is the OAuth-boundary origin). */
  readonly apiUrl: string;
  /** The effective profile the credential store/clear operations bind to. */
  readonly profile: string;
}

/** What a `logout` local-clear reported for one profile (keychain + plaintext removal). */
export interface ProfileClearResult {
  readonly profile: string;
  /** A keychain entry was removed. */
  readonly keychain_removed: boolean;
  /** The keychain backend was reachable (else the delete could not be ATTEMPTED). */
  readonly keychain_backend_available: boolean;
  /** A plaintext (insecure-file) record was removed. */
  readonly insecure_removed: boolean;
}

/**
 * The auth-command I/O seam (T-213, decision A + B). The `login`/`logout` handlers stay pure
 * (no `process` access): every credential WRITE/DELETE + the API-URL guard + the OAuth-boundary
 * network I/O rides THIS injected seam, all bound to the EFFECTIVE profile via the same
 * `credDepsFor` overlay the refresh executor uses. The shell (`wire-auth.ts`) wires the real
 * seams; tests inject a fake `ctx.auth`.
 */
export interface AuthCommandSeam {
  /**
   * Run the API-URL exfiltration guard (memoized — at most one prompt per invocation) and return
   * the approved (apiUrl, profile). login/logout call this before their FIRST send; it shares the
   * memo with the typed client, so a single invocation never double-prompts.
   */
  ensureApiUrl(): Promise<ApprovedApiContext>;
  /** The effective profile store/clear/readStoredRecord bind to (== ensureApiUrl().profile). */
  effectiveProfile(): string;
  /** Persist a credential record for the effective profile (keychain, or the 0600 file). */
  store(record: CredentialRecord, opts: StoreOptions): Promise<CredentialSource>;
  /**
   * The STORED record for `profile` (keychain / insecure-file ONLY — bypasses AGKIT_TOKEN + the
   * credential-helper, B-7c), or null. Used for the re-login orphan-grant revoke + logout.
   */
  readStoredRecord(profile: string): Promise<CredentialRecord | null>;
  /** Ensure a listable (possibly empty) `profiles[profile]` config entry — never touches default_profile (B-4). */
  ensureProfileEntry(profile: string): void;
  /** Best-effort RFC 7009 revocation of `token` at `origin` (always-200; false on any failure). */
  revoke(origin: string, token: string): Promise<boolean>;
  /**
   * Clear a profile's stored credential (T-213 S8) — `keyring.delete` + insecure-file removal,
   * both best-effort-tolerant of absence. Names EXACTLY `profile` (never a cross-profile fallback).
   */
  clear(profile: string): Promise<ProfileClearResult>;
  /**
   * Enumerate every known profile (T-213 S8, B-15/B-24): config defaults ∪ insecure-file keys ∪
   * the effective profile. The keychain has no list API, so a keychain-only profile never named in
   * config/file is unreachable — a boundary the `logout` output states honestly.
   */
  listProfiles(): string[];
  /**
   * T-221: DROP the shell's per-invocation credential memo so the next resolution re-reads the
   * store. The shell resolves the credential ONCE per invocation, before dispatch — so when the
   * `init` orchestrator's AUTH phase runs an inline `login` MID-handler, the memo still holds the
   * pre-login "none" and the lazily-built wire client would bind THAT (wire-client binds at its
   * first request, which happens after the login) — every onboarding call would 401. This resets
   * it. REQUIRED (not optional): an absent-and-silently-skipped reset is exactly the fail-open
   * that bug is. A shell with no memo (an injected `resolveCredential`) wires a no-op.
   */
  invalidateCredential(): void;
  /** The login-flow I/O seams (fetch / timers / entropy / browser / server / stderr). */
  readonly loginIo: LoginIoSeams;
}

/**
 * Narrow `ctx.auth` to a present value, or throw a clear internal error (mirrors requireRuntime).
 * Injected by the shell for the `login`/`logout` commands (build-cli `commandNeedsAuth`).
 */
export function requireAuth(ctx: Ctx): AuthCommandSeam {
  if (!ctx.auth) {
    throw new Error("agkit: internal — this command requires the auth seam but it was not injected");
  }
  return ctx.auth;
}

/**
 * The service-plane I/O seam (T-222, S5) — the process/fs/child facts the service nouns
 * (`selftest`/`upgrade`/`dashboard`/`api`) need, all injected so the handlers stay pure and
 * deterministically testable. This LANDS with `selftest`'s members; the later steps EXTEND it in
 * place (never fork a second seam): `upgrade` adds `runChild`/`realpath`/`argv1`, `dashboard` adds
 * `fetch`/`openUrl`/`approvedApiUrl`, `api` adds `readInput`.
 */
export interface ServiceCommandSeam {
  /** selftest checks 7/8: skill-freshness + MCP-registration READS (`realInstallFs` in prod). */
  readonly installFs: InstallFs;
  /** selftest check 8: the OS platform (which client-config candidate paths to probe). */
  readonly platform: NodeJS.Platform;
  /** selftest check 3: a monotonic-ish ms clock for RTT measurement. */
  readonly now: () => number;
  /** selftest checks 2/6: a UUIDv4 source — unique probe markers + the isolated keychain probe. */
  readonly randomUUID: () => string;
  // ── T-222 step 7 (upgrade) — install-method detection + the mutating install child ───────────
  /** `process.argv[1]` — the invoked bin path; install-method detection reads its realpath. */
  readonly argv1: string | undefined;
  /** Resolve a path's symlinks (`fs.realpathSync`); null on ANY failure (missing / permission). */
  readonly realpath: (path: string) => string | null;
  /**
   * A8: a READ-ONLY, bounded child probe (`npm prefix -g`) — captures stdout, NEVER mutates. It is
   * PERMITTED on every install-method path; the never-mutate guarantee is ZERO `runChild` calls on
   * a non-npm-global verdict. Resolves (never rejects) — a spawn/timeout failure → `{ok:false}`.
   */
  readonly probeChild: (
    cmd: string,
    args: readonly string[],
    opts: { timeoutMs: number },
  ) => Promise<ProbeChildResult>;
  /**
   * A8/A9/B7: the MUTATING install child (`npm install -g`). It streams the child's stdout+stderr
   * through a bounded REDACTING line sink (`onLine`, never raw bytes), spawns with a SANITIZED
   * least-privilege env (no AgentKit/provider secrets — npm needs none), and on watchdog expiry
   * TERMINATES THE WHOLE PROCESS TREE before resolving. INVOKED ONLY on the npm-global verdict.
   */
  readonly runChild: (
    cmd: string,
    args: readonly string[],
    opts: RunChildOptions,
  ) => Promise<RunChildResult>;
  // ── T-222 step 8 (dashboard) — AS-metadata GET + the browser launcher + the guarded api URL ──────
  /** `dashboard`: the AS-metadata GET (derives the dashboard origin). The real `globalThis.fetch`. */
  readonly fetch: typeof globalThis.fetch;
  /**
   * `dashboard`: open a validated https URL in the user's browser (wraps `core/auth/open-url`'s
   * `openUrl` — validate + `shell:false` spawn, fire-and-forget). Called ONLY on the TTY path.
   */
  readonly openUrl: (url: string) => void;
  /**
   * `dashboard`: the guard-approved management base URL, injected per-dispatch AFTER the exfiltration
   * guard ran (S6) — the handler derives the dashboard origin from THIS confirmed URL, never a fresh
   * unconfirmed read. Absent for every other command (and until the guard has run).
   */
  readonly approvedApiUrl?: string;
  // ── T-222 step 10c (api) — the `--input` body reader ─────────────────────────────────────────────
  /**
   * `api --input`: read the raw request body from a file PATH or `"-"` (stdin). UTF-8, bounded to
   * MAX_REQUEST_BYTES while consuming — a missing/unreadable file or an oversized input throws a
   * static `usage_error` (the PATH may appear in the message; the CONTENT never does). Injected for
   * every service noun (only `api` calls it); a test stub returns fixed bytes so handlers stay pure.
   */
  readonly readInput: (source: string) => Promise<string>;
  // ── T-224 (setup) — the two `InstallDeps` facts this seam did not already carry ──────────────
  //
  // `setup` calls `installSkill` ITSELF (housekeeping is exempt for it, D2), so it needs the same
  // dep set housekeeping builds. `installFs`/`now` are already above; these two complete it.
  // OPTIONAL so every hand-built test service seam stays valid — `setup` narrows them fail-LOUD
  // (`requireSkillInstallFacts`), never silently skipping an install it then reports as done.
  /**
   * The shipped `skill/` source dir, anchored to the EMITTED bundle (never cwd — C1). Production
   * single-sources it from `core/housekeeping`'s `skillSourceDir()`, the same rule
   * `buildHousekeepingDeps` uses, so the two writers can never target different bytes.
   */
  readonly skillSourceDir?: string;
  /** `process.pid` — the staging/backup name uniqueness input `InstallDeps` requires. */
  readonly pid?: number;
}

/** The two `InstallDeps` facts `setup` narrows off the service seam (T-224). */
export interface SkillInstallFacts {
  readonly skillSourceDir: string;
  readonly pid: number;
}

/**
 * Narrow the T-224 install facts, or throw (the `requireService` posture). A `setup` run that
 * silently skipped its install because the shell wired no source dir would report a converged
 * machine it never provisioned — the one failure mode this command exists to make impossible.
 */
export function requireSkillInstallFacts(service: ServiceCommandSeam): SkillInstallFacts {
  if (typeof service.skillSourceDir !== "string" || typeof service.pid !== "number") {
    throw new Error(
      "agkit: internal — this command requires the skill install facts (skillSourceDir, pid) but they were not injected",
    );
  }
  return { skillSourceDir: service.skillSourceDir, pid: service.pid };
}

/** The outcome of a bounded READ-ONLY child probe (A8 `probeChild`). */
export interface ProbeChildResult {
  /** The child's exit code (null if killed by the watchdog / never exited cleanly). */
  readonly code: number | null;
  /** The captured stdout (bounded + trimmed); "" on any failure. */
  readonly stdout: string;
  /** True iff the child exited 0 and the watchdog never fired. */
  readonly ok: boolean;
}

/** Options for the MUTATING install child (A8 tree-kill + A9/B7 redacting sink / sanitized env). */
export interface RunChildOptions {
  /** Hard watchdog — on expiry the WHOLE process tree is terminated before resolving. */
  readonly timeoutMs: number;
  /** An already-REDACTED, line-oriented sink for the child's stdout+stderr → our stderr. */
  readonly onLine: (line: string) => void;
}

/** The outcome of the mutating install child. */
export interface RunChildResult {
  /** Exit code — 0 success · non-zero failure · null killed by the watchdog. */
  readonly code: number | null;
  /** True iff the watchdog fired and the tree was terminated (distinct from a plain non-zero exit). */
  readonly timedOut: boolean;
}

/** Narrow `ctx.service` to a present value, or throw a clear internal error (requireRuntime peer). */
export function requireService(ctx: Ctx): ServiceCommandSeam {
  if (!ctx.service) {
    throw new Error("agkit: internal — this command requires the service seam but it was not injected");
  }
  return ctx.service;
}
