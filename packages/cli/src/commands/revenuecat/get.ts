// `revenuecat get` handler (T-219; N-011 C12 "get (never the key)", revenuecat:read, SR). A plain
// read over `revenuecat.get` (project-singleton binding). The KEY CANNOT LEAK HERE by server
// construction: the core select list is only requiredEntitlementId/userIdClaim/cacheTtlSeconds
// (management-core/src/revenuecat.ts — the stored key is never read), so the DTO is
// `{enabled, required_entitlement_id, user_id_claim, cache_ttl_seconds}` — masked by OMISSION, and
// the CLI renders it verbatim. An absent binding is the honest 404 + teachable hint (S-E) — never a
// fabricated body (FORBIDDEN 6).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { WireProblemError } from "../../core/errors";

export const revenuecatGetArgs = z.object({}).strict();
export type RevenuecatGetInput = z.infer<typeof revenuecatGetArgs>;

/** Module constant (A2/R13a: plane-authored hints are STATIC — referential identity testable). */
export const REVENUECAT_GET_404_HINT =
  "no RevenueCat binding is configured for this project — create one with `agkit revenuecat set`";

export const revenuecatGet: CommandHandler<RevenuecatGetInput> = async (ctx) => {
  const pid = requireProject(ctx);
  try {
    const resp = await ctx.client.request({ operationId: "revenuecat.get", params: { pid } });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = REVENUECAT_GET_404_HINT;
    }
    throw err;
  }
};
