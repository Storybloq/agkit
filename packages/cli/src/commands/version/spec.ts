// `version` — the singleton demonstrator noun (T-204 settled design). It has a
// single visible command whose verb is the canonical read (`get` is in the closed
// vocabulary), so the yargs generator surfaces it as the BARE command
// `agkit version` — the exact invocation the T-203 pack-smoke exercises
// (`agkit version` -> `{ ok:true, data:{version}, meta }`).
//
// `version` is cross-cutting (N-011 §APX-D "cross-cutting commands"): it maps to
// no management route and is NOT an MCP tool, so it carries `mcpExclude`.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { versionGet, versionGetArgs } from "./get";

export const versionCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "version",
    verb: "get",
    summary: "Print the agkit CLI version.",
    args: versionGetArgs,
    scopes: [], // local command — no auth, no scope
    danger: "SR",
    outputSchemaId: outputSchemaId("version", "get"),
    examples: ["agkit version"],
    handler: versionGet,
    mcpExclude: "cross-cutting local command; not a management resource tool",
    execution: "local", // T-210: no server call — the capability gate always passes it.
  }),
];
