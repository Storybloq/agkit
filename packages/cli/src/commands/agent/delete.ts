// `agent delete <agent>` args + plan-change builder (T-218; agents:DESTROY, wire danger "PR+D" →
// CLI "PR" (the CLI Danger union has no compound member; D and PR share the decision matrix, PR
// additionally fires the PROD-REBINDING banner)). Plan-kind BODYLESS delete (a bodyless change
// carries NO `body` key at all) over the executable `agent_profile:delete` CHANGE_TABLE entry.
// Deleting a profile CASCADES to its tools + knowledge bindings (DELETE_CASCADES[agent_profile] =
// ["agent_profile_tools","knowledge_bindings"], plan-compute.ts) — the server stamps that advisory
// onto the delete diff entry, which the plan renderer surfaces (§3.5) so the operator sees the
// cascade BEFORE the typed confirm-string ceremony. The change builder is ASYNC: it resolves the
// slug-or-UUID to an id (ONE profile.list) BEFORE building the concrete path (D-7).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveAgentId } from "./resolve";

export const agentDeleteArgs = z
  .object({
    agent: z.string().min(1).describe("Agent profile slug or id to delete."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type AgentDeleteInput = z.infer<typeof agentDeleteArgs>;

/** The PURE change builder (`PlanMutation.changes`, ASYNC). Resolves the slug-or-UUID to an id, then
 *  emits the BODYLESS delete change (no `body` key). */
export async function agentDeleteChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = agentDeleteArgs.parse(input);
  const pid = requireProject(ctx);
  const id = await resolveAgentId(ctx, parsed.agent);
  return [
    {
      action: "delete",
      resource: "agent_profile",
      path: renderRoutePath("profile.delete", { pid, id }),
    },
  ];
}
