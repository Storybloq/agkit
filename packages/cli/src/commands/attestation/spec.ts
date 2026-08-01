// `attestation` noun (T-216; noun RATIFIED by R-G — 2-token project-scoped convention like
// issuer/token). App Attest configuration lives ON the project resource (no dedicated wire route):
//   - `get` : SR read over `project.get`, projecting the attestation members (R3);
//   - `set` : M plan-kind mutation over the executable `project:update` CHANGE_TABLE entry (R4) —
//     lands with the plan-kind wave (P3).
// The route row (project.update: danger M, gating direct) is AUTHORITATIVE over the ticket's
// "(PR)" prose (discrepancy D1): `set` binds M/direct; if a server plan ever comes back hotter the
// ceremony's danger-flooring renders reality.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { attestationGet, attestationGetArgs } from "./get";
import { attestationSetArgs, attestationSetChanges } from "./set";
import { planMutationHandler } from "../plan/apply";

export const attestationCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "attestation",
    verb: "get",
    summary: "Show the project's App Attest configuration.",
    args: attestationGetArgs,
    scopes: ["projects:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("attestation", "get"),
    examples: ["agkit attestation get"],
    handler: attestationGet,
    execution: "remote",
  }),
  // T-216 R4: M plan-kind over `project:update` (D1 — the route row's M/direct is authoritative
  // over the ticket's "(PR)"; if a server plan comes back hotter, ceremony danger-flooring renders
  // reality). `--clear` ⇒ app_attest_app_id:null (null CLEARS, fail-closed).
  defineCommand({
    noun: "attestation",
    verb: "set",
    summary: "Set or clear the project's App Attest configuration.",
    args: attestationSetArgs,
    scopes: ["projects:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("attestation", "set"),
    examples: [
      "agkit attestation set --app-attest-app-id TEAM1.com.acme.app --environment production",
      "agkit attestation set --clear",
    ],
    handler: planMutationHandler,
    mutation: { kind: "plan", changes: attestationSetChanges },
    execution: "remote",
  }),
];
