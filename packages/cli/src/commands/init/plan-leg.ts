// T-221 — ONE plan leg of the `init` orchestrator: plan.create → gate → render → decide →
// plan.apply, or leave the plan OPEN, or decline + discard.
//
// WHY THIS EXISTS AT ALL (and why it is not a second ceremony): `init` runs MULTIPLE plans in one
// invocation (an account-plane project plan, then a project-plane credential+routes plan) with a
// direct mint and two file writes interleaved. `CommandSpec.mutation` binds a spec to exactly ONE
// plan, and the dispatch hook resolves it BEFORE the handler runs — so an orchestrator cannot
// express itself through it. `init` therefore carries NO `mutation` binding, joins
// `NON_CEREMONY_REMOTE_MUTATIONS`, and drives its legs here.
//
// It is NOT a fork of the ceremony: the SAFETY primitives are the ceremony's own exports —
// `assertPlanApplyable` (the one open-status + expiry gate) and `maxDanger` (the RC-10 floor) —
// plus `narrowPlan` (A-6 fail-closed narrowing), `redact` (the chokepoint) and `renderPlan` (the
// terminal-safe diff). What this module owns is only the DECISION for an orchestrated leg:
//
//   • A typed-confirm plan (D/PR) is NEVER applied without a value the operator typed against the
//     DISPLAYED confirm_string. `--yes` does NOT satisfy a typed confirm (flags.ts:20-21 /
//     ceremony.ts:320-322) — that invariant is load-bearing and is not weakened here: under
//     `--yes` (or any non-interactive run) such a leg resolves `open`, with the plan LEFT OPEN and
//     a runnable apply line, and the caller reports its contents as PENDING.
//   • An M plan applies without a second prompt ONLY when the caller already took the operator's
//     consent for it (`preConsented` — init's CONSENT phase, or `--yes`). Otherwise it prompts
//     y/N, exactly like the M cell.
//   • A decline (y/N no, EOF, or a mismatched typed value) best-effort DISCARDS the plan this leg
//     created — it is init's plan, not the user's — and embeds nothing.
import type { ManagementPlan } from "@agentkit-cloud/shared/wire-contract/management-types.gen";
import type { Ctx, Danger } from "../types";
import { requiresTypedConfirm } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { narrowPlan } from "../../core/plan/types";
import { assertPlanApplyable, maxDanger } from "../../core/plan/ceremony";
import { renderPlan } from "../../core/plan/render";
import { encodeShellCommand } from "../../core/plan/invocation";
import { redact } from "../../core/output/redaction";
import { displaySafe } from "../../core/output/display";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { decoratePlanApplyError } from "../../core/plan/wire-hints";

/** The I/O seams a leg needs. All injected — the leg itself touches no `process`. */
export interface PlanLegDeps {
  readonly ctx: Ctx;
  readonly warn: (message: string) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly promptLine: (question: string) => Promise<string | null>;
  readonly isTTY: boolean;
  readonly now: () => number;
  /** `--yes`: the caller's non-interactive consent. Never satisfies a TYPED confirm. */
  readonly yes: boolean;
}

export type PlanLegOutcome =
  /** Applied. `response` is the server's apply result. */
  | { readonly kind: "applied"; readonly planId: string; readonly response: unknown }
  /**
   * Created and LEFT OPEN — nothing in it landed. Everything the plan contains must be reported
   * PENDING (never "created"), and the run is a partial (exit 3).
   */
  | {
      readonly kind: "open";
      readonly planId: string;
      readonly danger: Danger;
      readonly plan: ManagementPlan;
      readonly applyCommand: string;
      /** The read-before-apply step: renders the plan's diff + confirm string live. */
      readonly showCommand: string;
      readonly reason: string;
    }
  /** Declined by the operator. Nothing landed; the plan was best-effort discarded. */
  | { readonly kind: "declined"; readonly planId: string; readonly discarded: boolean };

export interface PlanLegInput {
  /** The `plan.create` note. A STATIC label — it must never carry a user value or a secret. */
  readonly note: string;
  readonly changes: readonly PlanChange[];
  /** The operator already consented to this leg (init's CONSENT phase, or `--yes`). M only. */
  readonly preConsented: boolean;
  /** The spec-side danger floor for this leg (RC-10): the plan's own danger can only raise it. */
  readonly floor: Danger;
}

const NARROW_FAIL_DETAIL =
  "the management API returned a plan that could not be classified — refusing to proceed (server protocol error, not a request you can fix)";

/**
 * The runnable line that applies a left-open plan — the REAL `plan apply` verb (there is no
 * top-level `apply` command). The `<confirm-string>` placeholder is the house pattern
 * (invocation.ts — reconstructed lines NEVER embed the live confirm value: the operator must
 * read the plan first, which is exactly why `--yes` never satisfies a typed confirm), so the
 * handoff pairs it with `showCommandFor` below.
 */
