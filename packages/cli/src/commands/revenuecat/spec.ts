// `revenuecat` noun (T-219; N-011 C12). One SR read (`revenuecat.get` — NEVER the key: the server
// select-list omits it), the secret-bearing dual-mode direct_confirm `set` (`revenuecat.upsert` —
// NOT plannable: live external key validation; the `revenuecat:update` CHANGE_TABLE entry is
// executable:false naming this door), and the plan-kind PR `delete` over `revenuecat.disable` —
// D-3 LABEL BY REALITY: the op-id says "disable", the bytes HARD-DELETE the row; the CLI verb is
// `delete` (a `disable` verb is FORBIDDEN 1) and the summary says what actually happens.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { revenuecatGet, revenuecatGetArgs } from "./get";
import { revenuecatSet, revenuecatSetArgs, prepareRevenuecatSet } from "./set";
import { revenuecatDeleteArgs, revenuecatDeleteChanges } from "./delete";
import { planMutationHandler } from "../plan/apply";

export const revenuecatCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "revenuecat",
    verb: "get",
    summary: "Show the project's RevenueCat binding config (the secret API key is never returned).",
    args: revenuecatGetArgs,
    scopes: ["revenuecat:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("revenuecat", "get"),
    examples: ["agkit revenuecat get"],
    handler: revenuecatGet,
    execution: "remote",
  }),
  // D-2: key channels ONLY — the config members (entitlement/claim/TTL) are wire-inexpressible at
  // this contract version (closed `{api_key, confirm}` $def) and stay dashboard-managed.
  defineCommand({
    noun: "revenuecat",
    verb: "set",
    summary:
      "Set or replace the RevenueCat secret API key (validated live; entitlement/claim/TTL config is dashboard-managed at this contract version; prod-rebinding).",
    args: revenuecatSetArgs,
    scopes: ["revenuecat:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("revenuecat", "set"),
    examples: ["agkit revenuecat set --api-key-env MY_REVENUECAT_KEY"],
    handler: revenuecatSet,
    confirm: { challenge: "project-name" },
    mutation: { kind: "direct_confirm", prepare: prepareRevenuecatSet },
    mcpExclude:
      "secret-bearing direct_confirm ceremony — the key rides env-indirection or a hidden TTY prompt, neither available to an MCP host; returns no Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "revenuecat",
    verb: "delete",
    summary:
      "Delete the RevenueCat binding — hard-deletes the row (the dashboard's 'disable' label is a mislabel); end-user entitlement gating stops (destructive, prod-rebinding).",
    args: revenuecatDeleteArgs,
    scopes: ["revenuecat:destroy"],
    danger: "PR",
    outputSchemaId: outputSchemaId("revenuecat", "delete"),
    examples: ["agkit revenuecat delete"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: revenuecatDeleteChanges },
    execution: "remote",
  }),
];
