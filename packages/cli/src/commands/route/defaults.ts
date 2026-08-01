// `route defaults` handler (T-226 D0-i; model_route.defaults, routes:read, SR). The recommended
// starting bindings the server publishes for a project — tier → model/provider/execution-target,
// each row tagged with the provider credential it needs.
//
// A THIN wrapper, by construction: the request and the defensive narrowing both live in the ONE
// shared core (`core/catalog/route-defaults.ts`) that `agkit init` drives its onboarding leg from,
// so this surface and init can never disagree about what the catalog says. What init adds on top —
// the absent-tier / credentialed-provider SELECTION — is init's policy and stays out of here: this
// verb reports the catalog, it does not decide anything about it.
//
// Route path is /projects/{pid}/model-routes/defaults: {pid} rides from the resolved project (F0),
// exactly like the sibling reads. Non-paginated (§0 `paginated:false`), and NOT a list envelope
// (the frozen `model_route_defaults_response` is an object), so no `singlePageResult` applies.
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";
import { fetchRouteDefaults } from "../../core/catalog/route-defaults";

export const routeDefaultsArgs = z.object({}).strict();
export type RouteDefaultsInput = z.infer<typeof routeDefaultsArgs>;

export const routeDefaults: CommandHandler<RouteDefaultsInput> = async (ctx) => {
  const catalog = await fetchRouteDefaults(ctx, requireProject(ctx));
  return { data: catalog };
};
