// `grant` noun (T-299; N-011 tokens family). The ACCOUNT-tier OAuth-grant plane T-199 (D-GMT) added
// to management v1.2.0, surfaced as `agkit grant <list|show|revoke>` — NOT bare (it carries sibling
// subcommands). `list`/`show` are account-scoped safe reads (tokens:read, SR, remote — no {pid}:
// the account-plane paths carry none, the token anchors the account server-side). `revoke` is a
// direct_confirm destructive op (tokens:destroy, D) that cascade-revokes the grant's child tokens.
//
// WHY NO PLAN DOOR (the T-299 adjudication of record, N-011 APX-D.1): the frozen row pins
// `gating:"direct_confirm"` and the wire-contract test pins it column-for-column against
// `management_token.revoke` (ADJUDICATION 3). There is no `CHANGE_TABLE` key for a grant, so a
// plan-kind revoke would be an unknown-change refusal at `plan.create` — a dead command. It
// therefore ships exactly as the family's four other revokes do: direct_confirm + `mcpExclude`, so
// `mcpProjection` returns null and NO `agkit_grant_plan` tool exists. The MCP surface keeps
// `agkit_apply` as its ONE destructive tool.
//
// The raw `agkit api` door stays shut for these paths (`/v1/management/oauth/**` is refused by the
// OAuth boundary) — that boundary governs the RAW door only; these typed operationId requests are a
// different, contract-checked path, which is exactly the surface this noun adds.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { grantList, grantListArgs } from "./list";
import { grantShow, grantShowArgs } from "./show";
import { grantRevoke, grantRevokeArgs, prepareGrantRevoke } from "./revoke";

export const grantCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "grant",
    verb: "list",
    summary: "List OAuth grants on the account.",
    args: grantListArgs,
    scopes: ["tokens:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("grant", "list"),
    examples: ["agkit grant list", "agkit grant list --limit 200"],
    handler: grantList,
    execution: "remote",
  }),
  defineCommand({
    noun: "grant",
    verb: "show",
    // Labeled by REALITY (§B-9): `getOauthGrant` returns EVERY child `management_tokens` row —
    // revoked ones INCLUDED, "so the operator sees the family history" — plus a SEPARATE
    // `live_token_counts` object. "its live tokens" named neither of those things.
    summary: "Show an OAuth grant, including child-token metadata and live-token counts.",
    args: grantShowArgs,
    scopes: ["tokens:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("grant", "show"),
    examples: ["agkit grant show 3a1f2b3c-0000-0000-0000-000000000000"],
    handler: grantShow,
    positional: { key: "id", name: "grant-id" },
    execution: "remote",
  }),
  defineCommand({
    noun: "grant",
    verb: "revoke",
    summary: "Revoke an OAuth grant and cascade-revoke its tokens.",
    args: grantRevokeArgs,
    scopes: ["tokens:destroy"],
    danger: "D",
    // D ⇒ typed-confirm wiring (registry invariant). D7 precedent: REUSE the existing
    // `resource-name` challenge rather than growing the closed `TypedConfirm` union. The operator
    // types the grant's CLIENT display name; the server independently re-verifies it against
    // `GRANT_CONFIRM_FIELD` (PL-13 defence-in-depth).
    confirm: { challenge: "resource-name" },
    outputSchemaId: outputSchemaId("grant", "revoke"),
    examples: ['agkit grant revoke 3a1f2b3c-0000-0000-0000-000000000000 --confirm "agkit CLI"'],
    handler: grantRevoke,
    positional: { key: "id", name: "grant-id" },
    execution: "remote",
    // The wire's emergency door: gating:"direct_confirm" (no plan/apply — a plan can't return the
    // typed-confirm authority), consumed by T-212's runDirectConfirm. `prepare` etag-fetches the
    // row and supplies the confirm authority (the client display name) + the If-Match ETag.
    mutation: { kind: "direct_confirm", prepare: prepareGrantRevoke },
    // A destructive typed-confirm human ceremony — a direct_confirm returns no Plan, so it cannot
    // honestly project as an `agkit_grant_plan`. Reason string byte-identical to the family's four.
    mcpExclude: "destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool",
  }),
];
