// `provider-key` noun (T-217, canonical L2-CLI-12; N-011 provider-keys family). A multi-verb noun
// surfaced as `agkit provider-key <list|add|rotate|revoke>` — NOT bare (it carries sibling
// subcommands, command-path.ts:21). Every spec is `execution:"remote"`. The verbs bind the
// `credential.*` wire routes (§0):
//   • list   → credential.list   (provider-keys:read,   SR,   free)            — prefix metadata only
//   • add    → credential.create (provider-keys:write,  M,    direct)          — NON_CEREMONY M-class
//   • rotate → credential.rotate (provider-keys:write,  PR,   plan_required)   — plan-kind ceremony
//   • revoke → credential.revoke (provider-keys:destroy,PR+D, direct_confirm)  — SOFT delete
//
// Secret custody (A5 / R34; T-227 R7): key material NEVER rides argv — on the CLI `add`/`rotate` take
// `--api-key-env <VAR>` (env-name indirection), `--api-key-file <PATH>` (the hardened, inode-bound
// file read), OR a TTY hidden prompt (secret-env.ts). Exactly one of the two flags may be given.
// T-227 S5b: `add`/`rotate` are now EXPOSED over MCP with a `SecretRef`-only secret argument
// (./mcp-surface.ts — the un-exclusion the `SecretRef` mechanism authorized: the old exclusion
// rationale WAS the channel gap that shape closes). `revoke` stays excluded (a typed human confirm
// ceremony returning no plan). `--extra-header` VALUES are elided from every reconstructed
// invocation (elideFlags — §3C); `--endpoint-url` too (RA-1).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { providerKeyList, providerKeyListArgs } from "./list";
import { providerKeyAdd, providerKeyAddArgs } from "./add";
import { providerKeyRotateArgs, providerKeyRotateChanges } from "./rotate";
import { providerKeyRevoke, providerKeyRevokeArgs, prepareProviderKeyRevoke } from "./revoke";
import {
  PROVIDER_KEY_ADD_MCP_EXAMPLE,
  PROVIDER_KEY_ADD_MCP_SUMMARY,
  PROVIDER_KEY_ROTATE_MCP_EXAMPLE,
  PROVIDER_KEY_ROTATE_MCP_SUMMARY,
  providerKeyAddMcpArgs,
  providerKeyAddMcpChanges,
  providerKeyMcpSecret,
  providerKeyRotateMcpArgs,
  providerKeyRotateMcpChanges,
} from "./mcp-surface";
import { planMutationHandler } from "../plan/apply";

/**
 * T-217 (RR-5d / RA-1): custody-elision keys carried by `add` AND `rotate` — the `--extra-header`
 * and `--endpoint-url` VALUES must never reproduce in a reconstructed invocation/replan hint. One
 * const, referenced by both specs (and locked by the step-9 fixture against drift).
 */
export const PROVIDER_KEY_ELIDE_FLAGS: readonly string[] = ["extra-header", "endpoint-url"];

