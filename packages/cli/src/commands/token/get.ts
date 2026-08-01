// `token get` handler (T-213 S10; N-011 tokens family, tokens:read, SR). Pure: it resolves the
// `--id` argument (a full UUID or a short id/masked-display prefix — see resolve.ts) to exactly
// one token id, then fetches that token for the effective project and maps the raw DTO to a masked
// display row (decision E: key `display`, never `masked_secret`; B-6: contract-minimal tolerance).
//
// The route is project-scoped (`pid = requireProject(ctx)`) and UUID-only server-side; the prefix
// disambiguation is entirely client-side. A REVOKED token is reachable by FULL id only (the
// live-list index the prefix drain reads is `revoked_at IS NULL`) — an honest, documented boundary.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { resolveTokenId } from "./resolve";
import { toTokenDisplayRow } from "./dto";

export const tokenGetArgs = z
  .object({
    id: z.string().min(1).describe("Token id (a UUID) or an unambiguous id/display prefix."),
  })
  .strict();
export type TokenGetInput = z.infer<typeof tokenGetArgs>;

export const tokenGet: CommandHandler<TokenGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const id = await resolveTokenId(ctx, input.id);
  const raw = await ctx.client.request({ operationId: "management_token.get", params: { pid, id } });
  return { data: toTokenDisplayRow(raw) };
};
