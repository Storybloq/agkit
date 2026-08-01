// `issuer list` handler (T-216 R8; N-011 issuers family, issuers:read, SR). The route is
// `paginated:false` (D7 — the route row is authoritative), so this spec carries NO `--limit` /
// `--cursor` flags (tuple-lock parity: cursor IFF paginated) and never consults `--paginate`.
// The server still returns the standard list ENVELOPE ({object:"list", data, has_more:false} —
// credentials.ts listEnvelope), so `singlePageResult` maps it: a well-formed complete page exits 0,
// and a protocol-violating envelope takes the A35 typed-error path.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";

export const issuerListArgs = z.object({}).strict();
export type IssuerListInput = z.infer<typeof issuerListArgs>;

export const issuerList: CommandHandler<IssuerListInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "issuer.list", params: { pid } });
  return singlePageResult(page);
};
