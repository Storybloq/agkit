// `kill-switch activate --reason <r>` — the ENGAGE arm of the asymmetric `kill_switch.set` route
// (T-219 §1 D-1; wire: danger.engage:"D", gating.engage:"direct_confirm", idempotency required,
// dual-mode conditional). HALTING traffic is the protective direction — so this is ONE direct POST
// (no plan artifact, no apply round-trip; FORBIDDEN 2's surviving half) with the wire-REQUIRED
// typed project-name confirm. The frozen engage arm hard-requires `{active:true, reason, confirm}`
// (RS oneOf; reason 1..512 CODEPOINTS re-counted server-side; confirm === project name) — the
// ticket's "M-class --yes only" shape is NOT expressible against v1.1.0, and a CLI-fabricated
// confirm would let `--yes` satisfy a typed challenge (the decision-spine FORBIDDEN). The
// incident-speed asymmetry survives REGISTRY-ENCODED: activate = direct D ceremony (one typed word
// the operator knows cold), deactivate = the full PR plan ceremony.
//
// R31 (mandatory --reason): required client-side — a missing/empty/oversize reason is a
// usage_error exit 2 NAMING the flag, ZERO wire calls (Acceptance A-1). The registry's S-A
// `requireReason` teeth machine-check this (spec.confirm.requireReason:true ⇒ the example parsed
// without `reason` must FAIL). Re-engage while active is legal (updates reason + attribution) —
// the dual-mode prepare distinguishes first-engage (404 ⇒ If-None-Match:*) from re-engage
// (200 ⇒ ETag REQUIRED, If-Match).
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, readCapturedEtag } from "../types";
import {
  CliLocalError,
  PreClassifiedError,
  WireProblemError,
  allowlistedWireErrorEnvelope,
} from "../../core/errors";

export const killSwitchActivateArgs = z
  .object({
    // The wire bound is 1..512 CODEPOINTS (the server re-counts authoritatively) — so the mirror
    // counts codepoints too: `.max(512)` would count UTF-16 code units and reject an astral-
    // bearing reason at roughly half the contractual limit.
    reason: z
      .string()
      .min(1)
      .refine((r) => Array.from(r).length <= 512, {
        message: "reason must be at most 512 characters",
      })
      .describe("Why traffic is being halted (required; recorded with attribution; 1..512 chars)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The project NAME, to confirm (required non-interactively; the server verifies it)."),
  })
  .strict();
export type KillSwitchActivateInput = z.infer<typeof killSwitchActivateArgs>;

// FORBIDDEN 8: an etag-less 200 in re-engage mode fails closed BEFORE any prompt — static error.
const ETAGLESS_DETAIL =
  "the management API returned the kill-switch row without an ETag, so the re-engage precondition cannot be constructed — this is a server protocol error, not a request you can fix";

/** A current-state preview line from the fetched row (server-controlled values ride the ceremony's
 *  displaySafe chokepoint — a control/ANSI `reason` renders neutralized, never live). */
function stateLine(raw: unknown, member: string): string {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[member];
  return `current ${member}: ${value === undefined ? "(not reported)" : JSON.stringify(value)}`;
}

/**
 * The dual-mode direct_confirm `prepare` (S-D over `kill_switch.get`). 404 ⇒ first engage (create
 * mode); 200 ⇒ RE-engage (ETag REQUIRED — fail closed pre-prompt) with the current state shown so
 * the operator sees whose reason/attribution a re-engage replaces. `expectedConfirm` OMITTED (D-9
 * forward-verbatim — the confirm is the project NAME the CLI does not know).
 */
export async function prepareKillSwitchActivate(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = killSwitchActivateArgs.parse(input);
  const pid = requireProject(ctx);
  const reasonLine = `reason: ${parsed.reason}`;

  let raw: unknown;
  try {
    raw = await ctx.client.request({ operationId: "kill_switch.get", params: { pid }, captureMeta: true });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      return {
        preview: {
          title: "ENGAGE the kill switch — ALL end-user traffic for this project halts immediately.",
          lines: [reasonLine, "no kill switch exists yet for this project — this engages one."],
        },
        target: { mode: "create" },
      };
    }
    throw err;
  }

  const etag = readCapturedEtag(raw);
  if (etag === undefined) {
    throw new CliLocalError("usage_error", { detail: ETAGLESS_DETAIL });
  }
  return {
    preview: {
      title: "ENGAGE the kill switch — ALL end-user traffic for this project halts immediately.",
      lines: [
        reasonLine,
        "a kill-switch row already exists — re-engaging UPDATES its reason and attribution:",
        stateLine(raw, "active"),
        stateLine(raw, "reason"),
        stateLine(raw, "activated_at"),
      ],
    },
    ifMatch: etag,
    target: { mode: "replace" },
  };
}

// Race teaching (S-D): terminal 412s teach the re-run; never auto-retry, never auto-pivot the mode.
const HINT_412_CREATE =
  "a kill-switch row appeared mid-flight — re-run `agkit kill-switch activate` (it will now re-engage, updating reason + attribution)";
const HINT_412_REPLACE =
  "the kill-switch state changed since the preview — re-run `agkit kill-switch activate` to review current state";
const HINT_CONFIRM_MISMATCH = "the confirm value is the project's NAME exactly as `agkit project get` shows";

// A2/R12 (the T-218 sync precedent): the engage body round-trips the operator's `reason` (and the
// typed confirm), so a 400/422 problem could reflect it — those two statuses rebuild ALLOWLISTED
// (server strings DROPPED, static value-free detail; the classified code + CLI hint stay
// teachable). Auth/404/412/5xx keep the general renderer (they reflect nothing from the payload;
// scrubbing them would relabel the failure, §B-9).
const STATIC_REJECT_DETAIL =
  "the server rejected the engage request (the reason or the confirm value was not accepted).";

export const killSwitchActivate: CommandHandler<KillSwitchActivateInput> = async (ctx, input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    throw new Error("agkit: internal — kill-switch activate requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  const mode = pass.target?.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error("agkit: internal — kill-switch activate ceremony pass is missing the prepared mode");
  }
  if (mode === "replace" && typeof pass.ifMatch !== "string") {
    throw new Error("agkit: internal — kill-switch activate re-engage pass is missing the prepared If-Match ETag");
  }
  const pid = requireProject(ctx);
  const parsed = killSwitchActivateArgs.parse(input);

  try {
    const resp = await ctx.client.request({
      operationId: "kill_switch.set",
      // The frozen ENGAGE arm EXACTLY: {active:true, reason, confirm} — no other member.
      params: { pid, active: true, reason: parsed.reason, confirm: pass.confirm },
      preconditions: mode === "create" ? { ifNoneMatch: "*" } : { ifMatch: pass.ifMatch },
    });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError) {
      let hintOverride: string | undefined;
      if (err.problem.status === 412) {
        hintOverride = mode === "create" ? HINT_412_CREATE : HINT_412_REPLACE;
      } else if (err.problem.code === "confirm_mismatch") {
        hintOverride = HINT_CONFIRM_MISMATCH;
      }
      if (err.problem.status === 400 || err.problem.status === 422) {
        throw new PreClassifiedError(
          allowlistedWireErrorEnvelope(err.problem, { staticDetail: STATIC_REJECT_DETAIL, hintOverride }),
        );
      }
      if (hintOverride !== undefined) err.hintOverride = hintOverride;
    }
    throw err;
  }
};
