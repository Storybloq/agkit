// `end-user` noun (T-214 L2-CLI-16, A-register A604 list / A605 get). The HONEST surface is
// list + get ONLY — the ticket's prose command list overstates: `end-user requests` has NO
// wire route (DEV-1, omitted) and `end-user models` ships its bytes embedded in `get`'s
// models[] (DEV-2, omitted as a command; the `get` summary documents the `--jq .models`
// recipe so the capability stays discoverable). Both are usage:read SR remote reads.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { endUserList, endUserListArgs } from "./list";
import { endUserGet, endUserGetArgs } from "./get";

export const endUserCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "end-user",
    verb: "list",
    summary: "List the project's end-users (paginated).",
    args: endUserListArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("end-user", "list"),
    examples: ["agkit end-user list", "agkit end-user list --limit 50"],
    handler: endUserList,
    execution: "remote",
  }),
  defineCommand({
    noun: "end-user",
    verb: "get",
    summary: "Show one end-user's usage detail (embeds a models[] breakdown — project it with --jq .models).",
    args: endUserGetArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("end-user", "get"),
    examples: ["agkit end-user get --user-hash 0000000000000000000000000000000000000000000000000000000000000000"],
    handler: endUserGet,
    execution: "remote",
  }),
];
