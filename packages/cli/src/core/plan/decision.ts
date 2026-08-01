// decideCeremony — the safety spine (T-212 §Design, canonical L2-CLI-08). The ONE
// pure, TOTAL function that maps a mutation's (kind, effective-danger, tty, --yes,
// --plan-only, --confirm-provided) onto a ceremony action. A wrong cell is the top
// hazard (agent-blind `--yes`), so this is computed in EXACTLY ONE place, returns an
// exhaustive discriminated union (never throws), and is enumerated over its full
// cartesian product in decision.test.ts.
//
// Ratifications applied: RC-10 (SR is never a free apply — floored to M for
// plan/apply; direct_confirm keeps its static D/PR danger; the SR→apply cell is
// deleted), RC-9 (explicit fail-closed / contradictory-flag reject cells; TTY
// `--confirm` on direct_confirm is a local equality check, no prompt), RC-6 (a
// non-TTY D/PR needs BOTH `--yes` AND `--confirm`). D and PR are IDENTICAL here — the
// PROD-REBINDING banner is a render-time, danger-driven concern (S4), not a cell.
import type { Danger } from "../../commands/types";
import { requiresTypedConfirm } from "../../commands/types";

/** Which write path a mutation uses (mirrors `MutationBinding["kind"]`). */
export type MutationKind = "plan" | "apply" | "direct_confirm" | "direct";

/** A non-TTY halt embeds the plan and teaches the FULL runnable line (RC-6). */
export type HaltNeed = "yes" | "confirm" | "confirm_and_yes";

/** Why the ceremony refused (each maps to a teachable `usage_error` detail). */
export type RejectReason =
  | "plan_only_on_direct_confirm" // a direct_confirm route cannot produce a plan
  | "plan_only_on_apply" // a plan already exists — inspect it with `plan show`
  | "plan_only_with_confirm" // contradictory flags
  | "plan_only_with_yes" // contradictory flags
  | "confirm_without_typed_danger" // `--confirm` is meaningless on a non-typed (M) plan
  | "direct_confirm_below_threshold" // fail-closed: a direct_confirm below D (unreachable via invariant ii)
  | "plan_only_on_direct" // T-215: an M-direct op executes directly and is not plannable
  | "direct_above_threshold"; // T-215 fail-closed: an M-direct above M has no typed-confirm authority (unreachable via the direct⇒M invariant)

/** The exhaustive set of ceremony outcomes. */
export type CeremonyAction =
  | { readonly kind: "apply" } // proceed straight to the write (M `--yes`; D/PR only via validate)
  | { readonly kind: "emit_plan" } // `--plan-only`: emit the plan as data, exit 0
  | { readonly kind: "prompt_yn" } // M interactive: y/N over the existing confirm seam
  | { readonly kind: "prompt_typed"; readonly warnYesIgnored: boolean } // D/PR interactive typed challenge
  | { readonly kind: "validate_confirm" } // D/PR with `--confirm <value>` supplied
  | { readonly kind: "halt"; readonly need: HaltNeed } // non-TTY halt with embedded plan
  | { readonly kind: "reject_usage"; readonly reason: RejectReason };

export interface CeremonyDecisionInput {
  readonly kind: MutationKind;
  /** The EFFECTIVE danger (the caller has already maxed spec floor with the plan's). */
  readonly danger: Danger;
  /** Interactive terminal on stdin (runtime.isTTY). */
  readonly tty: boolean;
  /** `--yes` present. */
  readonly yes: boolean;
  /** `--plan-only` present. */
  readonly planOnly: boolean;
  /** Per-spec `--confirm <value>` present. */
  readonly confirmProvided: boolean;
}

export function decideCeremony(d: CeremonyDecisionInput): CeremonyAction {
  // RC-10: a schema-legal SR danger is floored to M for plan/apply flows — SR NEVER
  // means "free apply". direct_confirm keeps its static danger (D/PR by invariant ii;
  // a below-D value is the fail-closed reject cell below).
  const danger: Danger = d.kind === "direct_confirm" ? d.danger : d.danger === "SR" ? "M" : d.danger;
  const typed = requiresTypedConfirm(danger);

  // 1. plan-only mode — resolved before any danger ceremony.
  if (d.planOnly) {
    if (d.kind === "direct_confirm") return reject("plan_only_on_direct_confirm");
    // T-215: an M-direct op executes directly (not plannable) — mirrors the direct_confirm reject,
    // firing FIRST (before the contradictory-companion rows) like its sibling.
    if (d.kind === "direct") return reject("plan_only_on_direct");
    if (d.kind === "apply") return reject("plan_only_on_apply");
    // kind === "plan": `--plan-only` is its purpose; contradictory companions reject first.
    if (d.confirmProvided) return reject("plan_only_with_confirm");
    if (d.yes) return reject("plan_only_with_yes");
    return { kind: "emit_plan" };
  }

  // 2. direct_confirm below the typed threshold — fail-closed. Registry invariant (ii)
  //    makes this unreachable in production; the TOTAL function still rules on it.
  if (d.kind === "direct_confirm" && !typed) return reject("direct_confirm_below_threshold");

  // 2b. T-215 fail-closed (R-E): a `direct` op at a typed danger (D/PR) has NO typed-confirm
  //     authority to validate against — without this, this TOTAL PUBLIC function would route it
  //     into the prompt_typed / validate_confirm cells below. The registry direct⇒M invariant
  //     makes it unreachable in production; the total function still rules on it, mirroring
  //     direct_confirm_below_threshold. Removed only when a future ticket lands the complete
  //     typed-confirm matrix for `direct`.
  if (d.kind === "direct" && typed) return reject("direct_above_threshold");

  // 3. M ceremony (SR already floored to M). `--confirm` is meaningless here — teach.
  if (!typed) {
    if (d.confirmProvided) return reject("confirm_without_typed_danger");
    if (d.yes) return { kind: "apply" }; // M `--yes`: single-decision fuse
    if (d.tty) return { kind: "prompt_yn" }; // M interactive: y/N
    return { kind: "halt", need: "yes" }; // FORBIDDEN(4): non-TTY never silently applies
  }

  // 4. D / PR ceremony — typed confirm required.
  if (d.confirmProvided) {
    // RC-6 / D4: a non-TTY typed confirm needs BOTH `--yes` AND `--confirm`.
    if (!d.tty && !d.yes) return { kind: "halt", need: "yes" };
    return { kind: "validate_confirm" };
  }
  // No `--confirm` value supplied.
  // FORBIDDEN(3): `--yes` NEVER skips a typed challenge — TTY still prompts (and warns
  // that `--yes` was ignored); non-TTY halts for the value.
  if (d.tty) return { kind: "prompt_typed", warnYesIgnored: d.yes };
  if (d.yes) return { kind: "halt", need: "confirm" };
  return { kind: "halt", need: "confirm_and_yes" };
}

function reject(reason: RejectReason): CeremonyAction {
  return { kind: "reject_usage", reason };
}
