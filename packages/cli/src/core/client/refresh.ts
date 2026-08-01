// The concrete token-refresh EXECUTOR (T-211 step 6 — A1/A5/A14/A29/A31/A37/A40-A43). This
// IS the production `refreshAuth` the single-flight latch (refresh-latch.ts) wraps and the
// client (index.ts) wires as `deps.refreshAuth`. Its contract to that seam is fixed: resolve
// a NEW access token (string) on success; resolve `null` for an EXPECTED failure (no refresh
// path, or the server rejected the grant) so the caller goes TERMINAL; a THROW is an
// unexpected/programming error and propagates to every joined caller.
//
// One refresh, then ONE retry (A29/A37): a single RFC 6749 refresh-grant POST to the OAuth
// boundary `/v1/management/oauth/token`, form-encoded, and — ONLY on an AMBIGUOUS transport
// failure (the response was lost) — an IDENTICAL replay ONCE, bounded well inside the server's
// ~60s proof-of-possession grace window so the replay is served the winner's rotated pair
// rather than tripping family revocation. Max 2 oauth.token attempts, ever.
//
// This is an OAuth boundary, NOT the management JSON envelope: it does NOT route through the
// typed client, and it OMITS `X-AgentKit-Management-Version` (A14/A31 — an absent header ⇒
// "current major"; sending it would let a skew mask itself as a 6749 login failure, and this
// executor never evaluates skew). It validates the FULL token response shape BEFORE any write,
// persists the server's ROTATED refresh_token (never the presented one — A1), and coordinates
// with concurrent processes + crash recovery through refresh-lock.ts (A40-A43).
//
// Every clock / entropy / fs / network touch is an INJECTED seam (the core/client no-Date.now
// sweep). The production factory (`createRefreshExecutor`) supplies fs/nonce/liveness defaults;
// `now`/`sleep`/`fetch`/`readRecord`/`storeRecord`/`enforceGuard`/`stateDir` are wired by the
// step-7 shell (which may read the wall clock, documented).
import { join } from "node:path";
import { CLI_LOCAL_REGISTRY } from "../errors";
import type { CredentialRecord } from "../auth/record";
import type { ResolvedRecord } from "../auth/chain";
import type { CredentialSource } from "../auth/types";
// The OAuth-boundary form POST + token-response parse were EXTRACTED to the shared oauth-http
// helper (T-213 S1) so login (auth-code+PKCE / device-code) reuses the SAME watchdog + the A14/A31
// version-header-OMITTED rule. This executor now DELEGATES its one send to it. `TransportError` is
// the SAME class (oauth-http re-exports transport's) so the ambiguity-replay `instanceof` below
// keys off one identity.
import { postTokenEndpoint, parseTokenResponse, TransportError, type TokenResponse } from "../auth/oauth-http";
import {
  acquireRefreshLock,
  clearMarker,
  defaultIsProcessAlive,
  defaultNonce,
  deriveRefreshKey,
  LockUnavailableError,
  nodeLockFs,
  readMarker,
  refreshTokenDigest,
  releaseRefreshLock,
  verifyLockOwnership,
  writeMarker,
  type LockFs,
} from "./refresh-lock";

// The OAuth-boundary token PATH + the per-attempt watchdog now live in the shared oauth-http
// helper (T-213 S1). Re-exported here so the refresh module's public surface is unchanged.
export { OAUTH_TOKEN_PATH, ATTEMPT_TIMEOUT_MS } from "../auth/oauth-http";
/** Server proof-of-possession grace window for a rotated refresh token (~60s). */
export const GRACE_WINDOW_MS = 60_000;
/** Safety margin subtracted from the grace window for the marker deadline (clock skew + overhead). */
export const GRACE_MARGIN_MS = 10_000;

/** The guard-approved context the executor sends credentials under (A14). */
export interface ApprovedContext {
  readonly profile: string;
  readonly apiUrl: string;
}

