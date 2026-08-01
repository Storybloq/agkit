// `kill-switch deactivate` args + plan-change builder — the DISENGAGE arm of the asymmetric
// `kill_switch.set` route (T-219 §1 D-5; wire: danger.disengage:"PR", gating.disengage:
// "plan_required"). RESUMING live traffic is a prod re-bind: the wire door 403s a direct disengage
// (`plan_required`), so this is the full fused PR plan ceremony — its typed confirm-string IS the
// typed confirm the ticket's acceptance demands, and PR fires the PROD-REBINDING banner (equal-or-
// more ceremony than the ticket's D — never less).
//
// FORBIDDEN 3 / R7: the change body is EXACTLY `{active:false}` — the frozen DISENGAGE oneOf arm
// (`additionalProperties:false`; a stray reason/confirm fails the schema, S-8 proves it), and the
// server's disengage executor SETs ONLY `isActive` — prior reason/activated_at/activated_by
// SURVIVE (kill-switches.ts F2: attribution preservation is server bytes; the CLI sends nothing
// that could clobber it). A never-engaged project (no row) is `plan.create`'s honest presence
// reject — an update on an absent row — never a fabricated create (r5-3).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const killSwitchDeactivateArgs = z
  .object({
    confirm: confirmArg,
  })
  .strict();
export type KillSwitchDeactivateInput = z.infer<typeof killSwitchDeactivateArgs>;

/** The PURE change builder (`PlanMutation.changes`). Emits the disengage change — body EXACTLY
 *  `{active:false}` — over the `kill_switch:update` CHANGE_TABLE entry (branch:"disengage"). */
export function killSwitchDeactivateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  killSwitchDeactivateArgs.parse(input);
  const pid = requireProject(ctx);
  return [
    {
      action: "update",
      resource: "kill_switch",
      path: renderRoutePath("kill_switch.set", { pid }),
      body: { active: false },
    },
  ];
}
