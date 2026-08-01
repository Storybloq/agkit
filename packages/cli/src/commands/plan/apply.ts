// `plan apply <plan-id>` (T-212 S6) + the SHARED plan-mutation handler every plan-kind
// retrofit (S7) reuses. The handler is a pure client call reading `ctx.ceremony` — the
// dispatch hook (S5b) already ran the full ceremony (fetch/create, render, decide,
// prompt/validate/halt) and threads the resolved pass here:
//   • mode "plan_only" — return the plan as data (--plan-only, exit 0; never applied);
//   • mode "apply"     — send plan.apply with the pass's confirm (when the typed ceremony
//     collected one).
//
// A-1 (ratified; supersedes Open Decision 10): the plan.apply leg ALWAYS auto-generates
// its own Idempotency-Key — a client-wide `--idempotency-key` override NEVER rides it
// (the key is unique per principal; on the fused pair a reused key deterministically
// 422s idempotency_key_conflict, and the standalone leg keeps the ONE documented
// behavior). The override rides plan.create only.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { WireProblemError } from "../../core/errors";
import { decoratePlanApplyError } from "../../core/plan/wire-hints";

export const planApplyArgs = z
  .object({
    id: z.string().min(1).describe("The open plan id to apply."),
    confirm: z.string().optional().describe("The plan's confirm string (required for a D/PR plan non-interactively)."),
  })
  .strict();
export type PlanApplyInput = z.infer<typeof planApplyArgs>;

/**
 * The ONE handler behind every plan-kind mutation (standalone `plan apply` now; the S7
 * retrofits share it). Reads the ceremony pass; never prompts, renders, or decides itself.
 */
export const planMutationHandler: CommandHandler<unknown> = async (ctx) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "plan") {
    throw new Error("agkit: internal — the plan ceremony pass is missing (dispatch hook did not run?)");
  }
  if (pass.mode === "plan_only") {
    return { data: pass.plan };
  }
  try {
    const applied = await ctx.client.request({
      operationId: "plan.apply",
      params: { id: pass.plan.id, ...(pass.confirm !== undefined ? { confirm: pass.confirm } : {}) },
      // A-1/F-A: the internal apply leg never reuses the user's client-wide key.
      idempotency: { ignoreClientOverride: true },
    });
    return { data: applied };
  } catch (err) {
    // T-212 S8 (A-15): THE plan-code catch site — a plan_stale / plan_expired /
    // plan_already_applied / conflict(plan_discarded) apply failure gets the
    // provenance-selected re-plan hint (fused → the exact original invocation;
    // standalone → a generic teachable + `plan show <id>`). Hint metadata only.
    if (err instanceof WireProblemError) decoratePlanApplyError(err, pass.recovery);
    throw err;
  }
};
