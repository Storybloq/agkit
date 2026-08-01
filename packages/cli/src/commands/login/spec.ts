// `login` noun (T-213 S7, D1). A bare, non-resource lifecycle command: it surfaces as
// `agkit login` (decision (k): `bare: true` opts a non-read verb into the bare surface, exactly
// like `whoami`/`version`). verb `create` = "create a session/credential" (closed vocab). It is
// EXCLUDED from the MCP surface (APX-E.4: no `agkit_login` tool ever — interactive auth lifecycle,
// not a management resource). `execution:"remote"` is honest (it talks to the server); scopes:[]
// so no capability gate and no credential-resolution branch runs (login WRITES a credential, it
// does not consume one) — the shell injects the runtime + auth seams via commandNeedsRuntime /
// commandNeedsAuth instead.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { loginCreate, loginCreateArgs } from "./create";

export const loginCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "login",
    verb: "create",
    bare: true,
    summary: "Log in and store a management credential (browser or device flow, auto-detected).",
    args: loginCreateArgs,
    scopes: [], // login WRITES a credential; it declares none (no capability gate, no resolve branch)
    danger: "M",
    outputSchemaId: outputSchemaId("login", "create"),
    examples: ["agkit login", "agkit login --device", "agkit login --scopes projects:read,routes:write"],
    handler: loginCreate,
    execution: "remote",
    mcpExclude: "interactive auth lifecycle (N-011 APX-E.4); never a management-resource MCP tool",
  }),
];
