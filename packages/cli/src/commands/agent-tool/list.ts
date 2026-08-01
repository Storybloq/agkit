// `agent-tool list --agent <agent>` handler (T-218; N-011 agents family, agents:read, SR). Lists the
// tools attached to ONE agent profile via `tool.list` (route `.../{id}/tools`, paginated:false — no
// --limit/--cursor). The `--agent` flag names the parent profile by slug OR id; `resolveAgentId`
// (D-7) passes a UUID through with NO list call, else resolves the slug via ONE profile.list. A
// parent that does not exist surfaces the server's honest parent-404 (ISS-190). The kebab-folded
// noun `agent-tool` keeps the parent association in the noun (A-3); the profile itself rides the
// ticket's `--agent <slug>` selector.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";
import { resolveAgentId } from "../agent/resolve";

export const agentToolListArgs = z
  .object({
    agent: z.string().min(1).describe("The parent agent profile (slug or id)."),
  })
  .strict();
export type AgentToolListInput = z.infer<typeof agentToolListArgs>;

export const agentToolList: CommandHandler<AgentToolListInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const profileId = await resolveAgentId(ctx, input.agent);
  const page = await ctx.client.request({ operationId: "tool.list", params: { pid, id: profileId } });
  return singlePageResult(page);
};
