// `publishable-key list` handler (T-216 R5; N-011 keys family, keys:read, SR). A paginated read
// mirroring `plan list` (T-211 step 4 semantics): `--paginate` drains every page through the client
// seam; without it one page is fetched and a truncated page exits 3 via `meta.next_cursor`.
//
// The `--limit` ceiling comes from the ROUTE's frozen pagination metadata — NEVER a hardcoded
// literal (the plan/list.ts pattern; project/list.ts's hardcoded `.max(200)` is the anti-pattern).
// The module fail-louds at import if the metadata went missing (a manifest regression).
//
// Output rows are SERVER-shaped: an active listing row carries `masked_secret` ONLY (the full
// `ak_pk_live_*` value is a shown-once mint disclosure — server omission, no client masking needed).
import { z } from "zod";
import { routeFor } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

const PK_LIST_ROUTE = routeFor("publishable_key.list");
if (PK_LIST_ROUTE?.pagination === undefined) {
  throw new Error("agkit: internal — the publishable_key.list route metadata is missing its pagination bounds");
}
/** The frozen max_limit (200) — exported so tests compare against the metadata, not a literal. */
export const PUBLISHABLE_KEY_LIST_MAX_LIMIT = PK_LIST_ROUTE.pagination.max_limit;

export const publishableKeyListArgs = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(PUBLISHABLE_KEY_LIST_MAX_LIMIT)
      .optional()
      .describe("Max rows to return."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type PublishableKeyListInput = z.infer<typeof publishableKeyListArgs>;

export const publishableKeyList: CommandHandler<PublishableKeyListInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "publishable_key.list", { pid, ...input });
  }
  const page = await ctx.client.request({ operationId: "publishable_key.list", params: { pid, ...input } });
  return singlePageResult(page);
};
