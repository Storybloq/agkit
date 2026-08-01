// The mutation-ceremony orchestrator (T-212 S5a + review round, canonical L2-CLI-08). This is
// the ONE place that turns a mutating command into a `CeremonyPass` (which the handler applies)
// or a teachable throw — the shell's dispatch hook (build-cli runSpec, S5b) calls it BETWEEN the
// capability gate and the handler, and threads the result onto `ctx.ceremony`. It owns ALL
// ceremony I/O (plan.create / plan.get / plan.discard, the redacted stderr render, the y/N +
// typed prompts); the decision itself is delegated to the single pure spine `decideCeremony`
// (decision.ts) so a wrong cell can exist in exactly one auditable place.
//
// Three paths (MutationBinding.kind):
//   • plan          — FUSED create+apply: plan.create, render, decide, then a pass the handler
//                     applies (or a plan_only emit / a decline that DISCARDS the just-made plan).
//   • apply         — STANDALONE: plan.get an existing plan, decide, pass. A decline NEVER
//                     discards the user's pre-existing plan.
//   • direct_confirm — the T-213/T-214 emergency door (no plan): `prepare` ONCE (RC-8), an RC-2
//                     LOCAL mismatch check when the expected value is known (else forward verbatim
//                     and let the server verify), then a `{confirm, ifMatch}` pass. Zero writes on
//                     any refusal.
//
// Safety invariants (asserted end-to-end in ceremony.test.ts):
//   • F-G3: statically-invalid flag combos reject BEFORE any wire call; the danger-dependent
//     reject (M + --confirm) best-effort discards the fused plan first.
//   • F-B6/A-7: ONE shared gate (`assertPlanApplyable`) refuses a non-open or expired plan —
//     from plan.create AND plan.get — BEFORE any render or prompt.
//   • F-E2: a typed-confirm action against a null confirm_string is terminal BEFORE any prompt
//     (an unwinnable prompt is the same refusal, dishonestly delivered); `confirmMatches` keeps
//     the null-never-matches backstop.
//   • A non-TTY HALT keeps the plan open (no discard) and EMBEDS it with a full runnable hint
//     (RC-6); an interactive DECLINE or a wrong typed value — TTY or non-TTY (the pinned
//     rejected-finding behavior) — DISCARDS the fused plan and embeds NOTHING (A-8).
//   • RC-12: every reconstructed hint/note comes from the ONE argv encoder with confirm values
//     as placeholders; F-G4: a rejection hint never reproduces the offending flag.
//   • F-D3/F-E3 (direct_confirm): the preview renders redacted + terminal-safe; a known
//     expectedConfirm MUST appear in the preview (display-is-authority) or the ceremony refuses.
//   • T-226 D0-h: every refusal names its cause from a TYPED closed vocabulary
//     (`ConfirmationRequiredError.reason`, `challenge.expected` on a mismatch) so a programmatic
//     consumer never parses English `detail` prose; and `assertRawConfirmAuthority` judges the
//     server's `confirm_string` on the RAW bytes at BOTH plan intakes — before `redact()` can mask
//     the very value the operator must type back.
import type {
  AnyCommandSpec,
  Ctx,
  CeremonyPass,
  CeremonyRecovery,
  Danger,
  PlanMutation,
  DirectConfirmMutation,
  DirectConfirmPrepared,
  DirectMutation,
} from "../../commands/types";
import { requiresTypedConfirm } from "../../commands/types";
import type { ManagementPlan } from "@agentkit-cloud/shared/wire-contract/management-types.gen";
import { CliLocalError } from "../errors";
import { redact } from "../output/redaction";
import { displaySafe } from "../output/display";
import { assertDisplayAuthority, assertRawConfirmAuthority } from "./confirm-authority";
import { decideCeremony, type CeremonyAction, type HaltNeed, type RejectReason } from "./decision";
import { frozenTimestampMs, narrowPlan, type NarrowedPlan } from "./types";
import { renderPlan } from "./render";
import { encodeShellCommand, reconstructInvocation, toInvocationTokens } from "./invocation";
// The two no-plan doors' PURE leaves (render / encode / pass construction). Split out when this
// file crossed the T-204 800-line cap; the edge is one-directional by design (see direct-render.ts).
import {
  DIRECT_MISMATCH_DETAIL,
  HALT_DETAIL_DIRECT_M,
  confirmChallengeLabel,
  directMRetryHint,
  directPass,
  directRetryHint,
  renderPreview,
} from "./direct-render";

/**
 * The I/O seams the ceremony needs, injected by the dispatch hook (S5b) from ShellDeps + runtime.
 * The management client is `ctx.client`; the ceremony flags (--yes / --plan-only) are
 * `ctx.clientFlags`. Every field here is a deterministic seam so the orchestrator is unit-testable.
 */
