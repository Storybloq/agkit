// `media-job list` handler (T-214, media_job.list, jobs:read, SR). PAGINATED read via the
// T-211 pipeline. `--status` is the WIRE filter (server allow-list router.ts
// EXTRA_QUERY_PARAMS = media_job.list → [status]; the enum {pending,processing,completed,
// failed} lives in server code — a 400 names the allow-list, so it rides as a documented
// `z.string()`, never a vendored client gate; DEV-10). {pid} rides from the resolved
// project (F0). No row cap client-side (FORBIDDEN-1 holds).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const mediaJobListArgs = z
  .object({
    status: z.string().optional().describe("Filter by job status (server enum: pending | processing | completed | failed)."),
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type MediaJobListInput = z.infer<typeof mediaJobListArgs>;

export const mediaJobList: CommandHandler<MediaJobListInput> = async (ctx, input) => {
  const params = { pid: requireProject(ctx), ...input };
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "media_job.list", params);
  }
  const page = await ctx.client.request({ operationId: "media_job.list", params });
  return singlePageResult(page);
};
