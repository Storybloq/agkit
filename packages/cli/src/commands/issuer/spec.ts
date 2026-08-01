// `issuer` noun (N-011 A310 → T-212 S7 plan-first retrofit). Exercises the PR
// (prod-rebinding) danger class: a PR command, like a D command, requires typed-confirm
// wiring, and it projects to an MCP plan tool (`agkit_issuer_plan{create}`). S7: the
// spec declares `mutation: {kind:"plan"}` — the dispatch hook runs the FUSED
// plan.create→apply ceremony (the wire route is plan_required: the only legal write path)
// and the shared `planMutationHandler` applies the pass.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { issuerCreateArgs, issuerCreateChanges } from "./create";
import { issuerList, issuerListArgs } from "./list";
import { issuerGet, issuerGetArgs } from "./get";
import { issuerUpdateArgs, issuerUpdateChanges } from "./update";
import { issuerDeleteArgs, issuerDeleteChanges } from "./delete";
import { planMutationHandler } from "../plan/apply";

export const issuerCommands: AnyCommandSpec[] = [
  // T-216 R8: SR read; the route is paginated:false (D7) so there are NO limit/cursor flags.
  defineCommand({
    noun: "issuer",
    verb: "list",
    summary: "List the project's trusted issuers.",
    args: issuerListArgs,
    scopes: ["issuers:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("issuer", "list"),
    examples: ["agkit issuer list"],
    handler: issuerList,
    execution: "remote",
  }),
  // T-216 R9: SR plain read, required-mode positional id.
  defineCommand({
    noun: "issuer",
    verb: "get",
    summary: "Show a trusted issuer.",
    args: issuerGetArgs,
    scopes: ["issuers:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("issuer", "get"),
    examples: ["agkit issuer get iss_123"],
    handler: issuerGet,
    positional: { key: "id", name: "issuer-id" },
    execution: "remote",
  }),
  defineCommand({
    noun: "issuer",
    verb: "create",
    summary: "Add a trusted issuer (prod-rebinding).",
    args: issuerCreateArgs,
    scopes: ["issuers:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("issuer", "create"),
    examples: [
      "agkit issuer create --kind apple --audience api.agkit.cloud",
      "agkit issuer create --kind firebase --firebase-project-id acme-prod",
      "agkit issuer create --kind custom_jwks --issuer https://id.acme.com --audience api.agkit.cloud --jwks-uri https://id.acme.com/.well-known/jwks.json",
    ],
    handler: planMutationHandler,
    // S7: the typed value is the PLAN's confirm_string (shown by the ceremony), no
    // longer the project name — the plan is the displayed authority (L-010).
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: issuerCreateChanges },
    // T-210: LIVE remote command — baseline v1.1.0 surface, no capability gate.
    execution: "remote",
  }),
  // T-216 R10: PR plan-kind CONFIG-ONLY update — NO `--kind` flag exists (R50/FORBIDDEN 2: kind
  // is immutable; `--kind anything` fails the strict zod parse client-side, zero wire calls).
  defineCommand({
    noun: "issuer",
    verb: "update",
    summary: "Update a trusted issuer's config (kind is immutable; prod-rebinding).",
    args: issuerUpdateArgs,
    scopes: ["issuers:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("issuer", "update"),
    examples: ["agkit issuer update iss_123 --audience api.agkit.cloud"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: issuerUpdateChanges },
    positional: { key: "id", name: "issuer-id" },
    execution: "remote",
  }),
  // T-216 R11: wire "PR+D" projects to CLI "PR" (D3 — the max; the decision matrix treats D and
  // PR identically, PR additionally fires the PROD-REBINDING banner). Plan-kind BODYLESS delete
  // (GAP 12); deleting an issuer locks out its live end-users — typed confirm-string ceremony.
  defineCommand({
    noun: "issuer",
    verb: "delete",
    summary: "Delete a trusted issuer (locks out its end-users — destructive, prod-rebinding).",
    args: issuerDeleteArgs,
    scopes: ["issuers:destroy"],
    danger: "PR",
    outputSchemaId: outputSchemaId("issuer", "delete"),
    examples: ["agkit issuer delete iss_123"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: issuerDeleteChanges },
    positional: { key: "id", name: "issuer-id" },
    execution: "remote",
  }),
];
