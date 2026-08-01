// `media-usage costs` handler (T-214, media_usage.costs, usage:read, SR). Unpaginated
// singleton read: pass the server bytes through. `--days` is the WIRE query knob (server
// allow-list router.ts EXTRA_QUERY_PARAMS = media_usage.costs → [days]; DEV-10). {pid}
// rides from the resolved project (F0).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const mediaUsageCostsArgs = z
  .object({
    days: z.coerce.number().int().positive().optional().describe("Window in days (server clamps 1..365, default 30)."),
  })
  .strict();
export type MediaUsageCostsInput = z.infer<typeof mediaUsageCostsArgs>;

export const mediaUsageCosts: CommandHandler<MediaUsageCostsInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "media_usage.costs",
    params: { pid: requireProject(ctx), ...input },
  });
  return { data };
};