export interface CeremonyDeps {
  /** Interactive y/N for an M-class apply. Resolves false on decline / EOF (A-10). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Typed-line reader for a D/PR confirm challenge. Resolves null on non-TTY / EOF (A-10). */
  readonly promptLine: (question: string) => Promise<string | null>;
  /** Interactive terminal on stdin — gates prompt vs halt. */
  readonly isTTY: boolean;
  /** Injected wall clock (ms) for the expiry short-circuit (A-7/F-F2). */
  readonly now: () => number;
  /** Best-effort stderr sink for the redacted plan render + notices. MUST NOT throw. */
  readonly warn: (message: string) => void;
}

/**
 * T-226 D0-h(a): the TYPED cause of a `confirmation_required` refusal. A programmatic consumer
 * (the MCP adapter) must map an outcome WITHOUT parsing English `detail` prose — so every throw
 * site names its cause from this closed vocabulary. It is LOSSLESS over `HaltNeed`
 * (`confirm_and_yes` has its own member, R3-F3), and additive: no render, no envelope member and
 * no exit code reads it.
 */
export type ConfirmationReason =
  | "missing_confirm"
  | "missing_yes"
  | "missing_confirm_and_yes"
  | "confirm_mismatch"
  | "declined";

/** `HaltNeed` → reason, VERBATIM (one member each — a halt never loses which gate is missing). */
const HALT_REASON: Record<HaltNeed, ConfirmationReason> = {
  yes: "missing_yes",
  confirm: "missing_confirm",
  confirm_and_yes: "missing_confirm_and_yes",
};

/**
 * A `confirmation_required` refusal (T-212). A CliLocalError subclass so the dispatcher renders it
 * with no shell change (classify.ts folds any CliLocalError). A non-TTY HALT carries the plan in
 * `extra.plan` (embedded, chokepoint-redacted on emit); an interactive DECLINE / typed-mismatch
 * carries NO plan (A-8: the plan was discarded — embedding it would be misleading).
 *
 * T-226 D0-h: `reason` and `challenge` are ADDITIVE fields on the thrown object only. They are not
 * passed to `CliLocalError`'s `extra`, so no envelope byte, no rendered line and no exit code
 * changes — a programmatic caller that holds the error reads them, everything else sees T-212.
 */
export class ConfirmationRequiredError extends CliLocalError {
  override name = "ConfirmationRequiredError";
  /** The typed cause (D0-h). Undefined only on a throw site that predates the contract. */
  readonly reason?: ConfirmationReason;
  /**
   * D0-h(d): on a `confirm_mismatch`, the value the operator was supposed to type. Safe by
   * construction — it is the plan's own confirm string, which passed the RAW-boundary display
   * authority gate (`assertRawConfirmAuthority`) before this plan was ever narrowed or rendered.
   */
  readonly challenge?: { readonly expected: string };
  constructor(opts: {
    detail: string;
    hint: string;
    plan?: ManagementPlan;
    reason?: ConfirmationReason;
    challenge?: { readonly expected: string };
  }) {
    super("confirmation_required", {
      detail: opts.detail,
      message: opts.detail,
      hint: opts.hint,
      extra: opts.plan !== undefined ? { plan: opts.plan } : undefined,
    });
    this.reason = opts.reason;
    this.challenge = opts.challenge;
  }
}

// ── danger ordering (RC-10 flooring) ─────────────────────────────────────────────
const DANGER_ORDER: Record<Danger, number> = { SR: 0, M: 1, D: 2, PR: 3 };
/**
 * The RC-10 danger floor. EXPORTED (T-221) so the `init` orchestrator — which drives its plan
 * ceremonies inside its handler, having no single `mutation` binding to hang on the dispatch
 * hook — floors its plans against the SAME ordering this module does, instead of re-deriving one.
 * Pure; no behavior change here.
 */
export function maxDanger(a: Danger, b: Danger): Danger {
  return DANGER_ORDER[a] >= DANGER_ORDER[b] ? a : b;
}

// ── the resolved per-invocation ceremony flags ───────────────────────────────────
interface CeremonyFlags {
  readonly yes: boolean;
  readonly planOnly: boolean;
  readonly confirmValue: string | undefined;
}

