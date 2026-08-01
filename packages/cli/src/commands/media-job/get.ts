// `media-job get` handler (T-214, media_job.get, jobs:read, SR). Unpaginated singleton read:
// pass the server bytes through. Route path is /projects/{pid}/media-jobs/{id}: {pid} rides
// from the resolved project (F0), {id} from `--id` (DEV-8, flags-first).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const mediaJobGetArgs = z
  .object({
    id: z.string().min(1).describe("Media job id."),
  })
  .strict();
export type MediaJobGetInput = z.infer<typeof mediaJobGetArgs>;

export const mediaJobGet: CommandHandler<MediaJobGetInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "media_job.get",
    params: { pid: requireProject(ctx), id: input.id },
  });
  return { data };
};
