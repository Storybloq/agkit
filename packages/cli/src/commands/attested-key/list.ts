// `attested-key list` handler (T-214, attested_key.list, attest:read, SR). PAGINATED read via
// the T-211 pipeline. `--user-hash` binds to the wire `external_user_id_hash` filter (DEV-6 —
// the D1 pagination filter; the CLI flag name is friendlier than the wire column). {pid} rides
// from the resolved project (F0). Each row carries an `etag` (contract resource_base requires
// it) which passes THROUGH unchanged — the step-9 revoke If-Match lookup reads it.
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const attestedKeyListArgs = z
  .object({
    "user-hash": z.string().min(1).optional().describe("Filter by end-user external_user_id_hash."),
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type AttestedKeyListInput = z.infer<typeof attestedKeyListArgs>;

export const attestedKeyList: CommandHandler<AttestedKeyListInput> = async (ctx, input) => {
  const params: Record<string, unknown> = { pid: requireProject(ctx), limit: input.limit, cursor: input.cursor };
  // Bind the CLI `--user-hash` to the wire `external_user_id_hash` filter (server allow-list).
  if (input["user-hash"] !== undefined) params.external_user_id_hash = input["user-hash"];

  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "attested_key.list", params);
  }
  const page = await ctx.client.request({ operationId: "attested_key.list", params });
  return singlePageResult(page);
};
