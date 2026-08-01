// `route delete <id>` args + plan-change builder (T-217 step 7; model_route.delete,
// routes:destroy, wire danger PR+D → spec PR (D4 dominant class), gating plan_required — the
// delete goes through plan→apply like every other route mutation; the change is BODYLESS (the
// server CHANGE_TABLE's `model_route:delete` row carries no request $def).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const routeDeleteArgs = z
  .object({
    id: z.string().min(1).describe("Model-route id to delete."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type RouteDeleteInput = z.infer<typeof routeDeleteArgs>;

/** The PURE change builder: a BODYLESS delete change at the CONCRETE model_route.delete path. */
export function routeDeleteChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = routeDeleteArgs.parse(input);
  return [
    {
      action: "delete",
      resource: "model_route",
      path: renderRoutePath("model_route.delete", { pid: requireProject(ctx), id: parsed.id }),
      // NO body key — the delete change is bodyless by contract.
    },
  ];
}