/** Everything the executor needs, all injected (step 7 wires the production seams). */
export interface RefreshExecutorDeps {
  /** OAuth-boundary fetch (createTransport is NOT used — this is not the management envelope). */
  readonly fetch: typeof globalThis.fetch;
  /** Wall clock (ms). Required — no `Date.now()` in core/client; the shell wires `() => Date.now()`. */
  readonly now: () => number;
  /** Bounded sleep for lock polling (injected — no real waits in tests). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Read the full stored record + source (A1 sibling reader, pre-bound to the effective profile). */
  readonly readRecord: () => Promise<ResolvedRecord | null>;
  /** Atomically re-store the rotated record to the SAME source it came from (A1). */
  readonly storeRecord: (record: CredentialRecord, source: CredentialSource) => Promise<void>;
  /** Enforce the API-URL exfiltration guard BEFORE sending credentials; returns the approved context (A14). */
  readonly enforceGuard: () => Promise<ApprovedContext>;
  /** State dir holding the lock + marker files (stateDirPath(dirs) in production). */
  readonly stateDir: string;
  /** Side channel for the source-aware terminal hint (A14). Best-effort; MUST NOT throw. */
  readonly reportHint?: (hint: string | null) => void;
  /** Lock/marker fs port. Defaults to `nodeLockFs()`. */
  readonly lockFs?: LockFs;
  /** Lock nonce entropy. Defaults to a CSPRNG hex (`defaultNonce`). */
  readonly nonce?: () => string;
  /** Liveness probe for stale-lock reclamation. Defaults to a `process.kill(pid,0)` probe. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Per-attempt watchdog timers. Defaults to the globals. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** Source-aware terminal hints (A14). NO new error codes — the 401's code stands; only the hint varies. */
const HINT_LOGIN = CLI_LOCAL_REGISTRY.not_logged_in.hint; // "agkit login" — keychain / insecure_file
const HINT_ENV = "set a fresh AGKIT_TOKEN=<management token> — the current one has expired";
const HINT_HELPER = "re-run your credential helper (AGKIT_CREDENTIAL_HELPER) to obtain a fresh token";
const HINT_LOCK = "another agkit process is refreshing credentials — retry this command in a moment";

function hintForSource(source: CredentialSource): string {
  if (source === "env") return HINT_ENV;
  if (source === "helper") return HINT_HELPER;
  return HINT_LOGIN; // keychain / insecure_file / none
}

/** Does this source carry a usable refresh token? env/helper are bare bearers — no refresh path (A14). */
function hasRefreshPath(source: CredentialSource, record: CredentialRecord): boolean {
  if (source === "env" || source === "helper") return false;
  return typeof record.refresh_token === "string" && record.refresh_token.length > 0;
}

/** Result of the one-send-then-one-replay attempt loop. */
type AttemptOutcome =
  | { readonly kind: "rotated"; readonly response: TokenResponse }
  | { readonly kind: "rejected" } // a COMPLETE non-2xx response — the server refused the grant
  | { readonly kind: "uncertain" } // response lost on both attempts, or a malformed 200 — must re-auth
  | { readonly kind: "aborted"; readonly reason: GuardBlock }; // guard failed before the FIRST send — nothing presented

/**
 * Why the pre-send guard blocked. Ownership is checked FIRST: a lost lock means the marker path
 * may already belong to the survivor (never touch it); `deadline` means we PROVABLY still own
 * the lock and only the grace window lapsed before anything was sent.
 */
type GuardBlock = "lock-lost" | "deadline";

/**
 * Build the executor. The returned function is the production `refreshAuth` the single-flight
 * latch wraps. `staleBearer` is the access token that actually RECEIVED the 401 (threaded from
 * the retry engine through the latch — A40): the sibling-rotation check compares the on-disk
 * record against IT, so a rotation that landed even BEFORE this executor's first read is
 * detected and never burns a redundant refresh. Callers without one (direct invocation) omit
 * it and the entry-read comparison is the fallback.
 */
export function createRefreshExecutor(
  deps: RefreshExecutorDeps,
): (staleBearer?: string) => Promise<string | null> {
  const fs = deps.lockFs ?? nodeLockFs();
  const nonce = deps.nonce ?? defaultNonce;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const report = (hint: string | null): void => {
    try {
      deps.reportHint?.(hint);
    } catch {
      /* best-effort side channel — never fail a refresh over a hint sink */
    }
  };

  return async (staleBearer?: string): Promise<string | null> => {
    // 1. Guard the destination BEFORE reading/sending any credential (A14). Idempotent — the
    //    client already confirmed on its first send; this call is a silent proceed.
    const { profile, apiUrl } = await deps.enforceGuard();
    const origin = new URL(apiUrl).origin;

    // 2. Read the full record + source.
    const resolved = await deps.readRecord();
    if (resolved === null) {
      report(HINT_LOGIN); // no credential resolved at all
      return null;
    }
    const { source, record: entry } = resolved;

    // 3. Source-aware refreshability (A14): env/helper bearers and a record with no refresh
    //    token have NO refresh path — skip refresh entirely, terminal with the right hint.
    if (!hasRefreshPath(source, entry)) {
      report(hintForSource(source));
      return null;
    }

    // 4. Derive the stable, non-secret lock/marker key (A43) and acquire the cross-process lock.
    const key = deriveRefreshKey({ origin, profile, source, grantId: entry.grant_id });
    const lockPath = join(deps.stateDir, `refresh-${key}.lock`);
    const markerPath = join(deps.stateDir, `refresh-${key}.marker`);

    let handle;
    try {
      handle = await acquireRefreshLock({ fs, now: deps.now, sleep: deps.sleep, nonce, isProcessAlive }, lockPath, process.pid);
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        report(HINT_LOCK); // a live sibling holds it past the bounded wait — clean terminal
        return null;
      }
      throw err;
    }

    try {
      // 5. RE-READ under the lock (A40 + A42): the on-disk record is the source of truth now
      //    that we're serialized; a sibling may have rotated it while we waited for the lock.
      const afterLock = await deps.readRecord();
      if (afterLock === null) {
        report(hintForSource(source));
        return null;
      }
      const current = afterLock.record;

      // 5-pre. Identity shifted under the lock (the credential was reconfigured to a different
      //   source mid-command): the lock/marker key we derived no longer scopes this record. Do NOT
      //   refresh under a mismatched identity — hand back the current access token and let the
      //   client resend (a fresh 401 then goes terminal).
      if (afterLock.source !== source) {
        report(null);
        return current.access_token;
      }

      // 5a. Crash-recovery marker (A42). A marker means a prior attempt was interrupted between
      //     "marker written" and "marker cleared". CORRUPT is fail-CLOSED (codex fix round): an
      //     unreadable marker may be hiding a pending rotation, so it is treated exactly like a
      //     MATCH — terminal re-auth, marker left, nothing sent. Only ABSENT starts a refresh.
      const markerRead = readMarker(fs, markerPath);
      if (markerRead.kind === "corrupt") {
        report(hintForSource(source));
        return null;
      }
      if (markerRead.kind === "valid") {
        const currentDigest = refreshTokenDigest(current.refresh_token ?? "");
        if (currentDigest !== markerRead.marker.presented) {
          // DIFFER ⇒ the rotated pair already landed (crash AFTER store, before clear) ⇒ recover.
          clearMarker(fs, markerPath);
          report(null);
          return current.access_token;
        }
        // MATCH ⇒ genuinely uncertain (crash before/during send, response lost, or deadline
        //   lapsed): the presented token may already be rotated server-side — NEVER re-present
        //   it. Terminal re-auth; leave the marker so a restart re-reaches this same verdict.
        report(hintForSource(source));
        return null;
      }

      // 5b. A sibling process rotated PAST the bearer that actually failed (A40): SKIP the
      //     refresh, resend under the fresh token. The comparison baseline is `staleBearer` —
      //     the token that received the 401 (threaded from the retry engine) — so a rotation
      //     that landed even before OUR first read is detected; the entry read is only the
      //     fallback for direct callers. We ALSO compare the mandatorily-rotated refresh_token
      //     digest so a rotation is detected even in the (not-our-server) case where the
      //     access token repeats.
      const failedBearer = staleBearer ?? entry.access_token;
      const rotatedBySibling =
        current.access_token !== failedBearer ||
        refreshTokenDigest(current.refresh_token ?? "") !== refreshTokenDigest(entry.refresh_token ?? "");
      if (rotatedBySibling) {
        report(null);
        return current.access_token;
      }

      const presented = current.refresh_token;
      if (typeof presented !== "string" || presented.length === 0) {
        report(hintForSource(source)); // defensive: re-read lost the refresh token
        return null;
      }

      // 6. Persist the pending marker BEFORE the first send (A41): presented-token identity
      //    (digest, never the token) + the absolute grace deadline.
      const markerDeadline = deps.now() + GRACE_WINDOW_MS - GRACE_MARGIN_MS;
      writeMarker(fs, markerPath, {
        presented: refreshTokenDigest(presented),
        deadline: markerDeadline,
      });

      // 6b. PER-ATTEMPT pre-send guard (codex confirmation round): EVERY presentation of the
      //     refresh token — the first send AND the replay — first re-verifies (i) we are still
      //     the on-disk lock owner (a reclamation race may have dispossessed us) and (ii) the
      //     grace DEADLINE has not lapsed (JS timers give no hard bound across a system sleep;
      //     a replay after the PoP window re-presents a rotated token → family revocation).
      //     Ownership is checked FIRST so `deadline` certifies the marker is still OURS.
      const guardCheck = (): GuardBlock | null => {
        if (!verifyLockOwnership(fs, handle)) return "lock-lost";
        if (deps.now() > markerDeadline) return "deadline";
        return null;
      };

      // 7. One refresh, then one replay on an ambiguous transport failure (A29/A37).
      const outcome = await refreshWithReplay(deps, origin, presented, guardCheck);

      if (outcome.kind === "aborted") {
        // Guard failed before the FIRST send — nothing was ever presented.
        if (outcome.reason === "lock-lost") {
          // Marker LEFT: the path may now belong to the surviving holder (it writes/clears the
          // SAME path with the IDENTICAL digest); if nobody completes, marker-MATCH forces a
          // safe terminal re-auth next run. Clean terminal with the retry hint.
          report(HINT_LOCK);
          return null;
        }
        // Deadline lapsed with ownership INTACT (suspension between marker write and first
        // send): the marker is provably ours and records a presentation that never happened —
        // clear it (leaving it would force a needless re-auth next run) and report the
        // source-aware hint, not a lock hint no sibling caused.
        clearMarker(fs, markerPath);
        report(hintForSource(source));
        return null;
      }

      if (outcome.kind === "rotated") {
        // A1: persist the RESPONSE's rotated refresh_token + scope + expiry, preserving only the
        //     grant identity (issuer/client_id/grant_id, and the resource binding) from the old
        //     record. The stored refresh_token is the NEW one, NEVER the presented one. A store
        //     failure (broken keyring / fs) is an UNEXPECTED error — it PROPAGATES (the seam
        //     contract's THROW case), never a masked success: the marker is NOT cleared (it stays
        //     for a safe re-auth next run) and no partially-rotated state is reported as success.
        const rotated = buildRotatedRecord(current, outcome.response, deps.now());
        await deps.storeRecord(rotated, source);
        clearMarker(fs, markerPath); // cleared ONLY after the rotated pair is durably stored (A41)
        report(null);
        return rotated.access_token;
      }

      if (outcome.kind === "rejected") {
        // A COMPLETE non-2xx response ⇒ the server refused the grant; nothing rotated ⇒ safe to
        //   clear the marker. Terminal re-auth with the source-aware hint.
        clearMarker(fs, markerPath);
        report(hintForSource(source));
        return null;
      }

      // uncertain ⇒ both attempts' responses were lost (or a malformed 200): the presented token
      //   MAY be rotated server-side. LEAVE the marker (A41) so the next run re-auths safely.
      report(hintForSource(source));
      return null;
    } finally {
      releaseRefreshLock(fs, handle, deps.now, process.pid);
    }
  };
}

