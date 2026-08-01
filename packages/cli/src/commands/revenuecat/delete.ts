// `revenuecat delete` args + plan-change builder (T-219; revenuecat:DESTROY, danger PR, wire
// `revenuecat.disable` = plan_required). D-3 LABEL BY REALITY (§B-9): the wire op-id says
// "disable" but the bytes HARD-DELETE the row (`tx.delete(revenuecatBindings)`,
// management-core/src/revenuecat.ts) — the dashboard's "disable" label is a mislabel. The CLI verb
// is `delete` (ticket-mandated; a `disable` verb is FORBIDDEN 1); the op-id appears ONLY in this
// operation binding, never in operator vocabulary. Deleting the binding stops end-user entitlement
// gating — hence the typed confirm via the fused PR plan ceremony. Plan-kind BODYLESS delete (no
// `body` key) over the executable `revenuecat:delete` CHANGE_TABLE entry (BODYLESS defName,
// plan-dispatch.ts). The builder is SYNC and makes zero wire calls (a singleton needs no resolve).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const revenuecatDeleteArgs = z
  .object({
    confirm: confirmArg,
  })
  .strict();
export type RevenuecatDeleteInput = z.infer<typeof revenuecatDeleteArgs>;

/** The PURE change builder (`PlanMutation.changes`). Emits the BODYLESS delete change (no `body` key). */
export function revenuecatDeleteChanges(input: unknown, ctx: Ctx): PlanChange[] {
  revenuecatDeleteArgs.parse(input);
  const pid = requireProject(ctx);
  return [
    {
      action: "delete",
      resource: "revenuecat",
      path: renderRoutePath("revenuecat.disable", { pid }),
    },
  ];
}
