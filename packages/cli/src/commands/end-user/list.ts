// `end-user list` handler (T-214, end_user.list, usage:read, SR). PAGINATED read via the
// T-211 pipeline (project/list.ts shape) — server keyset is single-field
// (external_user_id_hash) but that is server-internal; the CLI drains limit/cursor. {pid}
// rides from the resolved project (F0).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const endUserListArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type EndUserListInput = z.infer<typeof endUserListArgs>;

export const endUserList: CommandHandler<EndUserListInput> = async (ctx, input) => {
  const params = { pid: requireProject(ctx), ...input };
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "end_user.list", params);
  }
  const page = await ctx.client.request({ operationId: "end_user.list", params });
  return singlePageResult(page);
};
