// core/plan — the CLI-side plan/apply engine types (T-212, canonical L2-CLI-08).
//
// This module holds the PURE plan primitives the ceremony builds on: the change
// shape a mutation binding produces for `plan.create`, the closed plan-status set,
// and the DEFENSIVE narrowing of a wire Plan. The typed client (T-211) TYPES a plan
// response as `ManagementPlan`, but the wire is bytes — `narrowPlan` fails CLOSED
// against runtime drift (A-6, review round F-B): an unknown or ABSENT `danger` is
// TERMINAL (never a silent PR upgrade — an unclassifiable plan is never applied), an
// unknown `status` is terminal, the frozen v1.1.0 plan $def's discriminators +
// required fields (object const "plan", ^plan_ id, changes/state_hash/gating/
// created_at — management-plan.schema.json `required`) are validated before ok:true,
// and `confirm_string`/`diff`/`expires_at` are OPTIONAL — but when PRESENT they must
// be well-formed (contract: consumers must NOT assume them, and must not render junk).
//
// Import discipline: the only management-contract reference is the TYPE-ONLY
// `management-types.gen` surface (erases at build — never drags the fs-reading
// contract loader into the bundle). The `Danger` runtime helpers come from
// commands/types (a one-way runtime edge: commands/types references THIS module
// TYPE-ONLY, so no runtime cycle exists).
import type { Danger } from "../../commands/types";
import { isDanger } from "../../commands/types";
import type { ManagementPlan } from "@agentkit-cloud/shared/wire-contract/management-types.gen";

/** The closed change-action set (management.json meta.enums.plan_change_action). */
export type PlanChangeAction = "create" | "update" | "delete" | "invoke";

/**
 * One change in a `plan.create` request: `{action, resource, path, body?}` — the
 * golden request shape (management-plan.create.request.json). A `PlanMutation`'s
 * `changes(input, ctx)` builder returns these; `path` is a CONCRETE route path with
 * ids already substituted (S7 reuses the typed client's route renderer, A-16).
 */
export interface PlanChange {
  readonly action: PlanChangeAction;
  readonly resource: string;
  readonly path: string;
  readonly body?: unknown;
}

/** The closed plan-status set (management.json meta.enums.plan_status). */
export type PlanStatus = "open" | "applied" | "discarded" | "expired";
export const PLAN_STATUSES = ["open", "applied", "discarded", "expired"] as const;

/** Runtime closed-set guard for a plan status. */
export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * A single diff entry. The server pre-masks secret LEAVES to the value `(secret)`
 * (normalized to the CLI mask at the serializer chokepoint, D5 / S1). Consumers must
 * NOT assume `before`/`after` present.
 */
export interface PlanDiffEntry {
  readonly op: string;
  readonly resource: string;
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
  /**
   * T-218 §3.5: server-stamped advisory naming the CHILD resource tables a delete cascades to
   * (`DELETE_CASCADES`, plan-compute.ts — e.g. an `agent_profile` delete cascades to
   * `agent_profile_tools`, `knowledge_bindings`). The narrowing's cast retains it verbatim; the
   * renderer surfaces it ONLY when it is a genuine string array (absent/malformed ⇒ omitted), so a
   * hostile value can never render. Generic — any future cascading resource renders for free.
   */
  readonly cascades?: readonly string[];
}

/**
 * A defensively-narrowed view of a wire Plan. Carries the classification the ceremony
 * needs (id/status/danger) plus the OPTIONAL display fields, and keeps the ORIGINAL
 * wire object (`raw`) for verbatim embedding in a `confirmation_required` envelope
 * (chokepoint-redacted) and for the human render (core/plan/render, S4).
 */
export interface NarrowedPlan {
  readonly id: string;
  readonly status: PlanStatus;
  /** Effective single danger class; an unknown wire value is clamped to PR (A-6). */
  readonly danger: Danger;
  /** Non-null IFF danger ∈ {D,PR} per contract; `null` when absent (defensive). */
  readonly confirmString: string | null;
  /** The structured diff, or `null` when the server omitted it. */
  readonly diff: readonly PlanDiffEntry[] | null;
  /** ISO-8601 expiry, or `null` when absent. */
  readonly expiresAt: string | null;
  /** The ORIGINAL wire object — embedded/rendered verbatim (never reconstructed). */
  readonly raw: ManagementPlan;
}

