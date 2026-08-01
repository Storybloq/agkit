// `project rename <id> --name <new>` args + plan-change builder (T-216 R2; projects:write,
// danger M). Plan-kind over the EXECUTABLE `project:update` CHANGE_TABLE entry — RATIFIED (D2):
// the wire route (project.update, RT gating `direct`) has TWO legal doors server-side; the CLI
// deliberately takes the PLAN door (strictly MORE ceremonied, sidesteps client-side If-Match
// juggling; T-215's `mutation.kind:"direct"` exists for M-only DIRECT execution — checkout-class,
// no plan artifact). The full key→operationId→executable→defName binding is PINNED cross-layer by
// plan-door.crosslayer.test.ts (R18) through the server's own exported `resolveChange()`.
// The body carries ONLY `name` (a partial patch against the all-optional `project_update_request`).
import { z } from "zod";
import type { Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const projectRenameArgs = z
  .object({
    id: z.string().min(1).describe("Project id to rename."),
    // Bounds mirror the frozen `project_update_request.name` (1..200).
    name: z.string().min(1).max(200).describe("The new project name."),
    // The per-spec typed-confirm channel every plan-kind spec carries (ratified (c)): only
    // meaningful when the SERVER plan comes back D/PR — on an M plan the ceremony rejects it
    // teachably (confirm_without_typed_danger), AFTER a best-effort discard.
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (only needed if the server plan is destructive/prod-rebinding)."),
  })
  .strict();
export type ProjectRenameInput = z.infer<typeof projectRenameArgs>;

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function projectRenameChanges(input: unknown, _ctx: Ctx): PlanChange[] {
  const { id, name } = projectRenameArgs.parse(input);
  return [
    {
      action: "update",
      resource: "project",
      path: renderRoutePath("project.update", { pid: id }),
      body: { name },
    },
  ];
}
