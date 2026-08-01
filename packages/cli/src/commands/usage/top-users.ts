// `usage top-users` handler (T-214, usage.top_users, usage:read, SR). Unpaginated
// singleton read: pass the server bytes through. `--limit` here is the route's top-N
// QUERY KNOB (server allow-list router.ts EXTRA_QUERY_PARAMS = usage.top_users → [limit];
// server default 10, cap 100 echoed as the effective limit), NOT pagination — so there is
// NO `--cursor` and no `--max(200)` clamp (DEV-7; the D-9 fixture records this as the one
// documented `--limit` exception to the pagination-parity rule). The name collision with
// the paginated `--limit` is intentional: it is the ticket's own `usage top-users --limit`
// syntax. {pid} rides from the resolved project (F0).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const usageTopUsersArgs = z
  .object({
    limit: z.coerce.number().int().positive().optional().describe("Top-N users to return (server default 10, cap 100)."),
  })
  .strict();
export type UsageTopUsersInput = z.infer<typeof usageTopUsersArgs>;

export const usageTopUsers: CommandHandler<UsageTopUsersInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "usage.top_users",
    params: { pid: requireProject(ctx), ...input },
  });
  return { data };
};