/**
 * The result of narrowing a wire plan. `ok:false` is TERMINAL (A-6): the ceremony
 * renders a teachable and NEVER applies. `unknown_status` = a status outside the
 * closed set; `unknown_danger` (F-B1) = a danger outside the closed set or absent —
 * never silently clamped; `malformed` = a discriminator/required-field/shape breach.
 * These reasons are an INTERNAL narrow-classification union, not error codes.
 */
export type NarrowPlanResult =
  | { readonly ok: true; readonly plan: NarrowedPlan }
  | {
      readonly ok: false;
      readonly reason: "unknown_status" | "unknown_danger" | "malformed";
      readonly detail: string;
    };

/** Stringify a wire value for a narrow-failure detail WITHOUT crashing on a hostile
 * value (F-B5: `String({toString:null})` throws — the narrower must never crash). */
function printable(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "unprintable value";
  }
}

const fail = (
  reason: "unknown_status" | "unknown_danger" | "malformed",
  detail: string,
): NarrowPlanResult => ({ ok: false, reason, detail });

/** Is this a well-formed row per the frozen item shape: an object with the named string keys? */
function hasStringKeys(entry: unknown, keys: readonly string[]): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const rec = entry as Record<string, unknown>;
  return keys.every((k) => typeof rec[k] === "string");
}

// R2-2: the FROZEN timestamp grammar — management-envelope.schema.json `$defs/timestamp`:
// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$` (RFC3339 UTC, Z-suffixed ONLY; the frozen
// $def admits no ±hh:mm offset). Capture groups feed the calendar round-trip below.
const FROZEN_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

/**
 * Parse a frozen-grammar timestamp to its COMPARISON instant (epoch ms), or `null` when the
 * string is not a real contract-valid instant. `Date.parse` finiteness is insufficient: it
 * accepts locale forms ("01/02/2026"), zone-less strings, and silently NORMALIZES impossible
 * fields (2026-02-30 → Mar 2; 24:00 → next-day 00:00). Normalization is detected by
 * re-serializing the fields and comparing each back to the input.
 *
 * R3-2 boundary fidelity:
 *   • LOW YEARS (0000–0099): built via `setUTCFullYear` on a zeroed Date — `Date.UTC` would
 *     apply its legacy 1900 offset and mis-round-trip them.
 *   • LEAP SECOND: `:60` is contract-valid (the frozen $def is pattern + "RFC3339 UTC"); the
 *     round-trip validates with seconds clamped to :59, and the comparison instant is one
 *     second AFTER :59 (RFC3339 semantics: the leap second ENDS the minute). Seconds 61–99
 *     are pattern-admitted but RFC-invalid — rejected.
 */
export function frozenTimestampMs(value: string): number | null {
  const m = FROZEN_TIMESTAMP.exec(value);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (s > 60) return null; // 61–99: grammatical fiction
  const leap = s === 60;
  // R4-1: RFC3339 §5.7 confines the leap second to 23:59:60Z ending the UTC day that closes
  // June or December — any year (future leap seconds are unpredictable; STRUCTURAL position is
  // the right fidelity). ITU's March/September secondary-preference slots are deliberately
  // excluded: §5.7 reads "to date" literally — no such leap second has ever occurred.
  if (leap && !(h === 23 && mi === 59 && ((mo === 6 && d === 30) || (mo === 12 && d === 31)))) {
    return null;
  }
  const sClamped = leap ? 59 : s;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, sClamped, 0);
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h ||
    dt.getUTCMinutes() !== mi ||
    dt.getUTCSeconds() !== sClamped
  ) {
    return null;
  }
  // R4-2: fraction policy is PAD/TRUNCATE to three digits (milliseconds) — never rounded, so a
  // fraction can NEVER roll into the next second and the expiry boundary is deterministic.
  const fractionMs = m[7] !== undefined ? Number((m[7].slice(1) + "00").slice(0, 3)) : 0;
  return dt.getTime() + (leap ? 1000 : 0) + fractionMs;
}

/** Does this string name a real, frozen-grammar contract instant? (R2-2 malformed gate.) */
function isFrozenTimestamp(value: string): boolean {
  return frozenTimestampMs(value) !== null;
}

