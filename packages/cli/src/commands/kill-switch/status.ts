// `kill-switch status` handler (T-219; N-011 C11, killswitch:read, SR). The state read over
// `kill_switch.get` (verb `status` — the D-8 ticket verb: the operator asks "is traffic halted?",
// not "fetch a resource"; the op binding rides a SPEC_OP_OVERRIDES entry). DTO verbatim:
// `{object:"kill_switch", active, reason, activated_at, activated_by}`. A NEVER-ENGAGED project
// has no row — the server's uniform 404. The CLI does NOT fabricate `{active:false}` (FORBIDDEN
// 6): absence-of-row and switch-inactive are different facts, and synthesizing the latter from the
// former would be the CLI asserting state it never observed. The honest 404 + teachable hint (S-E).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { WireProblemError } from "../../core/errors";

export const killSwitchStatusArgs = z.object({}).strict();
export type KillSwitchStatusInput = z.infer<typeof killSwitchStatusArgs>;

/** Module constant (A2/R13a: plane-authored hints are STATIC — referential identity testable). */
export const KILL_SWITCH_STATUS_404_HINT =
  "no kill switch has ever been engaged for this project — nothing to show; `agkit kill-switch activate --reason <r>` engages it";

export const killSwitchStatus: CommandHandler<KillSwitchStatusInput> = async (ctx) => {
  const pid = requireProject(ctx);
  try {
    const resp = await ctx.client.request({ operationId: "kill_switch.get", params: { pid } });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = KILL_SWITCH_STATUS_404_HINT;
    }
    throw err;
  }
};
