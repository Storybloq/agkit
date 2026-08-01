// `route get <id>` handler (T-217 step 5; model_route.get, routes:read, SR). Unpaginated singleton
// read: pass the server bytes through. Route path is /projects/{pid}/model-routes/{id}: {pid} rides
// from the resolved project (F0), {id} from the single positional (spec `positional: {key:"id",
// name:"route-id"}` — the dispatcher maps the leftover non-flag token onto input.id).
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const routeGetArgs = z
  .object({
    id: z.string().min(1).describe("Model-route id."),
  })
  .strict();
export type RouteGetInput = z.infer<typeof routeGetArgs>;

export const routeGet: CommandHandler<RouteGetInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "model_route.get",
    params: { pid: requireProject(ctx), id: input.id },
  });
  return { data };
};
