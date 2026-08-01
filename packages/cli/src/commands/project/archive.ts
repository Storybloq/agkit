// `project archive` args + plan-change builder (N-011 A205 → T-212 S7 plan-first retrofit,
// projects:destroy, danger D). The wire route is `plan_required` — plan→apply is the ONLY
// legal write path (the old direct handler was a latent live bug: its POST 403s). The
// change is the server CHANGE_TABLE's `project:delete` shape: a `delete` on the `project`
// resource at the /archive sub-path, BODYLESS (GAP 12: a bodyless change must carry NO
// body). The concrete path comes from the typed client's route renderer (A-16).
//
// `--confirm` semantics CHANGED with the retrofit: the value is now the PLAN's
// `confirm_string` (the displayed authority, L-010) — the old `--confirm <project-name>`
// value fails the validate_confirm gate with a teachable re-plan hint.
import { z } from "zod";
import type { Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const projectArchiveArgs = z
  .object({
    id: z.string().min(1).describe("Project id to archive."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type ProjectArchiveInput = z.infer<typeof projectArchiveArgs>;

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function projectArchiveChanges(input: unknown, _ctx: Ctx): PlanChange[] {
  const { id } = projectArchiveArgs.parse(input);
  // project:delete → project.archive is BODYLESS — no `body` key at all (GAP 12).
  return [
    {
      action: "delete",
      resource: "project",
      path: renderRoutePath("project.archive", { pid: id }),
    },
  ];
}
