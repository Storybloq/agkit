// `voice-identity list` handler (T-220; identities:read, SR). The ONE paginated route on this
// plane (D10): `--limit` (ceiling from the route's frozen pagination metadata — NEVER a
// literal), `--cursor`, and `--paginate` drains every page through the client seam; without it
// one page is fetched and a truncated page exits 3 via `meta.next_cursor`. The limit flag uses
// the canonical-decimal preprocess, never `z.coerce.number` (L-053: coerce launders ""/"1e3"/
// "0x10"/booleans into in-range numbers).
import { z } from "zod";
import { routeFor } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

const IDENTITY_LIST_ROUTE = routeFor("identity.list");
if (IDENTITY_LIST_ROUTE?.pagination === undefined) {
  throw new Error("agkit: internal — the identity.list route metadata is missing its pagination bounds");
}
/** The frozen max_limit (200) — exported so tests compare against the metadata, not a literal. */
export const VOICE_IDENTITY_LIST_MAX_LIMIT = IDENTITY_LIST_ROUTE.pagination.max_limit;

const CANONICAL_INT_RE = /^(0|[1-9][0-9]*)$/;
const canonicalInt = (v: unknown): unknown =>
  typeof v === "string" && CANONICAL_INT_RE.test(v) ? Number(v) : v;

export const voiceIdentityListArgs = z
  .object({
    limit: z
      .preprocess(canonicalInt, z.number().int().positive().max(VOICE_IDENTITY_LIST_MAX_LIMIT))
      .optional()
      .describe("Max rows to return."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type VoiceIdentityListInput = z.infer<typeof voiceIdentityListArgs>;

export const voiceIdentityList: CommandHandler<VoiceIdentityListInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  if (ctx.clientFlags?.paginate) {
    return drainList(ctx.client, "identity.list", { pid, ...input });
  }
  const page = await ctx.client.request({ operationId: "identity.list", params: { pid, ...input } });
  return singlePageResult(page);
};