export function applyCommandFor(planId: string, danger: Danger): string {
  const tokens = ["plan", "apply", planId, "--yes"];
  if (requiresTypedConfirm(danger)) tokens.push("--confirm", "<confirm-string>");
  return encodeShellCommand(tokens);
}

/** The line that RENDERS a left-open plan (diff + confirm string) — the read-before-apply step. */
export function showCommandFor(planId: string): string {
  return encodeShellCommand(["plan", "show", planId]);
}

/** Best-effort discard of a plan THIS leg created. Never masks the decline outcome. */
async function discard(deps: PlanLegDeps, id: string): Promise<boolean> {
  try {
    await deps.ctx.client.request({
      operationId: "plan.discard",
      params: { id },
      // The internal write never reuses the caller's `--idempotency-key` (unique per principal).
      idempotency: { ignoreClientOverride: true },
    });
    return true;
  } catch {
    deps.warn("note: could not discard the plan; it will expire on the server TTL.\n");
    return false;
  }
}

/** Send `plan.apply`, decorating a plan_stale/expired/applied failure with the re-plan hint. */
async function apply(deps: PlanLegDeps, planId: string, confirm: string | undefined): Promise<unknown> {
  try {
    return await deps.ctx.client.request({
      operationId: "plan.apply",
      params: { id: planId, ...(confirm !== undefined ? { confirm } : {}) },
      idempotency: { ignoreClientOverride: true },
    });
  } catch (err) {
    if (err instanceof WireProblemError) {
      decoratePlanApplyError(err, { source: "standalone", planId });
    }
    throw err;
  }
}

/**
 * Run one plan leg. Creates the plan, runs the SHARED applyable gate, then decides.
 * Zero writes happen on any refusal path other than the best-effort discard.
 */
export async function runPlanLeg(deps: PlanLegDeps, input: PlanLegInput): Promise<PlanLegOutcome> {
  const created = await deps.ctx.client.request({
    operationId: "plan.create",
    params: { note: input.note, changes: input.changes },
  });
  const narrowed = narrowPlan(redact(created));
  if (!narrowed.ok) {
    throw new CliLocalError("usage_error", { detail: `${NARROW_FAIL_DETAIL} [${displaySafe(narrowed.reason)}]` });
  }
  const plan = narrowed.plan;
  // F-B6/A-7: the ONE gate — a non-open or already-expired plan is terminal BEFORE any render.
  assertPlanApplyable(plan, deps.now());
  const danger = maxDanger(input.floor, plan.danger);
  const applyCommand = applyCommandFor(plan.id, danger);
  const showCommand = showCommandFor(plan.id);

  // A typed-confirm leg: the DISPLAYED confirm_string is the only authority, so a run with no
  // interactive channel (non-TTY, or `--yes` — which never satisfies a typed confirm) leaves the
  // plan open rather than applying it.
  if (requiresTypedConfirm(danger)) {
    if (!deps.isTTY || deps.yes) {
      return {
        kind: "open",
        planId: plan.id,
        danger,
        plan: plan.raw,
        applyCommand,
        showCommand,
        reason: deps.yes
          ? "--yes never satisfies a typed confirm: this plan is destructive or prod-rebinding, so it was left OPEN and nothing in it was applied"
          : "this terminal is non-interactive and this plan needs a typed confirm, so it was left OPEN and nothing in it was applied",
      };
    }
    deps.warn(renderPlan(plan, { now: deps.now(), effectiveDanger: danger }));
    const typed = await deps.promptLine("type the confirm string exactly to proceed: ");
    // L-010: a null confirm_string can NEVER match (so nothing proceeds); EOF/Ctrl-C is a decline.
    if (typed === null || plan.confirmString === null || typed !== plan.confirmString) {
      return { kind: "declined", planId: plan.id, discarded: await discard(deps, plan.id) };
    }
    return { kind: "applied", planId: plan.id, response: await apply(deps, plan.id, typed) };
  }

  // The M cell.
  if (input.preConsented || deps.yes) {
    return { kind: "applied", planId: plan.id, response: await apply(deps, plan.id, undefined) };
  }
  if (!deps.isTTY) {
    return {
      kind: "open",
      planId: plan.id,
      danger,
      plan: plan.raw,
      applyCommand,
      showCommand,
      reason: "this terminal is non-interactive, so the plan was left OPEN and nothing in it was applied",
    };
  }
  deps.warn(renderPlan(plan, { now: deps.now(), effectiveDanger: danger }));
  if (!(await deps.confirm(`Apply this ${danger} plan? [y/N] `))) {
    return { kind: "declined", planId: plan.id, discarded: await discard(deps, plan.id) };
  }
  return { kind: "applied", planId: plan.id, response: await apply(deps, plan.id, undefined) };
}
