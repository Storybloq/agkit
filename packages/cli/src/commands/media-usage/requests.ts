// `media-usage requests` handler (T-214, media_usage.requests, usage:read, SR). PAGINATED
// read via the T-211 pipeline (project/list.ts shape). {pid} rides from the resolved
// project (F0). `--limit` == the frozen pagination.max_limit (200); no row cap client-side.
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const mediaUsageRequestsArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type MediaUsageRequestsInput = z.infer<typeof mediaUsageRequestsArgs>;

export const mediaUsageRequests: CommandHandler<MediaUsageRequestsInput> = async (ctx, input) => {
  const params = { pid: requireProject(ctx), ...input };
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "media_usage.requests", params);
  }
  const page = await ctx.client.request({ operationId: "media_usage.requests", params });
  return singlePageResult(page);
};
