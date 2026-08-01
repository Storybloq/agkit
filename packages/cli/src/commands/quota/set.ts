// `quota set [field flags]` args + plan-change builder (T-219; quotas:write, danger PR, wire
// `quotas.upsert` = plan_required — plan→apply is the ONLY write path; the CLI sends no If-Match:
// concurrency is the plan machinery's own read-etag ≡ precondition check, `plan_stale` on drift).
//
// The wire body is ALL-SIX-REQUIRED (closed $def), so this partial-flag grammar READ-MERGE-WRITES
// inside the async builder (D-6): ONE same-family `quotas.get` (quotas:write implies quotas:read —
// the write-implies-read ladder; NEVER a cross-family read) fetches current values; named flags
// override; unnamed members carry the server's own values forward (merge.ts — the pure, tested
// core). r5-3 (presence congruence): `plan.create` REJECTS `action:"update"` on an absent row
// ("target does not exist"), so the builder FORKS on presence — 404 ⇒ `quota:create` (first-time
// configuration; D-6 forces an explicit RPS since it has no legal null; the nullable five default
// to null = deliberately uncapped), present ⇒ `quota:update` (merge). Both CHANGE_TABLE keys
// resolve the same `quotas.upsert` operation, but T-276 SPLIT their executables: create
// dispatches the INSERT-ONLY `quotas#createQuotas`, update keeps `quotas#upsertQuotas`
// (plan-dispatch.ts). Consequence for this grammar: the create arm's insert race is fail-LOUD
// server-side (conflict/already_exists — never a silent overwrite of a row that landed between
// our 404 probe and apply), exactly as `media-quota set` already documents.
//
// Flag values are FORM mirrors of the frozen grammars (int bounds; counter/money regex — the
// issuer-create precedent); the alert≤cap cross-field invariant stays SERVER-side (a 422
// passthrough, never re-implemented client-side — bytes over claims).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { WireProblemError } from "../../core/errors";
import { mergeQuotaBody, COUNTER_STRING_RE, MONEY_STRING_RE } from "./merge";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

const counterFlag = z
  .string()
  .regex(COUNTER_STRING_RE, "must be a non-negative integer string (e.g. 1000000)");
const moneyFlag = z
  .string()
  .regex(MONEY_STRING_RE, 'must be a 2-decimal USD string (e.g. "100.00")');

// The CLI boundary delivers flag values as strings; ONLY the canonical decimal form converts.
// `z.coerce` would launder ""/whitespace/"0x10"/"1e3"/booleans into IN-RANGE numbers — with a
// silently-staged zero-turn cap as the worst case (0 is legal for turns) — so anything
// non-canonical falls through unconverted and FAILS the number check instead.
const CANONICAL_INT_RE = /^(0|[1-9][0-9]*)$/;
const canonicalInt = (v: unknown): unknown =>
  typeof v === "string" && CANONICAL_INT_RE.test(v) ? Number(v) : v;

export const quotaSetArgs = z
  .object({
    "max-requests-per-second-per-user": z
      .preprocess(canonicalInt, z.number().int().min(1).max(1000))
      .optional()
      .describe("Per-user request-rate cap (1..1000; the one member with no uncapped null)."),
    "max-turns-per-day-per-user": z
      .preprocess(canonicalInt, z.number().int().min(0).max(1_000_000))
      .optional()
      .describe("Per-user daily turn cap (0..1000000)."),
    "monthly-token-cap": counterFlag.optional().describe("Project monthly token cap (integer string)."),
    "monthly-spend-cap-usd": moneyFlag.optional().describe('Project monthly spend cap (2-dp USD string, e.g. "100.00").'),
    "max-monthly-spend-per-user-usd": moneyFlag.optional().describe("Per-user monthly spend cap (2-dp USD string)."),
    "monthly-spend-alert-threshold-usd": moneyFlag
      .optional()
      .describe("Alert threshold (2-dp USD string; server enforces threshold <= cap)."),
    confirm: confirmArg,
  })
  .strict()
  .superRefine((val, refCtx) => {
    // ≥1 quota flag: a bare `quota set` has nothing to express (confirm is the ceremony channel).
    const named = Object.entries(val).some(([k, v]) => k !== "confirm" && v !== undefined);
    if (!named) {
      refCtx.addIssue({
        code: "custom",
        message: "nothing to set — pass at least one quota flag (see `agkit quota set --help`)",
      });
    }
  });
export type QuotaSetInput = z.infer<typeof quotaSetArgs>;

/** kebab flag → snake wire member (the six, verbatim). */
const FLAG_TO_MEMBER: Readonly<Record<string, string>> = {
  "max-requests-per-second-per-user": "max_requests_per_second_per_user",
  "max-turns-per-day-per-user": "max_turns_per_day_per_user",
  "monthly-token-cap": "monthly_token_cap",
  "monthly-spend-cap-usd": "monthly_spend_cap_usd",
  "max-monthly-spend-per-user-usd": "max_monthly_spend_per_user_usd",
  "monthly-spend-alert-threshold-usd": "monthly_spend_alert_threshold_usd",
};

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC). Re-parses defensively, reads current
 * state (ONE same-family `quotas.get`), merges, and emits ONE change whose action FORKS on
 * presence (r5-3): absent row ⇒ `create`, present ⇒ `update` — both over the same
 * `quotas.upsert` route path.
 */
export async function quotaSetChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = quotaSetArgs.parse(input);
  const pid = requireProject(ctx);

  const set: Record<string, unknown> = {};
  for (const [flag, member] of Object.entries(FLAG_TO_MEMBER)) {
    const value = (parsed as Record<string, unknown>)[flag];
    if (value !== undefined) set[member] = value;
  }

  let base: unknown | null;
  try {
    base = await ctx.client.request({ operationId: "quotas.get", params: { pid } });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      base = null; // no row yet — first-time configuration (the create arm)
    } else {
      throw err;
    }
  }

  const body = mergeQuotaBody(base, set, []);
  return [
    {
      action: base === null ? "create" : "update",
      resource: "quota",
      path: renderRoutePath("quotas.upsert", { pid }),
      body,
    },
  ];
}
