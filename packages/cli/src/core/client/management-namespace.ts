// The management-namespace + OAuth-boundary derivation for the raw wire door (T-222 step 10b, B5/C4).
// The raw door (`agkit api <method> <path>`) forwards an OPERATOR-controlled path under the management
// bearer, so it MUST confine that path to the management namespace AND exclude the OAuth/token-minting
// subtree — reaching `…/oauth/token` with a management bearer is exactly the escalation the escape
// hatch must not enable. Both checks run on the fully PERCENT-DECODED path (C1): the server decodes
// `%6f`→`o`, so a literal-prefix check on the still-encoded URL would let `…/%6fauth/token` slip the
// boundary while the server routes it to the token endpoint. What we validate == what the server decodes.
//
// The namespace and the OAuth prefixes are DERIVED from the frozen route table (never hand-pinned), and
// the derivation is drift-LOCKED at module LOAD — but only over the drift classes a self-referential
// derivation CAN see, so state the guarantee precisely rather than as a blanket "any widening throws":
//   CAUGHT at load — a drifted closed `oauth.*` id set; a non-absolute or out-of-namespace non-oauth row;
//   an empty namespace LCP (rows sharing no root); an oauth row equal to the namespace; an oauth route
//   sharing a segment with reachable non-oauth routes (ANTI-OVERLAP, which is ALSO what catches a plain
//   widening — a namespace one segment shallower collapses the OAuth prefixes onto the segment the
//   reachable routes live under); and a namespace with NO oauth rows left beneath it (the NON-EMPTY gate,
//   i.e. the boundary silently evaporating).
//   NOT caught — one residual: a change that BOTH widens the namespace AND relocates every oauth row onto
//   its own dedicated segment under the widened root. That table is internally self-consistent, so no
//   invariant over the rows alone can relate the two moves; catching it would take a hand-pinned namespace
//   anchor, which this design deliberately rejects (see above). The residual is pinned as a KNOWN limit in
//   `management-namespace.test.ts` rather than left invisible.
// The TOTAL anchor for the REAL boundary is therefore not the load-time lock but the frozen-table pin test,
// which asserts the derived namespace + prefixes verbatim and fails CI on ANY regeneration that moves them.
// `deriveManagementBoundary` is a pure function so the drift-lock is exercised with mutated fixtures.
import {
  MANAGEMENT_ROUTE_TABLE,
  type RouteEntry,
} from "@agentkit-cloud/shared/wire-contract/management-routes-data";

/**
 * The 11 `oauth.*` operation-ids — the OAuth/RFC-6749 boundary the raw door must never cross (token,
 * device-authorization, revocation, the grants CRUD, and the AS/PRM discovery metadata, incl. the
 * root `.well-known` twins + the dashboard-origin `authorize` redirect). Declared as a closed literal
 * set; `deriveManagementBoundary` drift-asserts it EQUALS the table's actual `oauth.*` id set at load.
 */
export const OAUTH_BOUNDARY_OPERATION_IDS: ReadonlySet<string> = new Set([
  "oauth.device_authorization",
  "oauth.token",
  "oauth.revocation",
  "oauth.meta.as",
  "oauth.meta.prm",
  "oauth.authorize",
  "oauth.grant.list",
  "oauth.grant.get",
  "oauth.grant.revoke",
  "oauth.meta.as.root",
  "oauth.meta.prm.root",
]);

/** The derived, drift-locked boundary. */
export interface ManagementBoundary {
  /** The segment-wise longest-common-prefix of every NON-oauth route (e.g. `/v1/management`). */
  readonly namespace: string;
  /** The (namespace + next-segment) prefixes that cover every UNDER-namespace oauth route. */
  readonly oauthPrefixes: ReadonlySet<string>;
}

/** Path segments with empty parts dropped (`/v1/management/x` → ["v1","management","x"]). */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Segment-aware prefix containment: `p === prefix` OR `p` is `prefix/…` (never a substring match). */
function isUnderPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix + "/");
}

