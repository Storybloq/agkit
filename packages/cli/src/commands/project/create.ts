// `project create` args + plan-change builder (N-011 A202 → T-212 S7 plan-first retrofit,
// projects:write, danger M). The write is FUSED plan.create→plan.apply (D1: every mutation
// calls the plan endpoint first); the shared `planMutationHandler` applies the ceremony's
// pass — no direct POST to the projects collection exists here any more (FORBIDDEN row 1).
// The change is the server CHANGE_TABLE's `project:create` shape (executable,
// account-plane): a `create` on the `project` resource at the COLLECTION path, body per
// the frozen `project_create_request` $def. The concrete path comes from the typed
// client's route renderer (A-16) — never hand-assembled.
import { z } from "zod";
import type { Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const projectCreateArgs = z
  .object({
    name: z.string().min(1).max(120).describe("Human-readable project name."),
    // The per-spec typed-confirm channel every plan-kind spec carries (ratified (c)):
    // only meaningful when the SERVER plan comes back D/PR — on an M plan the ceremony
    // rejects it teachably (confirm_without_typed_danger), AFTER a best-effort discard.
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (only needed if the server plan is destructive/prod-rebinding)."),
  })
  .strict();
export type ProjectCreateInput = z.infer<typeof projectCreateArgs>;

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function projectCreateChanges(input: unknown, _ctx: Ctx): PlanChange[] {
  const { name } = projectCreateArgs.parse(input);
  return [
    {
      action: "create",
      resource: "project",
      path: renderRoutePath("project.create", {}),
      body: { name },
    },
  ];
}
