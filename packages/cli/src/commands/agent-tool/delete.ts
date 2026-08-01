// `agent-tool delete <tool> --agent <agent>` args + plan-change builder (T-218; D-1: agents:WRITE,
// danger PR — a within-profile edit, NON-cascading; NOT agents:destroy/PR+D — that clause belongs to
// `agent delete`). Three authoritative sources agree (frozen route row tool.delete = agents:write/PR;
// N-011 APX-A A415; N-011 RN-3 "sub-resource tool.delete stays agents:write"). Plan-kind BODYLESS
// delete (no `body` key) over the executable `tool:delete` CHANGE_TABLE entry. `tool.delete` is
// ABSENT from DELETE_CASCADES (no child rows cascade) — deleting a tool removes only that tool. The
// builder is ASYNC: it resolves the `--agent` slug-or-UUID to a profile id and the `<tool>`
// name-or-UUID to a tool id (D-7) BEFORE building the concrete path.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveAgentId, resolveToolId } from "../agent/resolve";

export const agentToolDeleteArgs = z
  .object({
    tool: z.string().min(1).describe("The tool name or id to delete."),
    agent: z.string().min(1).describe("The parent agent profile (slug or id)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type AgentToolDeleteInput = z.infer<typeof agentToolDeleteArgs>;

/** The PURE change builder (`PlanMutation.changes`, ASYNC). Resolves profile + tool ids, then emits
 *  the BODYLESS `tool:delete` change (no `body` key). */
export async function agentToolDeleteChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = agentToolDeleteArgs.parse(input);
  const pid = requireProject(ctx);
  const profileId = await resolveAgentId(ctx, parsed.agent);
  const toolId = await resolveToolId(ctx, profileId, parsed.tool);
  return [
    {
      action: "delete",
      resource: "tool",
      path: renderRoutePath("tool.delete", { pid, id: profileId, tool_id: toolId }),
    },
  ];
}
