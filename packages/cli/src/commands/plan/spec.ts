// `plan` noun (T-212 S6, Design (d)) — the plan/apply command surface over the frozen
// plans routes (family "plans", scope plans:read; plan.apply evaluates the union of the
// contained changes' WRITE scopes server-side at apply time — `["plans:read"]` here is
// the honest STATIC floor, documented per ratified decision 6).
//
// MCP projection: `plan list`/`plan show` fold to `agkit_plan_read`; `plan discard` and
// `plan apply` are `mcpExclude` — the MCP surface exposes them as the FIXED tools
// `agkit_plan_discard` and the single gated executor `agkit_apply`, contributed by L3-M1
// (mcp-metadata.ts header rule: they are deliberately NOT verb-folded resource tools).
//
// Top-level `agkit apply <plan-id>` is a build-cli surface ALIAS onto the ONE
// `plan apply` registry citizen (TOP_LEVEL_VERB_ALIASES) — the confirmation_required
// hint line `agkit apply <plan-id> --yes` is runnable verbatim.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { planList, planListArgs } from "./list";
import { planShow, planShowArgs } from "./show";
import { planDiscard, planDiscardArgs } from "./discard";
import { planApplyArgs, planMutationHandler } from "./apply";

export const planCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "plan",
    verb: "list",
    summary: "List plans (most recent first).",
    args: planListArgs,
    scopes: ["plans:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("plan", "list"),
    examples: ["agkit plan list", "agkit plan list --limit 50"],
    handler: planList,
    execution: "remote",
  }),
  defineCommand({
    noun: "plan",
    verb: "show",
    summary: "Show a plan (its diff, danger, confirm string, and expiry).",
    args: planShowArgs,
    scopes: ["plans:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("plan", "show"),
    examples: ["agkit plan show plan_123"],
    handler: planShow,
    positional: { key: "id", name: "plan-id" },
    execution: "remote",
  }),
  defineCommand({
    noun: "plan",
    verb: "discard",
    summary: "Discard an open plan (zero side effects on managed state).",
    args: planDiscardArgs,
    scopes: ["plans:read"],
    danger: "M",
    outputSchemaId: outputSchemaId("plan", "discard"),
    examples: ["agkit plan discard plan_123"],
    handler: planDiscard,
    positional: { key: "id", name: "plan-id" },
    execution: "remote",
    // Fixed MCP tool `agkit_plan_discard` is contributed by L3-M1, never verb-folded here.
    mcpExclude: "fixed MCP tool agkit_plan_discard is contributed by L3-M1 (APX-D: not a verb-folded resource tool)",
  }),
  defineCommand({
    noun: "plan",
    verb: "apply",
    summary:
      "Apply an open plan (the gated executor; the server enforces the contained changes' write scopes at apply time).",
    args: planApplyArgs,
    scopes: ["plans:read"],
    // The static MAXIMUM of the route's `inherits_max_danger` — honest ticket-D4 labeling;
    // the ceremony floors the EFFECTIVE danger at M and uses the fetched plan's real danger.
    danger: "PR",
    outputSchemaId: outputSchemaId("plan", "apply"),
    examples: ["agkit plan apply plan_123", "agkit apply plan_123"],
    handler: planMutationHandler,
    positional: { key: "id", name: "plan-id" },
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "apply" },
    execution: "remote",
    // The single gated MCP executor `agkit_apply` is contributed by L3-M1 (fixed tool).
    mcpExclude: "the single gated MCP executor agkit_apply is contributed by L3-M1 (APX-D: not a verb-folded resource tool)",
  }),
];
