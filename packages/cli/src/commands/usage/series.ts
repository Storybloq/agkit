// `usage series` handler (T-214, usage.series, usage:read, SR). Unpaginated singleton
// read: pass the server bytes through unchanged (label-by-reality — the CLI never
// re-projects the payload). {pid} comes from the resolved project context (F0); a missing
// project throws the teachable usage_error via `requireProject` BEFORE the request is
// prepared. `--days` / `--dimension` are the WIRE query knobs (server allow-list
// router.ts EXTRA_QUERY_PARAMS = usage.series → [days, dimension]; DEV-3). The client
// mirrors only the server's PARSE (positive int) — the server owns the 1..365 clamp and
// echoes the effective value; the dimension enum lives in server code (400 names the set),
// so it rides as a documented `z.string()` and is never a vendored client gate.
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const usageSeriesArgs = z
  .object({
    days: z.coerce.number().int().positive().optional().describe("Window in days (server clamps 1..365, default 30)."),
    dimension: z.string().optional().describe("Group-by dimension (server enum: execution_target | finish_reason)."),
  })
  .strict();
export type UsageSeriesInput = z.infer<typeof usageSeriesArgs>;

export const usageSeries: CommandHandler<UsageSeriesInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "usage.series",
    params: { pid: requireProject(ctx), ...input },
  });
  return { data };
};
