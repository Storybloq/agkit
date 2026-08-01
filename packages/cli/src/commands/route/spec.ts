// `route` noun (T-217, canonical L2-CLI-12; model-route family). A multi-verb noun surfaced as
// `agkit route <list|get|defaults|create|update|delete>`. Every spec is `execution:"remote"`; the
// verbs bind the `model_route.*` wire routes (§0):
//   • list     → model_route.list     (routes:read,    SR,   free)           — non-paginated (D5)
//   • get      → model_route.get      (routes:read,    SR,   free)           — positional <route-id>
//   • defaults → model_route.defaults (routes:read,    SR,   free)           — T-226 D0-i, catalog read
//   • create   → model_route.create   (routes:write,   PR,   plan_required)  — realization-complete all-8 body
//   • update   → model_route.update   (routes:write,   PR,   plan_required)  — partial patch, tier IMMUTABLE
//   • delete   → model_route.delete   (routes:destroy, PR+D→PR, plan_required) — bodyless change
//
// A3: every realization value (tier/model/provider/execution-target/attestation) is a USER-SUPPLIED
// argument — the binary hardcodes none, examples name none (example-* placeholders), and vocabulary
// membership is SERVER-owned fail-closed (the bindable execution-target registry rejects e.g. a
// reserved target). The `defaults` catalog is no exception: every value in it is SERVER-authored
// and passes through verbatim. MCP: list/get/defaults project agkit_route_read;
// create/update/delete project agkit_route_plan (a plan tool is an honest projection — the wire
// path IS plan.create).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { planMutationHandler } from "../plan/apply";
import { routeList, routeListArgs } from "./list";
import { routeGet, routeGetArgs } from "./get";
import { routeDefaults, routeDefaultsArgs } from "./defaults";
import { routeCreateArgs, routeCreateChanges } from "./create";
import { routeUpdateArgs, routeUpdateChanges } from "./update";
import { routeDeleteArgs, routeDeleteChanges } from "./delete";

export const routeCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "route",
    verb: "list",
    summary: "List model routes for the current project (tier → model/provider/execution-target bindings).",
    args: routeListArgs,
    scopes: ["routes:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("route", "list"),
    examples: ["agkit route list"],
    handler: routeList,
    execution: "remote",
  }),
  defineCommand({
    noun: "route",
    verb: "get",
    summary: "Show one model route by id.",
    args: routeGetArgs,
    scopes: ["routes:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("route", "get"),
    examples: ["agkit route get mr_123"],
    handler: routeGet,
    execution: "remote",
    positional: { key: "id", name: "route-id" },
  }),
  defineCommand({
    noun: "route",
    verb: "defaults",
    summary: "Show the recommended default model routes for the current project (the server's starting catalog).",
    args: routeDefaultsArgs,
    scopes: ["routes:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("route", "defaults"),
    examples: ["agkit route defaults"],
    handler: routeDefaults,
    execution: "remote",
  }),
  defineCommand({
    noun: "route",
    verb: "create",
    summary: "Create a model route (prod-rebinding): bind a tier to a model/provider/execution-target.",
    args: routeCreateArgs,
    scopes: ["routes:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("route", "create"),
    examples: [
      "agkit route create --tier example-tier --model example-model --provider example-llm --execution-target example-target --attestation off",
    ],
    handler: planMutationHandler,
    execution: "remote",
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: routeCreateChanges },
  }),
  defineCommand({
    noun: "route",
    verb: "update",
    summary: "Update a model route (prod-rebinding): patch its binding members (tier is immutable).",
    args: routeUpdateArgs,
    scopes: ["routes:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("route", "update"),
    examples: ["agkit route update mr_123 --model example-model"],
    handler: planMutationHandler,
    execution: "remote",
    positional: { key: "id", name: "route-id" },
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: routeUpdateChanges },
  }),
  defineCommand({
    noun: "route",
    verb: "delete",
    summary: "Delete a model route (prod-rebinding, destructive).",
    args: routeDeleteArgs,
    scopes: ["routes:destroy"],
    // Wire danger is the compound "PR+D" — the spec records the dominant class (D4).
    danger: "PR",
    outputSchemaId: outputSchemaId("route", "delete"),
    examples: ["agkit route delete mr_123"],
    handler: planMutationHandler,
    execution: "remote",
    positional: { key: "id", name: "route-id" },
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: routeDeleteChanges },
  }),
];
