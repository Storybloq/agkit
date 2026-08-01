// The `model_route.defaults` catalog: ONE fetch, ONE defensive narrowing (T-221, hoisted here by
// T-226 D0-i).
//
// WHY THIS LIVES IN `core/`. Two commands now consume this catalog — `agkit init` (the onboarding
// orchestrator) and `agkit route defaults` (the read surface D0-i realizes). A shared core under
// either noun's directory would make one command import the other's internals (`route/` reaching
// into `init/` is a dependency inversion: the orchestrator is the higher layer). So the wire read
// and its narrowing sit in `core/`, where both commands import DOWNWARD — exactly the shape
// `core/plan/types.ts` already has for the plan responses the ceremony and the plan commands share.
// The SELECTION policy (absent-tier + credentialed-provider filtering) is init's alone and stays in
// `commands/init/defaults.ts`.
//
// `model_route.defaults` is an SR read whose response is the frozen `model_route_defaults_response`
// (`{object, catalog_version, defaults[]}` — NOT a list envelope, so `readCompleteList` does not
// apply). Each row is `{route, requires_credential, note?}` where `route` is the EXACT
// `model_route_create_request` body.
//
// FAIL CLOSED, both directions:
//   • a malformed catalog (wrong `object`, non-array `defaults`, a row without an object `route`
//     or a non-empty-string `requires_credential`, a `route` missing any REQUIRED member of the
//     frozen create-request $def or carrying a wrong type, a non-string note) is TERMINAL —
//     never a partial selection. A
//     silently-dropped row would make init report "routes created" while quietly binding fewer
//     tiers than the catalog recommends, and a silently-accepted junk row would send junk to
//     `plan.create`.
//   • a row whose required provider has NO credential is SKIPPED, never created (init's selector) —
//     the catalog's own $comment says the client "marks the offer when absent, never auto-creates a
//     dead route".
//
// This module reads `route.tier` as a VALUE (to answer "does the project already bind this tier?").
// Reading a server-supplied value is not naming a realization — the CLI still contains no tier,
// provider, model or execution-target literal (§B-1 / A3).
import type { Ctx } from "../../commands/types";
import { CliLocalError } from "../errors";

/** The catalog's `object` discriminator, per the frozen `model_route_defaults_response`. */
const CATALOG_OBJECT = "model_route_defaults";

/** One narrowed catalog row. `route` is kept as the ORIGINAL object — never rebuilt. */
export interface CatalogRow {
  /** The verbatim `model_route_create_request` body. Piped into a plan change untouched. */
  readonly route: Readonly<Record<string, unknown>>;
  /** The tier this row binds, read out of `route` purely to answer "already bound?". */
  readonly tier: string;
  /** The provider slug whose credential this row needs (catalog metadata, outside `route`). */
  readonly requiresCredential: string;
  /** The optional human note, or null. */
  readonly note: string | null;
}

export interface Catalog {
  readonly catalogVersion: string;
  readonly rows: readonly CatalogRow[];
}

const MALFORMED_DETAIL =
  "the management API returned a malformed model-route defaults catalog — this is a server protocol error, not a request you can fix";

function malformed(): never {
  throw new CliLocalError("usage_error", { detail: MALFORMED_DETAIL });
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Enforce the frozen `model_route_create_request` REQUIRED set + types on a catalog row's `route`
 * (codex k11): tier/model/provider/execution_target/attestation non-empty strings,
 * fallback_execution_target PRESENT as string-or-null, enabled/default booleans. Unknown EXTRA
 * members are tolerated and survive the verbatim pipe — the client validates what its pinned $def
 * REQUIRES, and the server (the catalog's own author) stays the authority on anything beyond it
 * (the drift.ts requireRow discipline). Without this, a junk route would ride until `plan.create`
 * — AFTER the project + shown-once mint have committed — and surface as the server rejecting the
 * client's request, pointing the differential probe at the wrong side of the wire.
 */
function requireRouteShape(route: Record<string, unknown>): void {
  if (nonEmptyString(route["tier"]) === null) malformed();
  if (nonEmptyString(route["model"]) === null) malformed();
  if (nonEmptyString(route["provider"]) === null) malformed();
  if (nonEmptyString(route["execution_target"]) === null) malformed();
  const fallback = route["fallback_execution_target"];
  if (fallback !== null && nonEmptyString(fallback) === null) malformed(); // required: string|null (absent ⇒ undefined ⇒ refused)
  if (nonEmptyString(route["attestation"]) === null) malformed();
  if (typeof route["enabled"] !== "boolean") malformed();
  if (typeof route["default"] !== "boolean") malformed();
}

/**
 * Narrow a `model_route.defaults` response into a catalog. Every gate below is a REQUIRED member
 * of the frozen $def, so a failure means the server broke its own contract — terminal, never
 * degraded.
 */
export function narrowCatalog(raw: unknown): Catalog {
  const body = asObject(raw);
  if (body === null || body["object"] !== CATALOG_OBJECT) malformed();
  const catalogVersion = nonEmptyString(body["catalog_version"]);
  const defaults = body["defaults"];
  if (catalogVersion === null || !Array.isArray(defaults)) malformed();
  const rows: CatalogRow[] = [];
  for (const entry of defaults) {
    const row = asObject(entry);
    if (row === null) malformed();
    const route = asObject(row["route"]);
    const requiresCredential = nonEmptyString(row["requires_credential"]);
    if (route === null || requiresCredential === null) malformed();
    requireRouteShape(route);
    const tier = route["tier"] as string;
    // `note` is OPTIONAL, but a PRESENT note must honor its $def: a string of ≤500 chars. A
    // non-string (or overlong) note is a protocol breach, never silently normalized (codex k11).
    const note = row["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) malformed();
    rows.push({
      route,
      tier,
      requiresCredential,
      note: typeof note === "string" && note.length > 0 ? note : null,
    });
  }
  return { catalogVersion, rows };
}

/**
 * THE `model_route.defaults` read: one SR call for `pid`, narrowed. No mutation, no retry policy of
 * its own. Every consumer (init's engine, init's re-run short-circuit, `route defaults`) goes
 * through HERE — there is no second request site and no second narrowing (D0-i).
 */
export async function fetchRouteDefaults(ctx: Ctx, pid: string): Promise<Catalog> {
  return narrowCatalog(await ctx.client.request({ operationId: "model_route.defaults", params: { pid } }));
}
