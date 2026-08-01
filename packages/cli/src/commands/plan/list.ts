// `plan list` handler (T-212 S6, plans:read). Mirrors `project list` (T-211 step 4
// pagination semantics): `--paginate` drains every page through the client seam; without
// it one page is fetched and a truncated page exits 3 via `meta.next_cursor`.
//
// The `--limit` ceiling comes from the ROUTE's frozen pagination metadata (plan.list is
// the one 20/100 route) — NEVER a hardcoded literal. The module fail-louds at import if
// the metadata went missing (a manifest regression, not a runtime condition).
import { z } from "zod";
import { routeFor } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import type { CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

const PLAN_LIST_ROUTE = routeFor("plan.list");
if (PLAN_LIST_ROUTE?.pagination === undefined) {
  throw new Error("agkit: internal — the plan.list route metadata is missing its pagination bounds");
}
/** The frozen max_limit (100) — exported so tests compare against the metadata, not a literal. */
export const PLAN_LIST_MAX_LIMIT = PLAN_LIST_ROUTE.pagination.max_limit;

export const planListArgs = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(PLAN_LIST_MAX_LIMIT)
      .optional()
      .describe("Max rows to return."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type PlanListInput = z.infer<typeof planListArgs>;

export const planList: CommandHandler<PlanListInput> = async (ctx, input) => {
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "plan.list", { ...input });
  }
  const page = await ctx.client.request({ operationId: "plan.list", params: input });
  return singlePageResult(page);
};