/** Read the per-spec `--confirm <value>` from the parsed input (the typed-confirm channel). */
function readConfirm(input: unknown): string | undefined {
  if (input !== null && typeof input === "object") {
    const value = (input as Record<string, unknown>).confirm;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Read the plan id an apply-kind operates on (the positional). The zod parse guarantees it. */
function readPlanId(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const id = (input as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  throw new CliLocalError("usage_error", { detail: "a plan id is required", hint: "agkit apply <plan-id>" });
}

/**
 * F-G3: the STATICALLY-decidable reject cells (no plan needed — kind and flags alone), ruled on
 * BEFORE any wire call. Mirrors the decision table's plan-only precedence rows exactly; the one
 * danger-DEPENDENT reject (confirm_without_typed_danger) stays post-create in `actOnPlan`.
 */
function staticRejectReason(
  kind: "plan" | "apply" | "direct_confirm" | "direct",
  flags: CeremonyFlags,
): RejectReason | null {
  if (!flags.planOnly) return null;
  if (kind === "direct_confirm") return "plan_only_on_direct_confirm";
  // T-215: an M-direct op is not plannable — the reject fires FIRST (before confirm/yes), mirroring
  // the decision spine's plan-only precedence for direct.
  if (kind === "direct") return "plan_only_on_direct";
  if (kind === "apply") return "plan_only_on_apply";
  if (flags.confirmValue !== undefined) return "plan_only_with_confirm";
  if (flags.yes) return "plan_only_with_yes";
  return null;
}

/**
 * The ceremony entrypoint. Resolves the mutation to a `CeremonyPass` or throws a teachable error.
 * Never applies a write itself — a `mode:"apply"` pass hands the plan to the handler, which sends
 * `plan.apply` (A-1: its idempotency key is auto-generated; the override rode plan.create only).
 */
export async function runMutationCeremony(
  spec: AnyCommandSpec,
  ctx: Ctx,
  input: unknown,
  deps: CeremonyDeps,
): Promise<CeremonyPass> {
  const binding = spec.mutation;
  if (!binding) {
    throw new Error("agkit: internal — runMutationCeremony called on a spec without a mutation binding");
  }
  const flags: CeremonyFlags = {
    yes: ctx.clientFlags?.yes === true,
    planOnly: ctx.clientFlags?.planOnly === true,
    confirmValue: readConfirm(input),
  };
  // F-G3: rule on the statically-invalid combos BEFORE any wire call or prepare read.
  const staticReason = staticRejectReason(binding.kind, flags);
  if (staticReason !== null) throw rejectUsageError(staticReason, spec, input);

  switch (binding.kind) {
    case "plan":
      return runPlan(spec, binding, ctx, input, deps, flags);
    case "apply":
      return runApply(spec, ctx, input, deps, flags);
    case "direct_confirm":
      return runDirectConfirm(spec, binding, ctx, input, deps, flags);
    case "direct":
      return runDirect(spec, binding, ctx, input, deps, flags);
  }
}

// ══ plan-kind (fused create + apply) ═════════════════════════════════════════════
async function runPlan(
  spec: AnyCommandSpec,
  binding: PlanMutation,
  ctx: Ctx,
  input: unknown,
  deps: CeremonyDeps,
  flags: CeremonyFlags,
): Promise<CeremonyPass> {
  // T-217 (R-D): `changes` may be async (rotate awaits the echo-off secret prompt BEFORE any
  // network write) — the ONE call site awaits; sync builders resolve identically.
  const changes = await binding.changes(input, ctx);
  // RC-12: the note is reconstructed from PARSED input via the ONE encoder — confirm/secret channels
  // are placeholders, transport globals never reproduce. A-1: the --idempotency-key override (applied
  // by the client) rides THIS plan.create only; the handler's plan.apply auto-generates its own.
  const note = reconstructInvocation(spec, input);
  const created = await ctx.client.request({ operationId: "plan.create", params: { note, changes } });
  // D0-h(c): the confirm-string authority is judged on the RAW bytes, BEFORE the chokepoint masks
  // them — a masked value could never be typed back.
  assertRawConfirmAuthority(created);
  const narrowed = narrowPlan(redact(created));
  if (!narrowed.ok) throw narrowFailError(narrowed.reason, narrowed.detail, spec, input);
  const plan = narrowed.plan;
  // F-B6: the SAME open-status + expiry gate the apply path runs — a plan.create response that is
  // non-open or already expired is terminal, never rendered or prompted.
  assertPlanApplyable(plan, deps.now());
  const effectiveDanger = maxDanger(spec.danger, plan.danger); // RC-10: spec static danger is the floor
  const action = decideCeremony({
    kind: "plan",
    danger: effectiveDanger,
    tty: deps.isTTY,
    yes: flags.yes,
    planOnly: flags.planOnly,
    confirmProvided: flags.confirmValue !== undefined,
  });
  return actOnPlan(action, {
    spec,
    ctx,
    input,
    deps,
    plan,
    effectiveDanger,
    confirmValue: flags.confirmValue,
    recovery: { source: "fused", replanArgv: toInvocationTokens(spec, input) },
    discardOnDecline: true,
  });
}

// ══ apply-kind (standalone apply of an existing plan) ════════════════════════════
async function runApply(
  spec: AnyCommandSpec,
  ctx: Ctx,
  input: unknown,
  deps: CeremonyDeps,
  flags: CeremonyFlags,
): Promise<CeremonyPass> {
  const id = readPlanId(input);
  const fetched = await ctx.client.request({ operationId: "plan.get", params: { id } });
  // D0-h(c): same RAW-boundary gate as the fused path — a fetched plan is no more trusted.
  assertRawConfirmAuthority(fetched);
  const narrowed = narrowPlan(redact(fetched));
  if (!narrowed.ok) throw narrowFailError(narrowed.reason, narrowed.detail, spec, input);
  const plan = narrowed.plan;
  // A-7/F-B6: a non-open or locally-expired plan short-circuits BEFORE any prompt — never applied.
  assertPlanApplyable(plan, deps.now());
  const effectiveDanger = maxDanger("M", plan.danger); // RC-10: apply-kind floors at M
  const action = decideCeremony({
    kind: "apply",
    danger: effectiveDanger,
    tty: deps.isTTY,
    yes: flags.yes,
    planOnly: flags.planOnly,
    confirmProvided: flags.confirmValue !== undefined,
  });
  return actOnPlan(action, {
    spec,
    ctx,
    input,
    deps,
    plan,
    effectiveDanger,
    confirmValue: flags.confirmValue,
    recovery: { source: "standalone", planId: id },
    discardOnDecline: false, // the pre-existing plan is the user's — a decline never auto-discards it
  });
}

/**
 * T-226 D0-h follow-up: the TYPED terminal-plan refusal. `assertPlanApplyable` is the only local
 * site that knows WHY a plan can never apply (already applied/discarded, or past `expires_at`),
 * and the MCP `[plan_stale]` leg must map that outcome without parsing English detail prose — the
 * same rule `ConfirmationRequiredError.reason` exists for. Additive on the thrown object only:
 * the super call is byte-for-byte `terminalPlanError`'s, so classify.ts, the render and the exit
 * code are unchanged.
 */
export type TerminalPlanState = Exclude<NarrowedPlan["status"], "open">;

export class TerminalPlanError extends CliLocalError {
  override name = "TerminalPlanError";
  /** Why the plan is terminal. `expired` covers BOTH the status and the local `expires_at` gate. */
  readonly planState: TerminalPlanState;
  constructor(opts: { detail: string; planId: string; planState: TerminalPlanState }) {
    super("usage_error", { detail: opts.detail, hint: encodeShellCommand(["plan", "show", opts.planId]) });
    this.planState = opts.planState;
  }
}

/**
 * F-B6/A-7: the ONE open-status + expiry gate, run on EVERY narrowed plan (created or fetched)
 * BEFORE any render, prompt, or decision act. `expires_at <= now` is expired (exact boundary).
 *
 * EXPORTED (T-221) so the `init` orchestrator's in-handler plan legs run THIS gate rather than a
 * second copy — "one auditable place" is the whole point of the gate. Pure; no behavior change.
 */
export function assertPlanApplyable(plan: NarrowedPlan, now: number): void {
  if (plan.status !== "open") {
    throw new TerminalPlanError({
      detail: `this plan is ${plan.status}, not open — it cannot be applied`,
      planId: plan.id,
      planState: plan.status,
    });
  }
  if (isExpired(plan, now)) {
    throw new TerminalPlanError({
      detail: "this plan has expired — it can no longer be applied",
      planId: plan.id,
      planState: "expired",
    });
  }
}

// ── shared plan/apply action dispatch ────────────────────────────────────────────
interface PlanDispatch {
  readonly spec: AnyCommandSpec;
  readonly ctx: Ctx;
  readonly input: unknown;
  readonly deps: CeremonyDeps;
  readonly plan: NarrowedPlan;
  readonly effectiveDanger: Danger;
  readonly confirmValue: string | undefined;
  readonly recovery: CeremonyRecovery;
  readonly discardOnDecline: boolean;
}

async function actOnPlan(action: CeremonyAction, d: PlanDispatch): Promise<CeremonyPass> {
  const { deps, plan } = d;
  // F-G3: the one reject still reachable here is danger-DEPENDENT (confirm_without_typed_danger —
  // it needed the plan's danger; the static combos rejected before plan.create). Best-effort
  // discard the fresh fused plan before teaching; a standalone apply never discards the user's.
  if (action.kind === "reject_usage") {
    if (d.discardOnDecline) await discardPlan(d.ctx, deps, plan.id);
    throw rejectUsageError(action.reason, d.spec, d.input);
  }
  // F-E2 (orchestrator ruling, refining L-010): a typed-confirm action against a NULL
  // confirm_string is an unwinnable prompt — refuse honestly BEFORE any render/prompt. The
  // `confirmMatches` null-never-matches backstop stays beneath this.
  if ((action.kind === "prompt_typed" || action.kind === "validate_confirm") && plan.confirmString === null) {
    throw terminalPlanError(
      "the server did not supply a confirm string for this typed-confirm plan — refusing to proceed",
      plan.id,
    );
  }
  // Render the ALREADY-redacted plan for every operator-facing action — not for a data-only
  // plan_only emit (the plan goes to stdout instead).
  if (action.kind !== "emit_plan") {
    deps.warn(renderPlan(plan, { now: deps.now(), effectiveDanger: d.effectiveDanger }));
  }
  switch (action.kind) {
    case "emit_plan":
      return { kind: "plan", mode: "plan_only", plan: plan.raw };
    case "apply":
      return applyPass(d, undefined);
    case "prompt_yn": {
      const ok = await deps.confirm(`Apply this ${d.effectiveDanger} plan? [y/N] `);
      if (!ok) return declineThrow(d, "declined");
      return applyPass(d, undefined);
    }
    case "prompt_typed": {
      if (action.warnYesIgnored) {
        deps.warn("note: --yes does NOT skip a typed confirm; type the confirm string to proceed.\n");
      }
      const typed = await deps.promptLine("type the confirm string exactly to proceed: ");
      if (typed === null) return declineThrow(d, "declined"); // A-10: EOF/close → decline
      if (!confirmMatches(typed, plan)) return declineThrow(d, "mismatch");
      return applyPass(d, typed);
    }
    case "validate_confirm": {
      const value = d.confirmValue ?? "";
      if (!confirmMatches(value, plan)) return declineThrow(d, "mismatch");
      return applyPass(d, value);
    }
    case "halt":
      throw haltError(action.need, d);
  }
}

function applyPass(d: PlanDispatch, confirm: string | undefined): CeremonyPass {
  return { kind: "plan", mode: "apply", plan: d.plan.raw, confirm, recovery: d.recovery };
}

/**
 * L-010: the DISPLAYED confirm_string is the authority. A null confirm_string can NEVER match
 * (backstop beneath the F-E2 pre-prompt refusal), so nothing proceeds. No client-side
 * recomputation of the value exists (FORBIDDEN row 2).
 */
function confirmMatches(typed: string, plan: NarrowedPlan): boolean {
  return plan.confirmString !== null && typed === plan.confirmString;
}

/** Discard the just-created plan (best-effort) then throw. A standalone decline never discards. */
async function declineThrow(d: PlanDispatch, cause: "declined" | "mismatch"): Promise<never> {
  const discarded = d.discardOnDecline ? await discardPlan(d.ctx, d.deps, d.plan.id) : null;
  const reason = cause === "mismatch" ? "the confirm string did not match" : "confirmation declined";
  // F-G5: the outcome copy tells the truth about what happened to the plan.
  const outcome =
    discarded === true
      ? " — the plan was discarded and NOT applied"
      : discarded === false
        ? " — the plan could not be discarded (it remains open until the server TTL) and was NOT applied"
        : " — the plan was NOT applied";
  // A-8: NEVER embed the (discarded) plan nor an `apply` hint; the hint is the re-plan teachable.
  // D0-h(b/d): the cause is TYPED, and a mismatch carries the value the operator should have typed
  // (non-null on every path that reaches here — F-E2 refused a null confirm_string before the
  // prompt, and the RAW gate already proved it displayable).
  throw new ConfirmationRequiredError({
    detail: reason + outcome,
    hint: replanHint(d),
    reason: cause === "mismatch" ? "confirm_mismatch" : "declined",
    ...(cause === "mismatch" && d.plan.confirmString !== null
      ? { challenge: { expected: d.plan.confirmString } }
      : {}),
  });
}

/** A non-TTY HALT: keep the plan open (no discard), EMBED it, hint with the full runnable line. */
function haltError(need: HaltNeed, d: PlanDispatch): ConfirmationRequiredError {
  return new ConfirmationRequiredError({
    detail: haltDetail(need),
    hint: gateFlagsHint(d),
    plan: d.plan.raw,
    reason: HALT_REASON[need], // D0-h(b): the missing gate, verbatim — never inferred from prose
  });
}

/**
 * Best-effort plan.discard. Returns whether the discard SUCCEEDED (F-G5 — the decline copy tells
 * the truth). F-A/A-1: the request is flagged `ignoreClientOverride` so a user `--idempotency-key`
 * override NEVER rides this internal write (the key is unique per principal — reuse would 422).
 */
async function discardPlan(ctx: Ctx, deps: CeremonyDeps, id: string): Promise<boolean> {
  try {
    await ctx.client.request({
      operationId: "plan.discard",
      params: { id },
      idempotency: { ignoreClientOverride: true },
    });
    return true;
  } catch {
    // Best-effort: the server TTL reaps an un-discarded plan (Risk 2). A discard failure must never
    // mask the decline outcome or change the exit code — the operator is told so honestly.
    deps.warn("note: could not discard the plan; it will expire on the server TTL.\n");
    return false;
  }
}

// ── hint builders (all via the ONE argv encoder — RC-12) ─────────────────────────

/** The parsed input MINUS its `confirm` key (F-G4: a hint never reproduces the offending flag). */
function inputWithoutConfirm(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const { confirm: _confirm, ...rest } = input as Record<string, unknown>;
  void _confirm;
  return rest;
}

/** The full runnable line with the missing gate flags (--yes + --confirm placeholder for D/PR). */
function gateFlagsHint(d: PlanDispatch): string {
  return encodeShellCommand(
    toInvocationTokens(d.spec, d.input, {
      appendYes: true,
      appendConfirmPlaceholder: requiresTypedConfirm(d.effectiveDanger),
    }),
  );
}

/**
 * The re-plan hint. A FUSED decline discarded the plan → re-run the ORIGINAL command to mint a
 * fresh one; a STANDALONE decline kept the plan → re-run the apply with the gate flags.
 */
function replanHint(d: PlanDispatch): string {
  return d.recovery.source === "fused" ? reconstructInvocation(d.spec, d.input) : gateFlagsHint(d);
}

const HALT_DETAIL: Record<HaltNeed, string> = {
  yes: "this terminal is non-interactive — re-run with --yes to apply the plan",
  confirm: "this terminal is non-interactive — re-run with --confirm <value> (the plan's confirm string) to apply",
  confirm_and_yes:
    "this terminal is non-interactive — re-run with --yes AND --confirm <value> to apply this plan",
};
function haltDetail(need: HaltNeed): string {
  return HALT_DETAIL[need];
}

const REJECT_DETAIL: Record<RejectReason, string> = {
  plan_only_on_direct_confirm: "--plan-only is not valid here: this operation confirms directly and is not plannable",
  plan_only_on_apply: "--plan-only is not valid on an apply: the plan already exists — inspect it with `plan show`",
  plan_only_with_confirm: "--plan-only cannot be combined with --confirm (there is nothing to confirm until apply)",
  plan_only_with_yes: "--plan-only cannot be combined with --yes (--plan-only stops before the apply)",
  confirm_without_typed_danger:
    "--confirm is only meaningful for a destructive / prod-rebinding plan; this plan needs no typed confirm",
  direct_confirm_below_threshold:
    "internal: a direct-confirm operation must be destructive or prod-rebinding",
  // T-215 Seam-1 (D-2 / R-E).
  plan_only_on_direct: "--plan-only is not valid here: this operation executes directly and is not plannable",
  direct_above_threshold:
    "internal: a direct mutation above the M danger threshold has no typed-confirm authority — refusing",
};

/**
 * A reject_usage teachable. F-G4: the hint NEVER reproduces the offending flag — a `--confirm`
 * conflict strips the confirm key; a plan-only conflict shows the clean `--plan-only` line (the
 * conflicting companion is simply absent — `--yes`/`--plan-only` never ride the parsed input).
 */
function rejectUsageError(reason: RejectReason, spec: AnyCommandSpec, input: unknown): CliLocalError {
  let hint: string;
  switch (reason) {
    case "plan_only_with_confirm":
    case "plan_only_with_yes":
      hint = encodeShellCommand([...toInvocationTokens(spec, inputWithoutConfirm(input)), "--plan-only"]);
      break;
    case "plan_only_on_apply": {
      // The plan already exists — the teachable is to INSPECT it, not to re-plan.
      const id = input !== null && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
      hint = typeof id === "string" ? encodeShellCommand(["plan", "show", id]) : "agkit plan show <plan-id>";
      break;
    }
    default:
      // confirm_without_typed_danger / plan_only_on_direct_confirm / the fail-closed cell: the
      // clean re-run line, offending flag stripped.
      hint = reconstructInvocation(spec, inputWithoutConfirm(input));
  }
  return new CliLocalError("usage_error", { detail: REJECT_DETAIL[reason], hint });
}

/** A-6 fail-closed: a plan we cannot classify (unknown status/danger, malformed) is terminal. */
function narrowFailError(
  reason: "unknown_status" | "unknown_danger" | "malformed",
  detail: string,
  spec: AnyCommandSpec,
  input: unknown,
): CliLocalError {
  const message =
    reason === "unknown_status"
      ? `the server returned a plan with an unrecognized status (${displaySafe(detail)}) — refusing to proceed`
      : reason === "unknown_danger"
        ? `the server returned a plan with an unrecognized danger class (${displaySafe(detail)}) — refusing to proceed`
        : `the server returned a malformed plan (${displaySafe(detail)}) — refusing to proceed`;
  return new CliLocalError("usage_error", { detail: message, hint: reconstructInvocation(spec, input) });
}

/** A terminal plan short-circuit (A-7/F-B6/F-E2): inspect the plan to see why it can't proceed. */
function terminalPlanError(detail: string, planId: string): CliLocalError {
  return new CliLocalError("usage_error", { detail, hint: encodeShellCommand(["plan", "show", planId]) });
}

/** `expires_at <= now` is expired — the EXACT boundary (a plan expiring this millisecond is gone).
 * R3-2: the comparison instant comes from the SAME frozen-grammar parser the narrower validated
 * with — `Date.parse` is NaN on a contract-valid leap second, which would fail OPEN here. */
function isExpired(plan: NarrowedPlan, now: number): boolean {
  if (plan.expiresAt === null) return false;
  const at = frozenTimestampMs(plan.expiresAt);
  return at !== null && at <= now;
}

// ══ direct_confirm (T-213/T-214 seam — no plan) ══════════════════════════════════
async function runDirectConfirm(
  spec: AnyCommandSpec,
  binding: DirectConfirmMutation,
  ctx: Ctx,
  input: unknown,
  deps: CeremonyDeps,
  flags: CeremonyFlags,
): Promise<CeremonyPass> {
  // RC-8: prepare is invoked EXACTLY once, before any render/prompt. (The static plan-only
  // reject already fired in the entrypoint — prepare's read never runs for it.)
  const prepared = await binding.prepare(ctx, input);
  // F-E3/R2-1/R3-1 (display-is-authority): a KNOWN expected confirm value MUST be one the
  // operator can SEE and TYPE — the survival breaches (empty / secret-shaped / control chars)
  // are terminal BEFORE any render or prompt. The authority the operator re-types is then a
  // DEDICATED LABELED LINE the ceremony itself appends to the rendered preview (L-010 model:
  // the displayed value IS the authority) — the consumer preview need not contain the value.
  if (prepared.expectedConfirm !== undefined) {
    assertDisplayAuthority(prepared.expectedConfirm);
  }
  const renderedPreview =
    renderPreview(prepared.preview) +
    (prepared.expectedConfirm !== undefined ? `confirm value: ${prepared.expectedConfirm}\n` : "");
  const action = decideCeremony({
    kind: "direct_confirm",
    danger: spec.danger, // direct_confirm keeps its static D/PR danger (never floored)
    tty: deps.isTTY,
    yes: flags.yes,
    planOnly: flags.planOnly,
    confirmProvided: flags.confirmValue !== undefined,
  });
  if (action.kind !== "reject_usage") {
    deps.warn(renderedPreview);
  }
  switch (action.kind) {
    case "reject_usage":
      throw rejectUsageError(action.reason, spec, input);
    case "prompt_typed": {
      if (action.warnYesIgnored) deps.warn("note: --yes does NOT skip a typed confirm.\n");
      // R3-1: with a KNOWN authority the prompt points at the SHOWN labeled line; in
      // forward-verbatim mode (RC-2, no local check) it keeps the challenge label.
      const promptText =
        prepared.expectedConfirm !== undefined
          ? "type the confirm value shown above to proceed: "
          : `type ${confirmChallengeLabel(spec)} to proceed: `;
      const typed = await deps.promptLine(promptText);
      if (typed === null) {
        throw directRefusal("confirmation declined — the operation was NOT performed", spec, input, "declined");
      }
      // RC-2: local mismatch iff the expected value is KNOWN (fetched); else forward verbatim.
      if (prepared.expectedConfirm !== undefined && typed !== prepared.expectedConfirm) {
        throw directRefusal(DIRECT_MISMATCH_DETAIL, spec, input, "confirm_mismatch");
      }
      return directPass(typed, prepared);
    }
    case "validate_confirm": {
      const value = flags.confirmValue ?? "";
      if (prepared.expectedConfirm !== undefined && value !== prepared.expectedConfirm) {
        throw directRefusal(DIRECT_MISMATCH_DETAIL, spec, input, "confirm_mismatch");
      }
      return directPass(value, prepared);
    }
    case "halt":
      throw new ConfirmationRequiredError({
        detail: haltDetail(action.need),
        hint: directRetryHint(spec, input),
        reason: HALT_REASON[action.need], // D0-h(b): the direct door speaks the SAME vocabulary
      });
    default:
      // emit_plan / apply / prompt_yn cannot occur for a direct_confirm (typed danger, no plan).
      throw new Error(`agkit: internal — unreachable direct_confirm action '${action.kind}'`);
  }
}


function directRefusal(
  detail: string,
  spec: AnyCommandSpec,
  input: unknown,
  reason: ConfirmationReason,
): ConfirmationRequiredError {
  // D0-h(b): typed cause only. NO `challenge` — the direct door's expected value is prepared from a
  // resource the caller already read, and every direct_confirm op is mcpExcluded, so there is no
  // consumer to hand it to and no reason to widen disclosure.
  return new ConfirmationRequiredError({ detail, hint: directRetryHint(spec, input), reason });
}

// ══ direct (T-215 Seam-1 — the M-class no-plan, no-typed-challenge money-path door) ═══════════════
/**
 * The M-class DIRECT ceremony (T-215, D-2/R-C/R-E — `billing checkout`/`billing portal`). It runs
 * EXACTLY the M decision cell: render a PURE static preview (derived only from the parsed input —
 * no wire call, no prepare, no post-confirm lookup), then y/N (TTY) / `--yes` fuse / non-TTY halt.
 * It makes ZERO `ctx.client` calls — no write, no read, nothing — before a valid `proceed` pass.
 * A `direct` op at a typed danger (D/PR) is unreachable here (the registry direct⇒M invariant +
 * the decision spine's direct_above_threshold reject rule it out); the default arm asserts that.
 */
async function runDirect(
  spec: AnyCommandSpec,
  binding: DirectMutation,
  ctx: Ctx,
  input: unknown,
  deps: CeremonyDeps,
  flags: CeremonyFlags,
): Promise<CeremonyPass> {
  void ctx; // runDirect intentionally makes NO client call before a valid proceed pass (R-C/R-E).
  // PURE static preview — redacted + terminal-safe through the SAME chokepoint (a secret-shaped
  // sentinel masks; control chars escape; never rendered live).
  const renderedPreview = renderPreview(binding.preview(input));
  const action = decideCeremony({
    kind: "direct",
    danger: spec.danger, // pinned to M by the registry invariant; the SR-floor never lowers it
    tty: deps.isTTY,
    yes: flags.yes,
    planOnly: flags.planOnly,
    confirmProvided: flags.confirmValue !== undefined,
  });
  if (action.kind !== "reject_usage") {
    deps.warn(renderedPreview);
  }
  switch (action.kind) {
    case "reject_usage":
      throw rejectUsageError(action.reason, spec, input);
    case "apply":
      return { kind: "proceed" };
    case "prompt_yn": {
      const ok = await deps.confirm(`Perform this ${spec.danger} operation? [y/N] `);
      if (!ok) throw directMRefusal(spec, input); // A-10: decline / EOF → refusal, zero writes
      return { kind: "proceed" };
    }
    case "halt":
      throw new ConfirmationRequiredError({
        detail: HALT_DETAIL_DIRECT_M,
        hint: directMRetryHint(spec, input),
        // The M cell's only halt is the missing `--yes` fuse (it has no typed challenge).
        reason: "missing_yes",
      });
    default:
      // emit_plan / prompt_typed / validate_confirm cannot occur for an M-direct op: plan-only
      // rejects (plan_only_on_direct), D/PR rejects (direct_above_threshold), and M has no typed
      // challenge — so the M cell only ever yields apply / prompt_yn / halt(yes).
      throw new Error(`agkit: internal — unreachable direct action '${action.kind}'`);
  }
}

/**
 * R-E: the M-direct refusal (interactive decline / EOF). The retry hint appends ONLY `--yes` —
 * NEVER a `--confirm` placeholder: the M cell has no typed challenge, so a `--yes --confirm <value>`
 * retry would itself be rejected (confirm_without_typed_danger). Distinct from `directRefusal`
 * (direct_confirm), which teaches the `--confirm` retry.
 */
function directMRefusal(spec: AnyCommandSpec, input: unknown): ConfirmationRequiredError {
  return new ConfirmationRequiredError({
    detail: "confirmation declined — the operation was NOT performed",
    hint: directMRetryHint(spec, input),
    reason: "declined", // D0-h(b)
  });
}

