// `usage requests` handler (T-214, usage.requests, usage:read, SR). PAGINATED read
// through the T-211 pipeline (identical shape to project/list.ts): `--paginate` drains
// every page via `drainList` (retry × refresh × idempotency per page, A8/A9/A10/A35 + the
// 1000-page resumable cap — NO row cap, FORBIDDEN-1 holds client-side free); without it a
// single page is mapped by `singlePageResult` (decision G: a truncated page surfaces
// meta.next_cursor and exits 3). `--limit` is the route's per-page ceiling (zod .max(200)
// == the frozen pagination.max_limit); `--cursor` is the opaque keyset token. {pid} rides
// from the resolved project (F0).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const usageRequestsArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type UsageRequestsInput = z.infer<typeof usageRequestsArgs>;

export const usageRequests: CommandHandler<UsageRequestsInput> = async (ctx, input) => {
  const params = { pid: requireProject(ctx), ...input };
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "usage.requests", params);
  }
  const page = await ctx.client.request({ operationId: "usage.requests", params });
  return singlePageResult(page);
};
