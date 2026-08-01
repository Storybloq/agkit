// `media-route` noun (T-220; N-011 media-routes family). Capability → provider+model binding
// surface: SR reads (list/get) projecting to `agkit_media_route_read`, and PR plan-kind writes —
// `set` (media_route.upsert, the presence-forked create/update per AM-0b) and `enable`/`disable`
// (media_route.toggle, action "invoke") — projecting to `agkit_media_route_plan` through the FUSED
// plan.create→apply ceremony. There is NO delete verb on this noun and no spec wording implies one
// (OD-13 / §5-F1-F2): a capability with no route is expressed by `disable`, which the copy labels
// exactly as disabling (the relay treating disabled ≡ absent is a wire fact, not a user-facing
// "delete").
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { mediaRouteList, mediaRouteListArgs } from "./list";
import { mediaRouteGet, mediaRouteGetArgs } from "./get";
import { mediaRouteSetArgs, mediaRouteSetChanges } from "./set";
import { mediaRouteToggleArgs, mediaRouteEnableChanges, mediaRouteDisableChanges } from "./toggle";
import { planMutationHandler } from "../plan/apply";

export const mediaRouteCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "media-route",
    verb: "list",
    summary: "List the project's media routes (capability → provider+model bindings).",
    args: mediaRouteListArgs,
    scopes: ["media-routes:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-route", "list"),
    examples: ["agkit media-route list"],
    handler: mediaRouteList,
    execution: "remote",
  }),
  defineCommand({
    noun: "media-route",
    verb: "get",
    summary: "Show one capability's media route.",
    args: mediaRouteGetArgs,
    scopes: ["media-routes:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-route", "get"),
    examples: ["agkit media-route get image"],
    handler: mediaRouteGet,
    positional: { key: "capability", name: "capability" },
    execution: "remote",
  }),
  defineCommand({
    noun: "media-route",
    verb: "set",
    summary: "Bind a capability's media route to a provider + model (prod-rebinding).",
    args: mediaRouteSetArgs,
    scopes: ["media-routes:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("media-route", "set"),
    examples: ["agkit media-route set image --provider example-media --model example-model"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: mediaRouteSetChanges },
    positional: { key: "capability", name: "capability" },
    execution: "remote",
  }),
  defineCommand({
    noun: "media-route",
    verb: "enable",
    summary: "Enable a capability's media route (prod-rebinding).",
    args: mediaRouteToggleArgs,
    scopes: ["media-routes:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("media-route", "enable"),
    examples: ["agkit media-route enable image"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: mediaRouteEnableChanges },
    positional: { key: "capability", name: "capability" },
    execution: "remote",
  }),
  defineCommand({
    noun: "media-route",
    verb: "disable",
    summary: "Disable a capability's media route (the binding is kept; enable restores it).",
    args: mediaRouteToggleArgs,
    scopes: ["media-routes:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("media-route", "disable"),
    examples: ["agkit media-route disable image"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: mediaRouteDisableChanges },
    positional: { key: "capability", name: "capability" },
    execution: "remote",
  }),
];
