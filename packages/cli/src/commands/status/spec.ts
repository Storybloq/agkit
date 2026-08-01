// `status` noun (T-208, deliverable 5). Like `version`/`whoami`, a singleton noun
// whose one visible command is the canonical read (`get`), so the yargs generator
// surfaces it as the BARE command `agkit status`. It is a LOCAL aggregate (no
// management route today — the server fields land in T-211), so `scopes` is empty
// and it carries `mcpExclude` (cross-cutting, like `whoami`). Danger SR — it never
// mutates, and `authenticated:false` is DATA at exit 0 (never an error).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { statusGet, statusGetArgs } from "./get";

export const statusCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "status",
    verb: "get",
    summary: "Report the local session: auth, effective context + sources, config, update notice.",
    args: statusGetArgs,
    scopes: [], // local aggregate; the server-identity/handshake fields land in T-211
    danger: "SR",
    outputSchemaId: outputSchemaId("status", "get"),
    examples: ["agkit status"],
    handler: statusGet,
    mcpExclude: "cross-cutting local session aggregate (server fields land in T-211); not a management resource tool",
    execution: "local", // T-210: local session aggregate; no server call today.
  }),
];
