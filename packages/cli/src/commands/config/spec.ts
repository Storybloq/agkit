// `config` noun (T-208, deliverable 3). A multi-verb LOCAL noun: `agkit config
// <get|set|unset|list>` operates on the NON-secret `config.json` — it maps to no
// management route and touches no server, so `scopes` is empty and every verb
// carries `mcpExclude` (cross-cutting local command, exactly like `version`/`whoami`).
// get/list are safe reads (SR); set/unset are LOCAL mutations (M) — deliberately NOT
// D: there is no wire resource and no server to re-verify a typed-confirm, and the
// change is trivially reversible, so the D->typed-confirm ceremony would be wrong here.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { configGet, configGetArgs } from "./get";
import { configSet, configSetArgs } from "./set";
import { configUnset, configUnsetArgs } from "./unset";
import { configList, configListArgs } from "./list";

const MCP_EXCLUDE = "cross-cutting local config command; not a management resource tool";

export const configCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "config",
    verb: "list",
    summary: "List the registered config keys with their current values.",
    args: configListArgs,
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("config", "list"),
    examples: ["agkit config list"],
    handler: configList,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config.json; no server call.
  }),
  defineCommand({
    noun: "config",
    verb: "get",
    summary: "Read one config key.",
    args: configGetArgs,
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("config", "get"),
    examples: ["agkit config get --key api_url"],
    handler: configGet,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config.json; no server call.
  }),
  defineCommand({
    noun: "config",
    verb: "set",
    summary: "Set one config key (validated per its type).",
    args: configSetArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("config", "set"),
    examples: ["agkit config set --key color --value never"],
    handler: configSet,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config.json; no server call.
  }),
  defineCommand({
    noun: "config",
    verb: "unset",
    summary: "Remove one config key (revert to its built-in default).",
    args: configUnsetArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("config", "unset"),
    examples: ["agkit config unset --key api_url"],
    handler: configUnset,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config.json; no server call.
  }),
];
