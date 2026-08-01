// `grant list` handler (T-299 R2; oauth.grant.list, tokens:read, SR). An ACCOUNT-tier paginated
// read (GET /v1/management/oauth/grants — NO {pid} path param; the token anchors the account
// server-side), drained through the T-211 pipeline exactly like `audit list`.
//
// THE FLAG SET IS DICTATED BY THE FROZEN PAGINATION COLUMN, not by taste. The v1.2.0 row's
// `pagination` block is `{sort_key: created_at, tie_breaker: id, default_limit: 50, max_limit: 200,
// filters: []}` — an EMPTY filter list — so this command advertises `--limit` + `--cursor` and
// NOTHING else (§B-2: what the server does not serve, the wire must not expose). The server's own
// query hygiene rejects any other key, so an invented filter flag would be a false affordance that
// 400s on contact.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const grantListArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server default 50, max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type GrantListInput = z.infer<typeof grantListArgs>;

export const grantList: CommandHandler<GrantListInput> = async (ctx, input) => {
  const params = { ...input };
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "oauth.grant.list", params);
  }
  const page = await ctx.client.request({ operationId: "oauth.grant.list", params });
  return singlePageResult(page);
};
