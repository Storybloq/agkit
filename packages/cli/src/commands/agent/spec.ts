// `agent` noun (T-218; N-011 agents family). The agent-profile surface: SR reads (list/get) that
// project to `agkit_agent_read`, PR plan-kind writes (create/update/delete) that project to
// `agkit_agent_plan` and run the FUSED plan.create→apply ceremony (the wire routes are plan_required
// — the only legal write path), and `sync` — the ONE ratified PR-`direct` exception (D-3), wrapped in
// the CLI's direct_confirm ceremony and EXCLUDED from MCP (D-8: no local file + no TTY over MCP ⇒ an
// unconfirmed bulk overwrite; every direct_confirm command is mcpExclude). `agent delete` is
// agents:DESTROY / wire PR+D (cascades to tools + knowledge bindings — surfaced by the plan's cascade
// advisory); contrast D-1's `agent-tool delete` = agents:write / PR (non-cascading).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { agentList, agentListArgs } from "./list";
import { agentGet, agentGetArgs } from "./get";
import { agentCreateArgs, agentCreateChanges } from "./create";
import { agentUpdateArgs, agentUpdateChanges } from "./update";
import { agentDeleteArgs, agentDeleteChanges } from "./delete";
import { agentSync, agentSyncArgs, prepareAgentSync } from "./sync";
import { planMutationHandler } from "../plan/apply";

export const agentCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "agent",
    verb: "list",
    summary: "List the project's agent profiles.",
    args: agentListArgs,
    scopes: ["agents:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("agent", "list"),
    examples: ["agkit agent list"],
    handler: agentList,
    execution: "remote",
  }),
  defineCommand({
    noun: "agent",
    verb: "get",
    summary: "Show an agent profile.",
    args: agentGetArgs,
    scopes: ["agents:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("agent", "get"),
    examples: ["agkit agent get support-bot"],
    handler: agentGet,
    positional: { key: "agent", name: "agent" },
    execution: "remote",
  }),
  defineCommand({
    noun: "agent",
    verb: "create",
    summary: "Create an agent profile (prod-rebinding).",
    args: agentCreateArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent", "create"),
    // Tier VALUES are server-owned realization (§B-1): the example uses neutral `example-tier-*`
    // placeholders (the `route create` precedent — spec.ts:59 `--tier example-tier`), NEVER a real
    // TIERS member. Two values also document that `--allowed-tiers` is repeatable.
    examples: [
      'agkit agent create support-bot --display-name "Support Bot" --static-system-prompt "You help customers." --allowed-tiers example-tier-a --allowed-tiers example-tier-b --max-input-tokens 8000 --max-output-tokens 2000',
    ],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentCreateChanges },
    positional: { key: "slug", name: "slug" },
    execution: "remote",
  }),
  defineCommand({
    noun: "agent",
    verb: "update",
    summary: "Update an agent profile's config (slug is immutable; prod-rebinding).",
    args: agentUpdateArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent", "update"),
    examples: ['agkit agent update support-bot --display-name "Support Assistant"'],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentUpdateChanges },
    positional: { key: "agent", name: "agent" },
    execution: "remote",
  }),
  // agents:DESTROY, wire PR+D → CLI PR. Cascades to tools + knowledge bindings (server-stamped on the
  // delete diff entry; surfaced by the plan renderer's cascade advisory).
  defineCommand({
    noun: "agent",
    verb: "delete",
    summary: "Delete an agent profile (cascades to its tools + knowledge bindings — destructive, prod-rebinding).",
    args: agentDeleteArgs,
    scopes: ["agents:destroy"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent", "delete"),
    examples: ["agkit agent delete support-bot"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentDeleteChanges },
    positional: { key: "agent", name: "agent" },
    execution: "remote",
  }),
  // D-3: the single PR-`direct` exception. direct_confirm ceremony (client-computed per-profile diff
  // + typed confirm) over the non-plannable `profile.sync` route. D-8: mcpExclude with a reason —
  // an MCP call has no local file and no TTY for the typed challenge, so exposing it would be an
  // unconfirmed bulk overwrite (SECURE outranks no-deferrals; T-226 MCP dispatch may revisit).
  defineCommand({
    noun: "agent",
    verb: "sync",
    summary: "Sync agent profiles from a JSON file (upsert-only; prod-rebinding).",
    args: agentSyncArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent", "sync"),
    examples: ["agkit agent sync --file agents.json"],
    handler: agentSync,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "direct_confirm", prepare: prepareAgentSync },
    mcpExclude: "direct_confirm: no TTY for the typed challenge and no local file over MCP ⇒ would be an unconfirmed bulk overwrite",
    execution: "remote",
  }),
];
