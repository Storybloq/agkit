// `agent-tool` noun (T-218; N-011 agents family). The kebab-folded single-token noun (A-3) that
// realizes the ticket's nested `agent tool <verb> (--agent <slug>)` in the landed STRICTLY-2-token
// grammar: the parent association lives IN the noun (`agent-tool`), the profile itself rides the
// `--agent <slug>` selector. Reads are SR (`agkit_agent_read` via the §3.7 MCP fold — verb renamed
// `tool_<verb>`); writes are PR plan-kind (`agkit_agent_plan`). D-1: `tool delete` is agents:WRITE /
// PR (a within-profile edit, non-cascading), NOT agents:destroy — that clause is `agent delete`'s.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { agentToolList, agentToolListArgs } from "./list";
import { agentToolGet, agentToolGetArgs } from "./get";
import { agentToolCreateArgs, agentToolCreateChanges } from "./create";
import { agentToolUpdateArgs, agentToolUpdateChanges } from "./update";
import { agentToolDeleteArgs, agentToolDeleteChanges } from "./delete";
import { planMutationHandler } from "../plan/apply";

export const agentToolCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "agent-tool",
    verb: "list",
    summary: "List an agent profile's tools.",
    args: agentToolListArgs,
    scopes: ["agents:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("agent-tool", "list"),
    examples: ["agkit agent-tool list --agent support-bot"],
    handler: agentToolList,
    execution: "remote",
  }),
  defineCommand({
    noun: "agent-tool",
    verb: "get",
    summary: "Show one of an agent profile's tools.",
    args: agentToolGetArgs,
    scopes: ["agents:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("agent-tool", "get"),
    examples: ["agkit agent-tool get lookup_order --agent support-bot"],
    handler: agentToolGet,
    positional: { key: "tool", name: "tool" },
    execution: "remote",
  }),
  defineCommand({
    noun: "agent-tool",
    verb: "create",
    summary: "Add a tool to an agent profile (prod-rebinding).",
    args: agentToolCreateArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent-tool", "create"),
    examples: [
      'agkit agent-tool create lookup_order --agent support-bot --description "Look up an order" --parameter-schema \'{"type":"object","properties":{}}\'',
    ],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentToolCreateChanges },
    positional: { key: "name", name: "tool-name" },
    execution: "remote",
  }),
  defineCommand({
    noun: "agent-tool",
    verb: "update",
    summary: "Update a tool's config (tool name is immutable; prod-rebinding).",
    args: agentToolUpdateArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent-tool", "update"),
    examples: ['agkit agent-tool update lookup_order --agent support-bot --description "Look up an order by id"'],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentToolUpdateChanges },
    positional: { key: "tool", name: "tool" },
    execution: "remote",
  }),
  // D-1: agents:WRITE / PR (a within-profile edit, non-cascading) — NOT agents:destroy/PR+D.
  defineCommand({
    noun: "agent-tool",
    verb: "delete",
    summary: "Delete a tool from an agent profile (prod-rebinding).",
    args: agentToolDeleteArgs,
    scopes: ["agents:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("agent-tool", "delete"),
    examples: ["agkit agent-tool delete lookup_order --agent support-bot"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: agentToolDeleteChanges },
    positional: { key: "tool", name: "tool" },
    execution: "remote",
  }),
];
