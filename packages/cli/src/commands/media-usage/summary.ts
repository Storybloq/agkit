// `media-usage summary` handler (T-214, media_usage.summary, usage:read, SR). Unpaginated
// singleton read: pass the server bytes through. `--days` is the WIRE query knob (server
// allow-list router.ts EXTRA_QUERY_PARAMS = media_usage.summary → [days]; server clamp
// 1..365 default 30; DEV-10). {pid} rides from the resolved project (F0).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const mediaUsageSummaryArgs = z
  .object({
    days: z.coerce.number().int().positive().optional().describe("Window in days (server clamps 1..365, default 30)."),
  })
  .strict();
export type MediaUsageSummaryInput = z.infer<typeof mediaUsageSummaryArgs>;

export const mediaUsageSummary: CommandHandler<MediaUsageSummaryInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "media_usage.summary",
    params: { pid: requireProject(ctx), ...input },
  });
  return { data };
};
