// `provider-key list` handler (T-217, L2-CLI-12; credential.list, provider-keys:read, SR).
// Pure: it delegates to the typed client for the effective project's provider credentials and
// passes the server rows through verbatim. Reads NEVER carry key material — the server returns
// prefix/masked metadata only (`masked_secret`; §0 `secret_bearing:"none"`), so there is no
// client-side display remap to do (unlike `token list`, whose row rekeys `masked_secret`→`display`).
//
// The route is NON-paginated (§0 `paginated:false`), so this surface carries NO `--limit`/
// `--cursor`/`--paginate` (D5): the args are the empty strict object and the single list page is
// validated + passed through by `singlePageResult` (the SAME A9 list-envelope invariant the
// paginated reads use — a malformed page is the same terminal protocol error, never silent).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";

export const providerKeyListArgs = z.object({}).strict();
export type ProviderKeyListInput = z.infer<typeof providerKeyListArgs>;

export const providerKeyList: CommandHandler<ProviderKeyListInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "credential.list", params: { pid } });
  return singlePageResult(page);
};
