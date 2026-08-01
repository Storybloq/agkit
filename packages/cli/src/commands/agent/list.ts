// `agent list` handler (T-218; N-011 agents family, agents:read, SR). The `profile.list` route is
// `paginated:false` (the route row is authoritative), so this spec carries NO `--limit` / `--cursor`
// flags (tuple-lock parity: cursor IFF paginated) and never consults `--paginate`. The server returns
// the standard list ENVELOPE ({object:"list", data, has_more:false}); `singlePageResult` maps it — a
// well-formed complete page exits 0, a protocol-violating envelope takes the A35 typed-error path.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";

export const agentListArgs = z.object({}).strict();
export type AgentListInput = z.infer<typeof agentListArgs>;

export const agentList: CommandHandler<AgentListInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "profile.list", params: { pid } });
  return singlePageResult(page);
};
