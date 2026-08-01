// `agent-tool get <tool> --agent <agent>` handler (T-218; agents:read, SR). Reads ONE tool via
// `tool.get` (route `.../{id}/tools/{tool_id}`, both path params UUID-guarded server-side). The
// `--agent` flag names the parent profile (slug or id); the positional `<tool>` names the tool by
// `tool_name` or id. Client-side resolution (D-7): resolve the profile id from `--agent`, then the
// tool id from `<tool>` over ONE `tool.list` for that profile.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { resolveAgentId, resolveToolId } from "../agent/resolve";

export const agentToolGetArgs = z
  .object({
    tool: z.string().min(1).describe("The tool name or id."),
    agent: z.string().min(1).describe("The parent agent profile (slug or id)."),
  })
  .strict();
export type AgentToolGetInput = z.infer<typeof agentToolGetArgs>;

export const agentToolGet: CommandHandler<AgentToolGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const profileId = await resolveAgentId(ctx, input.agent);
  const toolId = await resolveToolId(ctx, profileId, input.tool);
  const resp = await ctx.client.request({ operationId: "tool.get", params: { pid, id: profileId, tool_id: toolId } });
  return { data: resp };
};
