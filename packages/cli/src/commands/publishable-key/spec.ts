// `publishable-key` noun (T-216; N-011 keys family). Noun alias `pk` — REGISTRY-DECLARED (S1):
// every spec of this noun declares the IDENTICAL `nounAliases: ["pk"]` (a load-check enforces it),
// the shell registers the group under both tokens, `extractPositional` recognizes the alias as the
// path head, and help/reference render it — while MCP/dedup/drift see only the primary noun.
//   - `list`   : SR paginated read, rows masked (`masked_secret` only — server omission) (R5);
//   - `create` : M direct shown-once mint (NON_CEREMONY — plan-incompatible), lands in P4 (R6);
//   - `revoke` : D direct_confirm typed revoke (confirm = key NAME), lands in P5 (R7).
// MCP: `list` folds through the CANONICAL noun fold `publishable-key → key` to `agkit_key_read`
// (D8/S4 — NEVER the derivable `agkit_publishable_key_read`); create/revoke are mcpExclude.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { publishableKeyList, publishableKeyListArgs } from "./list";
import { publishableKeyCreate, publishableKeyCreateArgs } from "./create";
import { publishableKeyRevoke, publishableKeyRevokeArgs, preparePublishableKeyRevoke } from "./revoke";

/** The one declared noun-alias set (S1) — identical on EVERY publishable-key spec. */
export const PUBLISHABLE_KEY_ALIASES = ["pk"] as const;

export const publishableKeyCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "publishable-key",
    verb: "list",
    summary: "List the project's publishable keys (masked; paginated).",
    args: publishableKeyListArgs,
    scopes: ["keys:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("publishable-key", "list"),
    examples: ["agkit publishable-key list", "agkit publishable-key list --limit 50"],
    handler: publishableKeyList,
    nounAliases: PUBLISHABLE_KEY_ALIASES,
    execution: "remote",
  }),
  // T-216 R6: M direct shown-once mint. NON_CEREMONY_REMOTE_MUTATION — a direct mint returns no
  // Plan, so it is plan-INCOMPATIBLE (token-create rationale verbatim) and mcpExclude (cannot
  // honestly project as a plan tool). `--idempotency-key` is the documented safe-retry lever.
  defineCommand({
    noun: "publishable-key",
    verb: "create",
    summary: "Mint a publishable key (the full ak_pk_live_ value is shown once). --idempotency-key <k> for safe retry.",
    args: publishableKeyCreateArgs,
    scopes: ["keys:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("publishable-key", "create"),
    examples: ["agkit publishable-key create --name prod-web"],
    handler: publishableKeyCreate,
    nounAliases: PUBLISHABLE_KEY_ALIASES,
    mcpExclude: "direct shown-once mint returns no Plan (N-011 APX-D); cannot honestly project as a plan tool",
    execution: "remote",
  }),
  // T-216 R7: D direct_confirm typed revoke (confirm = the key NAME; the server re-verifies). The
  // wire route is gating:"direct_confirm" + if_match + idempotency:required — wired through T-212's
  // runDirectConfirm (the token-revoke precedent). Positional id (required mode). mcpExclude (a
  // direct_confirm returns no Plan, so it cannot honestly project as a plan tool).
  defineCommand({
    noun: "publishable-key",
    verb: "revoke",
    summary: "Revoke a publishable key (bricks apps using it — destructive; confirm by name).",
    args: publishableKeyRevokeArgs,
    scopes: ["keys:destroy"],
    danger: "D",
    confirm: { challenge: "resource-name" },
    outputSchemaId: outputSchemaId("publishable-key", "revoke"),
    examples: ["agkit publishable-key revoke pk_123 --confirm prod-web"],
    handler: publishableKeyRevoke,
    nounAliases: PUBLISHABLE_KEY_ALIASES,
    positional: { key: "id", name: "publishable-key-id" },
    mutation: { kind: "direct_confirm", prepare: preparePublishableKeyRevoke },
    mcpExclude: "destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool",
    execution: "remote",
  }),
];