/**
 * Defensively narrow a wire plan response. FAIL-CLOSED (A-6 / F-B): an unknown or
 * ABSENT danger is terminal (`unknown_danger` — a plan we cannot classify is never
 * applied and never silently escalated), an unknown/absent status is terminal, the
 * frozen v1.1.0 discriminators + required fields are checked, and a PRESENT-but-
 * malformed optional (diff / expires_at / confirm_string) is `malformed`. Never
 * throws — the caller decides how to surface a terminal result (a teachable, never
 * an apply).
 */
export function narrowPlan(raw: unknown): NarrowPlanResult {
  if (raw === null || typeof raw !== "object") {
    return fail("malformed", "plan response was not an object");
  }
  const obj = raw as Record<string, unknown>;

  // F-B4: the frozen v1.1.0 discriminator (management-plan.schema.json `object: const "plan"`).
  if (obj["object"] !== "plan") {
    return fail("malformed", `object is not "plan" (got ${printable(obj["object"])})`);
  }
  // F-B4: the frozen id pattern (`^plan_`).
  const id = obj["id"];
  if (typeof id !== "string" || !/^plan_/.test(id)) {
    return fail("malformed", "plan id is missing or does not match ^plan_");
  }

  const status = obj["status"];
  if (!isPlanStatus(status)) {
    // A-6: a status we cannot classify is terminal — never apply against it.
    return fail("unknown_status", printable(status) === "unprintable value" ? "unprintable status" : printable(status));
  }

  // F-B1 (A-6 ratified over the clamp): an unknown or ABSENT danger is TERMINAL — an
  // unclassifiable plan is never applied and never silently promoted to a PR ceremony.
  const danger = obj["danger"];
  if (!isDanger(danger)) {
    return fail("unknown_danger", danger === undefined ? "danger is absent" : printable(danger));
  }

  // F-B4: the remaining frozen `required` fields (safety-relevant presence + shape).
  const changes = obj["changes"];
  if (!Array.isArray(changes) || !changes.every((c) => hasStringKeys(c, ["action", "resource", "path"]))) {
    return fail("malformed", "changes is missing or not an array of {action, resource, path} entries");
  }
  if (typeof obj["state_hash"] !== "string") return fail("malformed", "state_hash is missing");
  if (typeof obj["gating"] !== "string") return fail("malformed", "gating is missing");
  if (typeof obj["created_at"] !== "string") return fail("malformed", "created_at is missing");

  // F-B2: diff is OPTIONAL, but a PRESENT diff must be an array of {op, resource, path}
  // rows (before/after stay unknown) — junk is malformed, never rendered.
  const rawDiff = obj["diff"];
  let diff: readonly PlanDiffEntry[] | null = null;
  if (rawDiff !== undefined) {
    if (!Array.isArray(rawDiff) || !rawDiff.every((d) => hasStringKeys(d, ["op", "resource", "path"]))) {
      return fail("malformed", "diff is present but not an array of {op, resource, path} entries");
    }
    diff = rawDiff as readonly PlanDiffEntry[];
  }

  // F-B3/R2-2: expires_at is OPTIONAL, but a PRESENT value must match the FROZEN timestamp
  // grammar (management-envelope.schema.json $defs/timestamp: RFC3339 UTC, Z-suffixed) with a
  // REAL calendar date-time — `Date.parse` finiteness is NOT enough (it accepts "01/02/2026",
  // offset forms the frozen $def forbids, and silently NORMALIZES 2026-02-30 → Mar 2). The
  // ceremony's expiry short-circuit compares this to the injected clock — junk must never
  // parse as "no expiry", and a normalized fiction must never parse as a real deadline.
  const rawExpires = obj["expires_at"];
  let expiresAt: string | null = null;
  if (rawExpires !== undefined) {
    if (typeof rawExpires !== "string" || !isFrozenTimestamp(rawExpires)) {
      return fail("malformed", "expires_at is present but not a frozen-grammar RFC3339 UTC timestamp");
    }
    expiresAt = rawExpires;
  }

  // Frozen type: string | null. A present non-string non-null value is malformed.
  const rawConfirm = obj["confirm_string"];
  if (rawConfirm !== undefined && rawConfirm !== null && typeof rawConfirm !== "string") {
    return fail("malformed", "confirm_string is present but neither a string nor null");
  }
  const confirmString = typeof rawConfirm === "string" ? rawConfirm : null;

  return {
    ok: true,
    plan: { id, status, danger, confirmString, diff, expiresAt, raw: raw as ManagementPlan },
  };
}
