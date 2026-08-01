// `token` noun (T-213 S10–S12; N-011 tokens family). A multi-verb noun surfaced as
// `agkit token <list|get|create|revoke>` — NOT bare (it carries sibling subcommands). The S10
// verbs are project-scoped safe reads (tokens:read, SR, remote); `create` (S11) is a shown-once
// mint (tokens:write, M); `revoke` (S12) is a direct_confirm destructive op (tokens:destroy, D).
// Display forms are masked (decision E) and prefix resolution is entirely client-side (resolve.ts).
// A REVOKED token is reachable by full id only.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { tokenList, tokenListArgs } from "./list";
import { tokenGet, tokenGetArgs } from "./get";
import { tokenCreate, tokenCreateArgs } from "./create";
import { tokenRevoke, tokenRevokeArgs, prepareTokenRevoke } from "./revoke";

export const tokenCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "token",
    verb: "list",
    summary: "List management tokens for the current project (masked display forms only).",
    args: tokenListArgs,
    scopes: ["tokens:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("token", "list"),
    examples: ["agkit token list", "agkit token list --limit 50"],
    handler: tokenList,
    execution: "remote",
  }),
  defineCommand({
    noun: "token",
    verb: "get",
    summary: "Show one management token by id or unambiguous id/display prefix (revoked: full id only).",
    args: tokenGetArgs,
    scopes: ["tokens:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("token", "get"),
    examples: ["agkit token get --id 1a2b3c4d", "agkit token get --id 1a2b3c4d-0000-4000-a000-000000000001"],
    handler: tokenGet,
    execution: "remote",
  }),
  defineCommand({
    noun: "token",
    verb: "create",
    summary: "Mint a project-scoped management token (secret shown once). Re-run mints a NEW token; use --idempotency-key to safe-retry.",
    args: tokenCreateArgs,
    scopes: ["tokens:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("token", "create"),
    examples: [
      "agkit token create --name ci-bot --scope tokens:read --expires-in 30d",
      "agkit token create --name deploy --scope routes:read --scope routes:write --expires-in 90d",
    ],
    handler: tokenCreate,
    execution: "remote",
    // Secret-bearing shown-once mint (human ceremony): reachable via the CLI, never an MCP tool.
    mcpExclude: "secret-bearing shown-once mint (human ceremony); not exposed as an MCP tool",
  }),
  defineCommand({
    noun: "token",
    verb: "revoke",
    summary: "Revoke a management token by id or unambiguous id/display prefix (destructive; confirm by name).",
    args: tokenRevokeArgs,
    scopes: ["tokens:destroy"],
    danger: "D",
    // D ⇒ typed-confirm wiring (registry invariant): the operator confirms the token NAME; the
    // server independently re-verifies `{confirm}` == name (PL-13 defence-in-depth).
    confirm: { challenge: "token-name" },
    outputSchemaId: outputSchemaId("token", "revoke"),
    examples: [
      "agkit token revoke --id 1a2b3c4d-0000-4000-a000-000000000001 --confirm ci-bot",
    ],
    handler: tokenRevoke,
    execution: "remote",
    // The wire's emergency door: gating:"direct_confirm" (no plan/apply — a plan can't return the
    // typed-confirm authority), consumed by T-212's runDirectConfirm. `prepare` resolves the target,
    // etag-fetches its row, and supplies the confirm authority (the name) + the If-Match ETag.
    mutation: { kind: "direct_confirm", prepare: prepareTokenRevoke },
    // A destructive typed-confirm human ceremony — like the shown-once mint, it is NOT an MCP tool
    // (a direct_confirm returns no Plan, so it cannot honestly project as an `agkit_token_plan`).
    mcpExclude: "destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool",
  }),
];
