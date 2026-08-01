// The CONFIRM-VALUE AUTHORITY gates (T-226 D0-h(c), split out of ceremony.ts at the CLI 800-line
// ceiling). ONE definition of what makes a confirm value displayable and typeable, and the TWO
// gates that enforce it:
//
//   • `assertRawConfirmAuthority(raw)` — the RAW server plan, at both ceremony intakes.
//   • `assertDisplayAuthority(expected)` — a direct_confirm's PREPARED expected value (R2-1/R3-1).
//
// The classifier is shared deliberately: a value the render pipeline would mask or escape is
// untypeable no matter which door it came through, so the rule cannot be allowed to drift between
// the two. It returns a breach CLASS, never the value — which is what lets the raw gate refuse
// without ever copying hostile bytes into an error.
import { CliLocalError } from "../errors";
import { redactText } from "../output/redaction";
import { displaySafe } from "../output/display";

/**
 * The THREE survival breaches a confirm value can carry. A value failing any of them could never be
 * displayed verbatim and typed back:
 *   • EMPTY (nothing to show or type);
 *   • secret-shaped (redaction would MASK the authority line itself);
 *   • control characters (display encoding would ESCAPE it — the operator could never type the
 *     literal bytes the ceremony expects).
 */
type ConfirmBreach = "empty" | "secret_shaped" | "control_bytes";

function confirmBreach(value: string): ConfirmBreach | null {
  if (value === "") return "empty";
  // The secret-VALUE policy is the SHARED one (D0-j): every ratified format — mgmt_* and provider
  // keys alike — makes a value unrenderable, so this gate widens the instant that array does.
  if (redactText(value) !== value) return "secret_shaped";
  if (displaySafe(value) !== value) return "control_bytes";
  return null;
}

const DISPLAY_AUTHORITY_BREACH: Record<ConfirmBreach, string> = {
  empty: "the expected confirm value is empty",
  secret_shaped: "the expected confirm value is secret-shaped — the render pipeline would mask it",
  control_bytes: "the expected confirm value carries control characters — the render pipeline would escape it",
};

/**
 * R2-1/R3-1 (display-is-authority): a prompt may only validate against a value the operator SAW
 * and can TYPE back verbatim. The value is shown on a DEDICATED labeled line the ceremony itself
 * renders (R3-1 — containment probing of the consumer preview is superseded: an incidental
 * substring is not an authority). A survival breach stays terminal — BEFORE any render or prompt,
 * with zero writes. This is an INTERNAL invariant (the prepared value is the CLI's own), so it
 * throws a plain internal Error, unlike the server-facing raw gate below.
 */
export function assertDisplayAuthority(expected: string): void {
  const breach = confirmBreach(expected);
  if (breach === null) return;
  throw new Error(`agkit: internal — display-is-authority breach: ${DISPLAY_AUTHORITY_BREACH[breach]}`);
}

/**
 * The FIXED refusal sentences. Each names the breach CLASS and NOTHING else: no plan id, no
 * offending bytes, no length, no prefix. A hostile `confirm_string` must not reach any error,
 * render or stderr byte — quoting even a fragment of it would defeat the whole gate.
 */
const RAW_CONFIRM_BREACH_DETAIL: Record<ConfirmBreach, string> = {
  empty:
    "the server returned a plan whose confirm string is EMPTY — there would be nothing to display or type back; refusing to proceed",
  secret_shaped:
    "the server returned a plan whose confirm string is secret-shaped — the render pipeline would mask the very value the operator must type back; refusing to proceed",
  control_bytes:
    "the server returned a plan whose confirm string carries control characters — the render pipeline would escape it and the operator could never type the literal bytes; refusing to proceed",
};

/**
 * D0-h(c) / R3-F2 — the confirm-string authority gate, run on the RAW server response at BOTH plan
 * intakes (`plan.create` and `plan.get`) BEFORE `redact()`.
 *
 * ORDER IS THE WHOLE POINT. Plans reach the ceremony as `narrowPlan(redact(raw))`, so a
 * secret-shaped `confirm_string` is ALREADY `(sensitive)` by the time any post-narrow check could
 * look at it: checking there would BLESS the mask and then prompt for — and compare against — the
 * mask itself. Running here, on the bytes the server actually sent, is the only position from which
 * the breach is visible at all.
 *
 * R4-F2 — the refusal is a DEDICATED `usage_error` with a fixed detail, NOT `terminalPlanError`:
 * that one hints `agkit plan show <id>`, which needs a TRUSTED plan id. At this boundary nothing
 * has been narrowed, so the response's `id` may be absent, malformed or hostile — putting it in a
 * runnable hint would launder unvalidated bytes into a command. No id, no hint.
 *
 * A `confirm_string` that is absent or NOT a string passes straight through to the existing
 * narrowing (which type-checks it) and the F-E2 null-confirm refusal beneath it — unchanged.
 */
export function assertRawConfirmAuthority(raw: unknown): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = (raw as Record<string, unknown>)["confirm_string"];
  if (typeof value !== "string") return;
  const breach = confirmBreach(value);
  if (breach === null) return;
  throw new CliLocalError("usage_error", { detail: RAW_CONFIRM_BREACH_DETAIL[breach] });
}