/** A module-load boot failure (a corrupted/drifted route table) — surfaced at import, like the table's own. */
function fail(message: string): never {
  throw new Error(`management-namespace: ${message}`);
}

/**
 * Derive the management namespace + OAuth-boundary prefixes from the route rows, drift-asserting the
 * declared `oauthIds` against ground truth. PURE (no module state) so the drift-lock test can force
 * each assert to fire on a mutated fixture. Throws on the drift classes listed in the module header: a
 * stale oauth id set, a non-absolute or out-of-namespace non-oauth row, an empty namespace, an oauth row
 * with no segment past the namespace, NO oauth row under the namespace at all, or a non-oauth route
 * falling under a derived OAuth prefix.
 */
export function deriveManagementBoundary(
  rows: readonly Pick<RouteEntry, "operation_id" | "path">[],
  oauthIds: ReadonlySet<string>,
): ManagementBoundary {
  // 1. Drift-assert the declared oauth id set EQUALS the table's actual `oauth.*` ids.
  const actualOauthIds = new Set(rows.map((r) => r.operation_id).filter((id) => id.startsWith("oauth.")));
  if (actualOauthIds.size !== oauthIds.size || [...actualOauthIds].some((id) => !oauthIds.has(id))) {
    fail("the declared OAUTH_BOUNDARY_OPERATION_IDS set has drifted from the route table's oauth.* ids");
  }

  // 2. Namespace = segment-wise LCP over the NON-oauth rows (all of which must be api-absolute).
  const nonOauth = rows.filter((r) => !oauthIds.has(r.operation_id));
  if (nonOauth.length === 0) fail("no non-oauth rows to derive a namespace from");
  let lcp: string[] | null = null;
  for (const r of nonOauth) {
    if (!r.path.startsWith("/")) fail(`a non-oauth route has a non-absolute path (${r.operation_id})`);
    const segs = segments(r.path);
    if (lcp === null) {
      lcp = [...segs];
    } else {
      let i = 0;
      while (i < lcp.length && i < segs.length && lcp[i] === segs[i]) i++;
      lcp = lcp.slice(0, i);
    }
  }
  if (lcp === null || lcp.length === 0) fail("the non-oauth namespace LCP is empty (routes share no common root)");
  const namespace = "/" + lcp.join("/");
  // Every non-oauth row must live UNDER the derived namespace (a stray sibling would widen it silently).
  for (const r of nonOauth) {
    if (!isUnderPrefix(r.path, namespace)) fail(`a non-oauth route escapes the derived namespace (${r.operation_id})`);
  }

  // 3. OAuth prefixes = (namespace + next segment) for each UNDER-namespace oauth row. The 3 oauth
  //    rows outside the namespace (dashboard-origin authorize + the two root `.well-known` twins) are
  //    unreachable through the raw door anyway (they fail the namespace check), so they need no prefix.
  const underNsOauth = nonAbsoluteFilteredUnderNs(rows, oauthIds, namespace);
  // NON-EMPTY invariant (the boundary-evaporation gate): at least one oauth row MUST live under the
  // derived namespace. If a table change leaves none there — e.g. a stray non-oauth sibling widens the
  // namespace past every oauth row, or the oauth subtree is relocated out of it — the prefix set derives
  // EMPTY, `isUnderOauthBoundary` answers false for every path, and the raw door's OAuth refusal silently
  // stops refusing: a management bearer would reach the token endpoint with no error raised anywhere.
  // This holds by construction for the real frozen table (the oauth routes live under the management
  // namespace), so the check only ever fires on genuine drift.
  if (underNsOauth.length === 0) {
    fail("no oauth route lives under the derived namespace — the OAuth boundary would be empty");
  }
  const oauthPrefixes = new Set<string>();
  for (const r of underNsOauth) {
    const segs = segments(r.path);
    const next = segs[lcp.length];
    if (next === undefined) fail(`an oauth route equals the namespace exactly (${r.operation_id})`);
    oauthPrefixes.add(namespace + "/" + next);
  }
  // Every under-namespace oauth path MUST be caught by some derived prefix. NOTE: this is a STRUCTURAL
  // invariant — the prefixes are derived FROM these same rows, so it cannot fail — kept only to document
  // intent. The genuinely load-bearing, NON-tautological path assertion is the ANTI-OVERLAP check below.
  for (const r of underNsOauth) {
    if (![...oauthPrefixes].some((p) => isUnderPrefix(r.path, p))) {
      fail(`an under-namespace oauth route is not covered by any derived prefix (${r.operation_id})`);
    }
  }

  // ANTI-OVERLAP (the independent drift gate): NO reachable non-oauth route may fall under a derived
  // OAuth prefix. Because each prefix is `namespace + <next segment>`, a future `oauth.*` route placed
  // under a segment SHARED with non-oauth routes (e.g. `/v1/management/projects/…`, where 98 routes
  // incl. the deliberately-reachable management_token.* live) would collapse the boundary onto that
  // shared segment and SILENTLY over-block the whole subtree — every project/token raw call refused.
  // This check turns that silent over-block into a LOUD load failure, so a table change either keeps
  // oauth on its own segment or trips the drift lock. Unlike the two structural loops above, it relates
  // INDEPENDENT sets (non-oauth rows vs oauth-derived prefixes), so it can actually fire.
  for (const r of nonOauth) {
    if (r.path.startsWith("/") && [...oauthPrefixes].some((p) => isUnderPrefix(r.path, p))) {
      fail(`a non-oauth route falls under a derived OAuth prefix (${r.operation_id}) — the boundary would over-block it`);
    }
  }
  return { namespace, oauthPrefixes };
}

