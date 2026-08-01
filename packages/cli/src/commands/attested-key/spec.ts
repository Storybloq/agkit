// `attested-key` noun (T-214 L2-CLI-16, CLI-31 NEW-SURFACE). A MULTI-VERB noun surfaced as
// `agkit attested-key <list|revoke>` — `list` (step 7) is an attest:read SR remote paginated read;
// `revoke` (step 9) is a direct_confirm DESTRUCTIVE op (attest:destroy, danger D, PL-13) consuming
// T-212's confirmation-matrix seam. Because the noun now carries a sibling subcommand it is NO LONGER
// surfaced BARE (the C-6 singleton-read rule no longer applies) — both verbs render with their verb.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { attestedKeyList, attestedKeyListArgs } from "./list";
import { attestedKeyRevoke, attestedKeyRevokeArgs, prepareAttestedKeyRevoke } from "./revoke";

export const attestedKeyCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "attested-key",
    verb: "list",
    summary: "List the project's attested keys (paginated).",
    args: attestedKeyListArgs,
    scopes: ["attest:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("attested-key", "list"),
    // The noun is now MULTI-VERB (list|revoke), so it surfaces as `agkit attested-key list` (NOT
    // bare) — the examples are authored in the `agkit attested-key list …` form to match.
    examples: [
      "agkit attested-key list",
      "agkit attested-key list --user-hash 0000000000000000000000000000000000000000000000000000000000000000",
    ],
    handler: attestedKeyList,
    execution: "remote",
  }),
  defineCommand({
    noun: "attested-key",
    verb: "revoke",
    summary: "Revoke an attested device key by row id (destructive; confirm by the Apple App Attest key_id).",
    args: attestedKeyRevokeArgs,
    scopes: ["attest:destroy"],
    danger: "D",
    // D ⇒ typed-confirm wiring (registry invariant): the operator confirms the key's Apple App Attest
    // key_id (a device key has no NAME — the key_id is its stable operator-visible identifier); the
    // server independently re-verifies `{confirm}` == key_id (PL-13 defence-in-depth).
    confirm: { challenge: "key-id" },
    outputSchemaId: outputSchemaId("attested-key", "revoke"),
    // RC-6: the runnable hint FORM is `--id <uuid> --yes --confirm <key-id>`, but the SPEC example
    // omits `--yes` (a global ceremony flag absent from the strict args schema — every example is
    // parsed against `args` at registry load, exactly as token revoke's example omits it). The
    // confirm value is a PLACEHOLDER, never a real key_id/secret.
    examples: [
      "agkit attested-key revoke --id 1a2b3c4d-0000-4000-a000-000000000001 --confirm <key-id>",
    ],
    handler: attestedKeyRevoke,
    execution: "remote",
    // The wire's emergency door: gating:"direct_confirm" (no plan/apply — a plan can't return the
    // typed-confirm authority), consumed by T-212's runDirectConfirm. `prepare` (no prefix
    // resolution) finds the row's etag + key_id, or uses --if-match to skip the lookup.
    mutation: { kind: "direct_confirm", prepare: prepareAttestedKeyRevoke },
    // A destructive typed-confirm human ceremony — like the shown-once mint, it is NOT an MCP tool
    // (a direct_confirm returns no Plan, so it cannot honestly project as an `agkit_attested_key_plan`).
    mcpExclude: "destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool",
  }),
];
