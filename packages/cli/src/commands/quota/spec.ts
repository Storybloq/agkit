// `quota` noun (T-219; N-011 C10 — the agent-plane usage quotas, project-singleton). One SR read
// (`quotas.get`) + TWO PR plan-kind verbs over the ONE `quotas.upsert` route (upsert-only, C10 —
// no delete verb exists on the wire): `set` overrides named members, `clear` nulls named members
// (null = deliberately uncapped). Both run the fused plan.create→apply ceremony (the wire route is
// plan_required — the only legal write path). Partial-flag grammar over the all-six-required body =
// the read-merge-write builders (set.ts/clear.ts + the pure merge.ts core).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { quotaGet, quotaGetArgs } from "./get";
import { quotaSetArgs, quotaSetChanges } from "./set";
import { quotaClearArgs, quotaClearChanges } from "./clear";
import { planMutationHandler } from "../plan/apply";

export const quotaCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "quota",
    verb: "get",
    summary: "Show the project's usage quotas (caps + current usage).",
    args: quotaGetArgs,
    scopes: ["quotas:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("quota", "get"),
    examples: ["agkit quota get"],
    handler: quotaGet,
    execution: "remote",
  }),
  defineCommand({
    noun: "quota",
    verb: "set",
    summary: "Set usage-quota caps (named members only; the others keep their current values).",
    args: quotaSetArgs,
    scopes: ["quotas:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("quota", "set"),
    examples: ["agkit quota set --max-requests-per-second-per-user 10 --monthly-spend-cap-usd 100.00"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: quotaSetChanges },
    execution: "remote",
  }),
  defineCommand({
    noun: "quota",
    verb: "clear",
    summary: "Clear named quota caps to uncapped (null); other members keep their current values.",
    args: quotaClearArgs,
    scopes: ["quotas:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("quota", "clear"),
    examples: ["agkit quota clear --fields monthly_token_cap"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: quotaClearChanges },
    execution: "remote",
  }),
];
