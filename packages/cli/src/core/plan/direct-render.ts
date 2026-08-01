// The PURE helpers of the two no-plan mutation doors — `direct_confirm` (T-213/T-214) and the
// M-class `direct` money-path (T-215). Extracted from `ceremony.ts` when that file crossed the
// T-204 800-line module cap (eslint `max-lines`, CI-enforced).
//
// WHAT LIVES HERE, and why exactly this cut. Every function below is a LEAF: it renders, encodes
// or constructs a value and depends on nothing in the ceremony's own state or error vocabulary.
// The door orchestrators (`runDirectConfirm` / `runDirect`) and every refusal builder stay in
// `ceremony.ts` because they construct `ConfirmationRequiredError` — moving those too would make
// this module import the file that imports it. A leaf-only cut keeps the dependency edge
// one-directional (`ceremony.ts` → here, never back), which is the whole reason it is safe.
//
// The copy CONSTANTS live here for the same reason they were constants before: both doors' call
// sites read the same bytes, so the two cannot drift into saying different things about the same
// refusal.
import type { AnyCommandSpec, CeremonyPass, DirectConfirmPrepared } from "../../commands/types";
import { redact } from "../output/redaction";
import { displaySafe } from "../output/display";
import { encodeShellCommand, toInvocationTokens } from "./invocation";

/**
 * Build the direct pass from the confirm value + the FULL prepared bundle. `ifMatch` and the
 * prepared `target` identity (T-213 S12 review — TOCTOU close) are threaded VERBATIM when present,
 * so the handler acts on EXACTLY the reviewed resource; both are omitted (not set to `undefined`)
 * when absent, so a consumer that prepares neither yields the same `{kind,confirm}` pass as before.
 */
export function directPass(confirm: string, prepared: DirectConfirmPrepared): CeremonyPass {
  const pass: { kind: "direct"; confirm: string; ifMatch?: string; target?: Record<string, unknown> } = {
    kind: "direct",
    confirm,
  };
  if (prepared.ifMatch !== undefined) pass.ifMatch = prepared.ifMatch;
  if (prepared.target !== undefined) pass.target = prepared.target;
  return pass;
}

/** The direct_confirm mismatch copy — a CONSTANT so both call sites cannot drift apart. */
export const DIRECT_MISMATCH_DETAIL = "the confirm value did not match — the operation was NOT performed";

/**
 * R-E: the M-direct non-TTY halt copy — says "perform this operation", NEVER "apply the plan"
 * (there is no plan on a direct mutation). A DEDICATED constant so the plan/apply halt copy
 * (`HALT_DETAIL.yes`, "…to apply the plan") stays untouched.
 */
export const HALT_DETAIL_DIRECT_M =
  "this terminal is non-interactive — re-run with --yes to perform this operation";

export function confirmChallengeLabel(spec: AnyCommandSpec): string {
  return spec.confirm ? `the ${spec.confirm.challenge}` : "the confirm string";
}

/** The direct_confirm retry hint — teaches `--yes` AND a `--confirm` placeholder. */
export function directRetryHint(spec: AnyCommandSpec, input: unknown): string {
  return encodeShellCommand(toInvocationTokens(spec, input, { appendYes: true, appendConfirmPlaceholder: true }));
}

/** The M-direct retry hint — appends ONLY `--yes` (no `--confirm`), via the ONE argv encoder. */
export function directMRetryHint(spec: AnyCommandSpec, input: unknown): string {
  return encodeShellCommand(toInvocationTokens(spec, input, { appendYes: true }));
}

/**
 * F-D3: the direct_confirm preview render — redacted through the SAME chokepoint registry
 * (a secret value in a preview line masks to `(sensitive)`) and encoded terminal-safe (a
 * hostile CR/LF/ESC renders as a visible `\xNN`, never live).
 */
export function renderPreview(preview: DirectConfirmPrepared["preview"]): string {
  const safe = redact(preview) as { title: string; lines: readonly string[] };
  return [displaySafe(safe.title), ...safe.lines.map((line) => `  ${displaySafe(line)}`)].join("\n") + "\n";
}