/**
 * One send, then — only on an AMBIGUOUS transport failure (network/timeout: the response was
 * lost) — one IDENTICAL replay, bounded to 2 attempts total (A29/A37). A COMPLETE HTTP response
 * (2xx or non-2xx) is DEFINITIVE; only a typed `TransportError` (network/abort) triggers the
 * replay — ANY OTHER throw (a programming bug) propagates unchanged (the executor's THROW case).
 *
 * Ambiguity is STICKY: a non-2xx on the REPLAY (attempt 2, which only runs after an ambiguous
 * attempt 1) is `uncertain`, NOT `rejected` — attempt 1 may have rotated before its response was
 * lost, so a later refusal does not prove no rotation. Only a non-2xx on the FIRST, unambiguous
 * attempt is a definitive `rejected`. A malformed 2xx body is `uncertain` (the server rotated but
 * we cannot use it → re-auth).
 *
 * `guardCheck` runs immediately before EVERY send (codex confirmation round): lock ownership +
 * grace-deadline check, returning WHY it blocked (or null to proceed). Failing before attempt 1
 * = `aborted` carrying the reason (nothing was ever presented — the caller disposes of the
 * marker by reason); failing before the replay = `uncertain` (attempt 1 may have rotated —
 * marker ALWAYS left) — either way NOTHING further is sent.
 */
