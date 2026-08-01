// T-212 S8 — plan-code hint decoration (PL-15 rendering, design (g)). The ONE catch-site
// helper the shared plan-mutation handler runs on a failed plan.apply leg: it decorates the
// FOUR ratified plan dispositions with a recovery hint selected by the ceremony pass's
// provenance (A-15), via `WireProblemError.hintOverride` — HINT METADATA ONLY (the vendored
// code / exit / retry bytes are never touched; no new error code exists):
//   • plan_stale            409 — apply preconditions drifted;
//   • plan_expired          410 — plan past its expiry;
//   • plan_already_applied  409 — a NEW key on an applied plan (the >24h PL-15 outcome;
//                                 the ≤24h same-key resend REPLAYS a stored 200 instead);
//   • conflict              409 with ext `reason: "plan_discarded"` (A-7 — the natural
//                                 decline→retry outcome).
// Provenance (A-15):
//   • fused      → the EXACT original invocation, re-encoded from the PARSED input via the
//                  ONE argv encoder (RC-12) — the confirm channel is a PLACEHOLDER (A-5),
//                  so a deterministic server confirm string is never handed out;
//   • standalone → a GENERIC teachable + `agkit plan show <id>` — the plan's `note` is
//                  DISPLAY data and is NEVER executed as a hint (a hostile note must not
//                  steer an agent's next command, A-17).
// All copy is TIMESTAMP-FREE (A-11): the 409 carries no ext members and the wire Plan has
// no applied_at — the render invents neither.
import type { CeremonyRecovery } from "../../commands/types";
import { WireProblemError } from "../errors";
import { encodeShellCommand } from "./invocation";

/** The gate: is this the ratified shape of one of the four plan dispositions? */
function planDisposition(err: WireProblemError): "plan_stale" | "plan_expired" | "plan_already_applied" | "plan_discarded" | null {
  const { code, status } = err.problem;
  if (code === "plan_stale" && status === 409) return "plan_stale";
  if (code === "plan_expired" && status === 410) return "plan_expired";
  if (code === "plan_already_applied" && status === 409) return "plan_already_applied";
  // A-7: the conflict code is decorated ONLY under its documented 409 with the
  // plan_discarded ext reason — any other conflict is not a plan-lifecycle outcome.
  if (code === "conflict" && status === 409 && err.problem["reason"] === "plan_discarded") return "plan_discarded";
  return null;
}

/** The timestamp-free standalone copy per disposition (A-11); the re-plan path is generic. */
const STANDALONE_COPY: Record<string, string> = {
  plan_stale: "the plan is stale (managed state drifted since it was created)",
  plan_expired: "the plan has expired",
  plan_already_applied: "this plan was already applied; the operation was NOT repeated",
  plan_discarded: "the plan was discarded",
};

/**
 * Decorate a failed plan.apply leg's WireProblemError with the provenance-selected recovery
 * hint (idempotent; a non-plan disposition is left untouched). Called by the shared
 * plan-mutation handler's catch site before rethrow.
 */
export function decoratePlanApplyError(err: WireProblemError, recovery: CeremonyRecovery): void {
  const disposition = planDisposition(err);
  if (disposition === null) return;
  if (recovery.source === "fused") {
    // The CLI KNOWS the current invocation — the exact re-plan command, confirm as a
    // placeholder by construction (the tokens came from the ONE encoder, RC-12/A-5).
    err.hintOverride = encodeShellCommand(recovery.replanArgv);
    return;
  }
  // Standalone: generic teachable + the inspect command (the id is encoded inert).
  err.hintOverride = `${STANDALONE_COPY[disposition]} — re-run the original mutation to get a fresh plan; inspect this one with: ${encodeShellCommand(["plan", "show", recovery.planId])}`;
}
