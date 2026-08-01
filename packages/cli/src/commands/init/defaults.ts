// T-221 — the recommended-defaults catalog: SELECT.
//
// T-226 D0-i hoisted the FETCH + NARROW half to `core/catalog/route-defaults.ts`, where `agkit init`
// and the `agkit route defaults` read surface both import it downward (one request site, one
// narrowing). What stays here is the half that is INIT'S POLICY and no one else's: splitting the
// catalog into create / already-bound / blocked-on-credential. The catalog TYPES and `narrowCatalog`
// are re-exported so init's own modules (engine, drift, its tests) keep one import path.
export { narrowCatalog, type Catalog, type CatalogRow } from "../../core/catalog/route-defaults";
import type { Catalog, CatalogRow } from "../../core/catalog/route-defaults";

export interface SelectionInput {
  readonly catalog: Catalog;
  /** Tiers the project ALREADY binds (from `model_route.list`). Absent-only is computed on these. */
  readonly boundTiers: ReadonlySet<string>;
  /** Providers whose credential exists NOW, plus the one this run is about to create. */
  readonly credentialedProviders: ReadonlySet<string>;
}

export interface Selection {
  /** Rows to create — absent tier AND a satisfied credential. */
  readonly create: readonly CatalogRow[];
  /** Rows whose tier is already bound (nothing to do). */
  readonly alreadyBound: readonly CatalogRow[];
  /** Rows skipped because their required provider has no credential (would be a DEAD route). */
  readonly blockedOnCredential: readonly CatalogRow[];
}

/**
 * Split the catalog three ways. BOTH filters matter and they are NOT the same filter (the review's
 * point): `boundTiers` prevents a duplicate binding on a re-run or a partly-configured project,
 * and `credentialedProviders` prevents a dead route. Filtering on `requires_credential` alone
 * would happily re-create a tier the project already binds.
 */
export function selectRoutes(input: SelectionInput): Selection {
  const create: CatalogRow[] = [];
  const alreadyBound: CatalogRow[] = [];
  const blockedOnCredential: CatalogRow[] = [];
  for (const row of input.catalog.rows) {
    if (input.boundTiers.has(row.tier)) {
      alreadyBound.push(row);
    } else if (!input.credentialedProviders.has(row.requiresCredential)) {
      blockedOnCredential.push(row);
    } else {
      create.push(row);
    }
  }
  return { create, alreadyBound, blockedOnCredential };
}

/** The distinct providers the catalog's UNBOUND rows need a credential for, in catalog order. */
export function providersNeeded(catalog: Catalog, boundTiers: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const row of catalog.rows) {
    if (!boundTiers.has(row.tier) && !out.includes(row.requiresCredential)) out.push(row.requiresCredential);
  }
  return out;
}