async function refreshWithReplay(
  deps: RefreshExecutorDeps,
  origin: string,
  refreshToken: string,
  guardCheck: () => GuardBlock | null,
): Promise<AttemptOutcome> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const blocked = guardCheck();
    if (blocked !== null) return attempt === 1 ? { kind: "aborted", reason: blocked } : { kind: "uncertain" };
    let res: { status: number; bodyText: string };
    try {
      res = await sendTokenRequest(deps, origin, refreshToken);
    } catch (err) {
      if (!(err instanceof TransportError)) throw err; // a real bug, not lost-in-transit — propagate
      // Ambiguous: the response was lost. Replay ONCE (attempt 1 → 2); if attempt 2 also lost,
      //   we can no longer tell whether attempt 1 rotated → uncertain.
      if (attempt === 1) continue;
      return { kind: "uncertain" };
    }
    if (res.status >= 200 && res.status < 300) {
      const parsed = parseTokenResponse(res.bodyText);
      if (parsed === null) return { kind: "uncertain" }; // 200 but unusable — the server rotated → re-auth
      return { kind: "rotated", response: parsed };
    }
    // A COMPLETE non-2xx (RFC 6749 error): definitive refusal ONLY on the first, unambiguous
    // attempt. On the replay (post-ambiguity) it is uncertain — attempt 1 may have rotated.
    return attempt === 1 ? { kind: "rejected" } : { kind: "uncertain" };
  }
  /* istanbul ignore next — the loop always returns within 2 attempts */
  return { kind: "uncertain" };
}

