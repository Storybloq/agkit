// `billing plans` handler (T-215, billing.plans, billing:read, SR). A pure passthrough read: send
// `billing.plans` with empty params and return the server DTO unchanged.
//
// Deliverable 2 / FORBIDDEN-4 honored BY CONSTRUCTION: `billing plans` reports DB truth at v1 —
// the CLI ships NO plan catalog, NO plan names, NO prices, and NO CRUD. The available-plans set is
// server/DB-owned (RATIFICATION OQ-3 catalog-drift is an accepted open question — no marketing
// catalog). The CLI is a byte-faithful window onto that truth, never a second source. Account-plane
// — NO requireProject.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const billingPlansArgs = z.object({}).strict();
export type BillingPlansInput = z.infer<typeof billingPlansArgs>;

export const billingPlans: CommandHandler<BillingPlansInput> = async (ctx) => {
  const data = await ctx.client.request({ operationId: "billing.plans", params: {} });
  return { data };
};
