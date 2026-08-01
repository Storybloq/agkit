// `profile` noun (T-208, deliverable 3). A multi-verb LOCAL noun: `agkit profile
// <list|show|use|rename|delete>` over the config file + the OS keychain — no
// management route, no server — so `scopes` is empty and every verb is `mcpExclude`d
// (cross-cutting local command). list/show are safe reads (SR); use/rename/delete
// are LOCAL mutations (M). `delete` is deliberately M, NOT D: the D->typed-confirm
// ceremony (challenge is a server "resource-name"/"project-name" the server
// re-verifies, PL-13) is meaningless for a purely-local credential removal, and the
// loss is recoverable by re-login. The FORBIDDEN invariant that matters — never
// orphaning the keychain entry — is enforced in the handler, not by a confirm gate.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { profileList, profileListArgs } from "./list";
import { profileShow, profileShowArgs } from "./show";
import { profileUse, profileUseArgs } from "./use";
import { profileRename, profileRenameArgs } from "./rename";
import { profileDelete, profileDeleteArgs } from "./delete";

const MCP_EXCLUDE = "cross-cutting local profile command; not a management resource tool";

export const profileCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "profile",
    verb: "list",
    summary: "List known profiles (with the active one marked).",
    args: profileListArgs,
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("profile", "list"),
    examples: ["agkit profile list"],
    handler: profileList,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config + keychain; no server call.
  }),
  defineCommand({
    noun: "profile",
    verb: "show",
    summary: "Show one profile's defaults + credential presence.",
    args: profileShowArgs,
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("profile", "show"),
    examples: ["agkit profile show", "agkit profile show --name staging"],
    handler: profileShow,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config + keychain; no server call.
  }),
  defineCommand({
    noun: "profile",
    verb: "use",
    summary: "Make a profile the active default.",
    args: profileUseArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("profile", "use"),
    examples: ["agkit profile use --name staging"],
    handler: profileUse,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config + keychain; no server call.
  }),
  defineCommand({
    noun: "profile",
    verb: "rename",
    summary: "Rename a profile (migrates its config + credential).",
    args: profileRenameArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("profile", "rename"),
    examples: ["agkit profile rename --old dev --new staging"],
    handler: profileRename,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config + keychain; no server call.
  }),
  defineCommand({
    noun: "profile",
    verb: "delete",
    summary: "Delete a profile (removes its keychain entry + config).",
    args: profileDeleteArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("profile", "delete"),
    examples: ["agkit profile delete --name staging"],
    handler: profileDelete,
    mcpExclude: MCP_EXCLUDE,
    execution: "local", // T-210: operates on local config + keychain; no server call.
  }),
];
