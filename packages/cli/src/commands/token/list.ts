// `token list` handler (T-213 S10; N-011 tokens family, tokens:read, SR). Pure: it delegates to
// the typed client for the effective project's tokens and maps each raw DTO to a masked display
// row (decision E: key `display`, NEVER `masked_secret`; B-6: contract-minimal rows render
// honestly). The management_token.list route is project-scoped, so `pid = requireProject(ctx)`.
//
// Pagination mirrors the landed T-211 model: `--paginate` (a global client flag on
// `ctx.clientFlags`) drains EVERY page through the client seam; without it one page is fetched
// and mapped (decision G — a truncated single page surfaces `meta.next_cursor` and so exits 3).
// `--limit` / `--cursor` are PER-SPEC route args (plan decision F); `--paginate` is client-behavior.
import { z } from "zod";
import type { CommandHandler, CommandResult } from "../types";
import { requireProject } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";
import { toTokenDisplayRow } from "./dto";

export const tokenListArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows to return."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type TokenListInput = z.infer<typeof tokenListArgs>;

/** Map a drained/single-page CommandResult's raw rows → masked display rows, preserving meta/warnings. */
function mapRows(result: CommandResult): CommandResult {
  const mapped: CommandResult = { data: (result.data as unknown[]).map(toTokenDisplayRow) };
  if (result.meta) mapped.meta = result.meta;
  if (result.warnings) mapped.warnings = result.warnings;
  return mapped;
}

export const tokenList: CommandHandler<TokenListInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  if (ctx.clientFlags?.paginate) {
    return mapRows(await drainList(ctx.client, "management_token.list", { pid, ...input }));
  }
  const pageRaw = await ctx.client.request({ operationId: "management_token.list", params: { pid, ...input } });
  return mapRows(singlePageResult(pageRaw));
};