/** The oauth rows that are api-absolute AND live under the namespace (the ones the raw door could reach). */
function nonAbsoluteFilteredUnderNs(
  rows: readonly Pick<RouteEntry, "operation_id" | "path">[],
  oauthIds: ReadonlySet<string>,
  namespace: string,
): Pick<RouteEntry, "operation_id" | "path">[] {
  return rows.filter(
    (r) => oauthIds.has(r.operation_id) && r.path.startsWith("/") && isUnderPrefix(r.path, namespace),
  );
}

// ── the frozen, drift-locked boundary (derived ONCE at module load) ──
const BOUNDARY: ManagementBoundary = deriveManagementBoundary(
  [...MANAGEMENT_ROUTE_TABLE.values()],
  OAUTH_BOUNDARY_OPERATION_IDS,
);

/** The management namespace (`/v1/management`) — derived, drift-locked. */
export const MANAGEMENT_NAMESPACE: string = BOUNDARY.namespace;

/** The OAuth-boundary prefixes (`/v1/management/oauth`, `/v1/management/.well-known`) — derived, drift-locked. */
export const OAUTH_PREFIXES: ReadonlySet<string> = BOUNDARY.oauthPrefixes;

/**
 * Is `decodedPath` within the management namespace? Operates on the fully PERCENT-DECODED path (C1)
 * so the check sees exactly what the server decodes. Segment-aware (never a bare substring).
 */
export function isWithinManagementNamespace(decodedPath: string): boolean {
  return isUnderPrefix(decodedPath, MANAGEMENT_NAMESPACE);
}

/**
 * Is `decodedPath` under the OAuth/token-minting boundary? Operates on the fully PERCENT-DECODED path
 * (C1). The raw door REFUSES any path for which this is true — those endpoints are reached only through
 * the typed `login`/`dashboard` derivation, never the bearer-carrying escape hatch.
 */
export function isUnderOauthBoundary(decodedPath: string): boolean {
  for (const prefix of OAUTH_PREFIXES) {
    if (isUnderPrefix(decodedPath, prefix)) return true;
  }
  return false;
}
