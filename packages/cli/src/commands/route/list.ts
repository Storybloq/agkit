// `route list` handler (T-217 step 5; model_route.list, routes:read, SR). Pure passthrough of the
// server rows. The route is NON-paginated (§0 `paginated:false`) so this surface carries NO
// `--limit`/`--cursor`/`--paginate` (D5); the single page is validated by the SAME A9 list-envelope
// invariant (`singlePageResult`) the paginated reads use.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { singlePageResult } from "../../core/client/paginate";

export const routeListArgs = z.object({}).strict();
export type RouteListInput = z.infer<typeof routeListArgs>;

export const routeList: CommandHandler<RouteListInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "model_route.list", params: { pid } });
  return singlePageResult(page);
};
