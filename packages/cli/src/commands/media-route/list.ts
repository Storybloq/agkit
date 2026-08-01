// `media-route list` handler (T-220; N-011 media-routes family, media-routes:read, SR). The route
// is `paginated:false` (D10 — the route row is authoritative), so this spec carries NO `--limit` /
// `--cursor` flags (tuple-lock parity: cursor IFF paginated) and never consults `--paginate`. The
// server still returns the standard list ENVELOPE, so `singlePageResult` maps it: a well-formed
// complete page exits 0; a protocol-violating envelope takes the A35 typed-error path.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";

export const mediaRouteListArgs = z.object({}).strict();
export type MediaRouteListInput = z.infer<typeof mediaRouteListArgs>;

export const mediaRouteList: CommandHandler<MediaRouteListInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "media_route.list", params: { pid } });
  return singlePageResult(page);
};
