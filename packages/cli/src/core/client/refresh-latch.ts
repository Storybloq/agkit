// Single-flight, stale-aware refresh latch (T-211 step 3b — finding 15 + re-review R4 +
// codex confirmation round). Extracted from the client composition so the settlement-race
// invariant is unit-testable at microtask granularity: the wrapper the retry engine calls
// must guarantee that at every externally observable instant either the in-flight latch is
// set (a concurrent 401 handler JOINS it) or the bearer has already rotated (the stale
// fast-path returns it). A caller can never observe [latch:null, token:stale] and start a
// duplicate refresh for the same bearer.
//
// The retry engine passes the bearer that OBSERVED the 401 (`staleToken`); the latch
//   • fast-paths when the cell has already rotated past it (another request refreshed
//     first) — hand back the current token WITHOUT burning a second refresh;
//   • single-flights concurrent 401s under the SAME stale bearer into ONE refreshAuth()
//     call — never a refresh stampede against the auth server.

/**
 * The mutable bearer shared between the client (reads `current` at request start) and the
 * latch (rotates it after a successful refresh). A plain property cell — the client keeps
 * the one instance in its closure, so rotation persists across request() calls.
 */
export interface BearerCell {
  current: string;
}

/**
 * Build the `RetryDeps.refreshAuth` wrapper around a concrete refresh executor.
 * The executor contract: resolve the NEW bearer, or `null` for an EXPECTED failure
 * (no refresh token, server rejected the grant); a THROW is a programming error and
 * propagates to every joined caller — it is never downgraded to null.
 */
export function createSingleFlightRefresh(
  refreshAuth: (staleBearer?: string) => Promise<string | null>,
  cell: BearerCell,
): (staleToken: string) => Promise<string | null> {
  let inflight: Promise<string | null> | null = null;
  return async (staleToken) => {
    // Already rotated past the observed bearer → no refresh needed; resend under the current one.
    if (cell.current !== staleToken) return cell.current;
    if (inflight === null) {
      // Leader: start the ONE refresh. The token ROTATES inside the shared chain, BEFORE the
      // finalizer clears the latch (codex confirmation round: settlement race) — a `.finally`
      // that cleared the latch first would open a one-microtask window where a queued 401
      // handler sees [latch:null, token:stale] and starts a duplicate refresh.
      // The stale bearer is THREADED THROUGH to the executor (A40): its under-lock
      // sibling-rotation check compares the on-disk record against the token that actually
      // failed, catching rotations that landed before the executor's first read.
      const rotated = refreshAuth(staleToken).then((next) => {
        if (next !== null && cell.current === staleToken) cell.current = next;
        return next === null ? null : cell.current;
      });
      const flight: Promise<string | null> = rotated.finally(() => {
        if (inflight === flight) inflight = null;
      });
      inflight = flight;
      return await flight;
    }
    // Follower: a refresh for this same stale bearer is already in flight — await IT (exactly
    // one refreshAuth call for the whole herd; a REJECTION propagates to every joiner), then
    // resend iff the token actually rotated.
    await inflight;
    return cell.current !== staleToken ? cell.current : null;
  };
}