export const providerKeyCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "provider-key",
    verb: "list",
    summary: "List provider credentials for the current project (masked prefix metadata only; never key material).",
    args: providerKeyListArgs,
    scopes: ["provider-keys:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("provider-key", "list"),
    examples: ["agkit provider-key list"],
    handler: providerKeyList,
    execution: "remote",
  }),
  defineCommand({
    noun: "provider-key",
    verb: "add",
    summary:
      "Store a provider credential (secret via --api-key-env <VAR>, --api-key-file <PATH>, or a hidden prompt; never argv). Re-run to add another provider.",
    args: providerKeyAddArgs,
    scopes: ["provider-keys:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("provider-key", "add"),
    examples: [
      "agkit provider-key add --provider example-llm --api-key-env EXAMPLE_LLM_KEY",
      "agkit provider-key add --provider example-llm --api-key-env EXAMPLE_LLM_KEY --endpoint-url https://api.example.com/v1 --auth-style example-style --header-name api-key --extra-header x-title=my-app",
    ],
    handler: providerKeyAdd,
    execution: "remote",
    // A NON_CEREMONY_REMOTE_MUTATION (M/direct) — no plan/apply, no typed-confirm. Registered in
    // NON_CEREMONY_REMOTE_MUTATIONS (registry.ts) so the ceremony load-check exempts it.
    elideFlags: PROVIDER_KEY_ELIDE_FLAGS,
    // T-227 S5b: EXPOSED over MCP with a `SecretRef`-only `api_key` and a PLAN-first write path —
    // the MCP surface has no direct write door, so the `provider_credential:create` CHANGE_TABLE row
    // carries this mutation there while the CLI keeps its ratified M-class direct call.
    mcpSurface: {
      args: providerKeyAddMcpArgs,
      summary: PROVIDER_KEY_ADD_MCP_SUMMARY,
      example: PROVIDER_KEY_ADD_MCP_EXAMPLE,
      secret: providerKeyMcpSecret,
      mutation: { kind: "plan", changes: providerKeyAddMcpChanges },
    },
  }),
  defineCommand({
    noun: "provider-key",
    verb: "rotate",
    summary:
      "Rotate a provider credential to a new key (prod-rebinding; secret via --api-key-env <VAR>, --api-key-file <PATH>, or a hidden prompt).",
    args: providerKeyRotateArgs,
    scopes: ["provider-keys:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("provider-key", "rotate"),
    examples: ["agkit provider-key rotate --provider example-llm --api-key-env EXAMPLE_LLM_KEY"],
    handler: planMutationHandler,
    execution: "remote",
    // The wire route is plan_required — the fused plan.create → PROD-REBINDING render → typed
    // confirm-string ceremony is the only legal write path. The ASYNC builder resolves the secret
    // BEFORE plan.create (§3A.5).
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: providerKeyRotateChanges },
    elideFlags: PROVIDER_KEY_ELIDE_FLAGS,
    // T-227 S5b: EXPOSED over MCP. Same plan door as the CLI (`credential.rotate` is
    // `plan_required` on the wire); only the SECRET's provenance differs — a `SecretRef` the local
    // server resolves process-side instead of an operator-typed flag or hidden prompt.
    mcpSurface: {
      args: providerKeyRotateMcpArgs,
      summary: PROVIDER_KEY_ROTATE_MCP_SUMMARY,
      example: PROVIDER_KEY_ROTATE_MCP_EXAMPLE,
      secret: providerKeyMcpSecret,
      mutation: { kind: "plan", changes: providerKeyRotateMcpChanges },
    },
  }),
  defineCommand({
    noun: "provider-key",
    verb: "revoke",
    summary: "Revoke a provider credential (SOFT delete — stops dispatching immediately; confirm by provider slug).",
    args: providerKeyRevokeArgs,
    scopes: ["provider-keys:destroy"],
    // Wire danger is the compound "PR+D" — the spec records the DOMINANT class (D4:
    // projectWireDanger("PR+D") === "PR"; D and PR are identical in the decision matrix).
    danger: "PR",
    // D7: reuse the existing "resource-name" challenge (no TypedConfirm union growth) — the
    // authority line shows `confirm value: <provider>`.
    confirm: { challenge: "resource-name" },
    outputSchemaId: outputSchemaId("provider-key", "revoke"),
    examples: ["agkit provider-key revoke --provider example-llm --confirm example-llm"],
    handler: providerKeyRevoke,
    execution: "remote",
    // The wire's emergency door: gating:"direct_confirm" (no plan/apply). `prepare` etag-fetches
    // the ACTIVE row and FAILS CLOSED without an ETag (R-H #3).
    mutation: { kind: "direct_confirm", prepare: prepareProviderKeyRevoke },
    mcpExclude: "destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool",
  }),
];
