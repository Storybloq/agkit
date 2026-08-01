// `agent get <agent>` handler (T-218; N-011 agents family, agents:read, SR). A plain read over
// `profile.get`, whose {id} path param is UUID-guarded server-side (a non-UUID is a uniform 404).
// The positional `<agent>` accepts a full UUID OR a human slug: `resolveAgentId` (D-7) passes a UUID
// through with NO list call, else resolves the slug via ONE `profile.list` (same agents:read family).
// The pid comes from the resolved project context (F0: `requireProject` throws the teachable
// usage_error BEFORE any wire call).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { resolveAgentId } from "./resolve";

export const agentGetArgs = z
  .object({
    agent: z.string().min(1).describe("Agent profile slug or id."),
  })
  .strict();
export type AgentGetInput = z.infer<typeof agentGetArgs>;

export const agentGet: CommandHandler<AgentGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const id = await resolveAgentId(ctx, input.agent);
  const resp = await ctx.client.request({ operationId: "profile.get", params: { pid, id } });
  return { data: resp };
};
