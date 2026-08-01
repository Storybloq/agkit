// Human render of a plan for the ceremony's stderr diff (T-212 S4 + review round F-E1/F-D5).
// PURE: it formats an ALREADY-redacted `NarrowedPlan` (the ceremony passes the plan through
// the SAME chokepoint `redact()` first, so a server `(secret)` sentinel has already become
// `(sensitive)`), and returns text — the ceremony writes it to its stderr sink. It NEVER
// redacts and NEVER prompts; it only renders.
//
// F-E1 (RC-10): the header, PROD-REBINDING banner, and typed-confirm block key on the
// EFFECTIVE danger — max(spec floor, plan danger), computed by the ceremony and passed in —
// never the plan's raw danger alone (a plan whose spec floor is PR must render the PR
// ceremony even if the wire under-reports D). The confirm VALUE still comes ONLY from
// `plan.confirmString` (L-010 display-is-authority).
//
// F-D5: every PLAN-CONTROLLED string (id, diff op/resource/path, string before/after leaves,
// resource.action names, confirm_string) is routed through the ONE terminal-safe encoder
// (`displaySafe`) — a hostile CR/LF/ESC/NUL renders as a visible `\xNN`, never live.
import { frozenTimestampMs } from "./types";
import type { NarrowedPlan } from "./types";
import type { Danger } from "../../commands/types";
import { requiresTypedConfirm } from "../../commands/types";
import { displaySafe } from "../output/display";

const DANGER_LABEL: Record<Danger, string> = {
  SR: "safe-read",
  M: "mutating",
  D: "destructive",
  PR: "prod-rebinding",
};

export interface RenderPlanOptions {
  /** Injected wall-clock (ms) for the expiry countdown — frozen in tests. */
  readonly now: number;
  /** The EFFECTIVE danger (max(spec floor, plan danger), RC-10) the ceremony decided on. */
  readonly effectiveDanger: Danger;
}

/** Render the plan for the ceremony's stderr diff. Returns a trailing-LF-terminated block. */
export function renderPlan(plan: NarrowedPlan, opts: RenderPlanOptions): string {
  const danger = opts.effectiveDanger;
  const lines: string[] = [];
  lines.push(`Plan ${displaySafe(plan.id)} - danger ${danger} (${DANGER_LABEL[danger]})`);
  lines.push(`  ${expiryLine(plan.expiresAt, opts.now)}`);

  if (danger === "PR") {
    const targets = resourceActions(plan);
    const names = targets.length > 0 ? targets.map(displaySafe).join(", ") : "(unspecified)";
    lines.push(`  !! PROD-REBINDING: this plan re-binds LIVE traffic - ${names}`);
  }

  lines.push("  changes:");
  for (const line of diffLines(plan)) lines.push(`    ${line}`);

  if (requiresTypedConfirm(danger)) {
    lines.push("  to proceed, type this confirm string exactly:");
    lines.push(
      `    ${plan.confirmString !== null ? displaySafe(plan.confirmString) : "(confirm string unavailable - cannot proceed)"}`,
    );
  }

  return lines.join("\n") + "\n";
}

/** The expiry countdown line, using the injected clock. */
function expiryLine(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return "no expiry";
  // R3-2: the same frozen-grammar parser the narrower + expiry gate use (leap-second aware).
  const at = frozenTimestampMs(expiresAt);
  if (at === null) return "expiry: unknown";
  const ms = at - now;
  if (ms <= 0) return "EXPIRED";
  return `expires in ${formatDuration(ms)}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** The sorted, unique `resource.action` set the banner + confirm string are keyed on. */
function resourceActions(plan: NarrowedPlan): string[] {
  const changes = Array.isArray(plan.raw.changes) ? plan.raw.changes : [];
  const set = new Set<string>();
  for (const change of changes as Array<{ resource?: unknown; action?: unknown }>) {
    if (typeof change.resource === "string" && typeof change.action === "string") {
      set.add(`${change.resource}.${change.action}`);
    }
  }
  return [...set].sort();
}

/** Per-change diff lines over the ALREADY-redacted diff (so leaves show `(sensitive)`). */
function diffLines(plan: NarrowedPlan): string[] {
  if (!plan.diff || plan.diff.length === 0) return ["(no structured diff provided)"];
  const out: string[] = [];
  for (const entry of plan.diff) {
    out.push(`${displaySafe(entry.op)} ${displaySafe(entry.resource)} ${displaySafe(entry.path)}`);
    if (entry.before !== undefined || entry.after !== undefined) {
      out.push(`  ${formatValue(entry.before)} -> ${formatValue(entry.after)}`);
    }
    // T-218 §3.5: the server-stamped cascade advisory — rendered ONLY when it is a genuine, non-empty
    // string array (tolerant: absent/malformed ⇒ omitted, never a crash). displaySafe'd like every
    // other diff leaf. Generic — any cascading resource renders here.
    if (Array.isArray(entry.cascades) && entry.cascades.length > 0 && entry.cascades.every((c) => typeof c === "string")) {
      out.push(`  cascades: ${entry.cascades.map((c) => displaySafe(c)).join(", ")} — child rows are deleted with this resource`);
    }
  }
  return out;
}

/** Format a diff leaf terminal-safe. Objects/arrays are JSON (their string leaves included —
 * JSON.stringify escapes controls itself); a redacted leaf is already `(sensitive)`. */
function formatValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "null";
  if (typeof value === "string") return displaySafe(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