/**
 * One form-encoded RFC 6749 refresh-grant POST. DELEGATES to the shared oauth-http helper
 * (T-213 S1) — the per-attempt watchdog, the A14/A31 version-header omission, and the typed
 * `TransportError` (the AMBIGUOUS "response lost" case) all live there now. `deps` structurally
 * satisfies `OauthHttpDeps` (fetch + optional timers); the grant params are the only thing this
 * refresh-specific wrapper contributes.
 */
async function sendTokenRequest(
  deps: RefreshExecutorDeps,
  origin: string,
  refreshToken: string,
): Promise<{ status: number; bodyText: string }> {
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  return postTokenEndpoint(deps, origin, params);
}

/**
 * Build the rotated record (A1). access_token/refresh_token/scope/expiry come from the RESPONSE;
 * issuer/client_id/grant_id/binding (the stable grant identity, not returned by the token
 * endpoint) are preserved from the old record. The stored refresh_token is the RESPONSE's rotated
 * value — NEVER the presented one.
 */
function buildRotatedRecord(old: CredentialRecord, resp: TokenResponse, now: number): CredentialRecord {
  const expiresAtMs = resp.expires_in !== undefined ? now + resp.expires_in * 1000 : null;
  const accessExpiresAt = expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null;
  const scopes = resp.scope !== undefined ? resp.scope.split(" ").filter((s) => s.length > 0) : old.scopes;
  return {
    issuer: old.issuer,
    client_id: old.client_id,
    access_token: resp.access_token,
    access_expires_at: accessExpiresAt,
    refresh_token: resp.refresh_token,
    grant_id: old.grant_id,
    scopes,
    binding: old.binding,
    schema: 1,
  };
}
