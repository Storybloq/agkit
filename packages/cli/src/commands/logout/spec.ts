// `logout` noun (T-213 S8, D2). A bare, non-resource lifecycle command: it surfaces as
// `agkit logout` (decision (k): `bare: true`, symmetric with `login`). verb `clear` = "clear
// stored credentials" (closed vocab). EXCLUDED from MCP (APX-E.4: a non-resource lifecycle
// command, symmetric with login). `execution:"remote"` (it best-effort revokes server-side);
// scopes:[] so no capability gate + no credential-resolution branch — the shell injects the
// runtime + auth seams (commandNeedsRuntime / the ctx.auth attach).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { logoutClear, logoutClearArgs } from "./clear";

export const logoutCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "logout",
    verb: "clear",
    bare: true,
    summary: "Log out: best-effort server revocation + clear the stored management credential.",
    args: logoutClearArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("logout", "clear"),
    examples: ["agkit logout", "agkit logout --all-profiles"],
    handler: logoutClear,
    execution: "remote",
    mcpExclude: "interactive auth lifecycle (N-011 APX-E.4); never a management-resource MCP tool",
  }),
];
