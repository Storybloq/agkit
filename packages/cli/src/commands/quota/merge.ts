// Pure quota merge (T-219 §2 S-C; L2-CLI-14 D-6/D-7 + r5-3). The wire body `quotas_upsert_request`
// (management-resources.schema.json) is CLOSED with ALL SIX members REQUIRED — "forced explicit
// choice; null = deliberate uncapped (never a silent default)" ($comment). The CLI's `quota set`
// and `quota clear` are PARTIAL grammars over that all-required body, so the plan-change builders
// read the server's current state and merge here: named members are overridden (set) or nulled
// (clear); unnamed members carry the server's OWN current values forward. The CLI NEVER invents a
// cap value (FORBIDDEN 5).
//
// The field table below is the plane's single authority for member names + per-member grammar. It
// is CONTRACT-DERIVED-TESTED (merge.test.ts cross-checks names, requiredness, nullability, and
// bounds against the pin-derived RS bytes — a hand-edit here that drifts from the frozen $def
// reddens; FORBIDDEN 12). T-220's media-quota mirrors this module (documented hand-off).
import { CliLocalError } from "../../core/errors";

/** Per-member wire grammar (mirrors the frozen $def; cross-checked by the contract-derived test). */
export interface QuotaFieldMeta {
  /** May the member be `null` (= deliberately uncapped)? RPS is the ONE non-nullable member. */
  readonly nullable: boolean;
  /** Value grammar: `int` (JSON integer with bounds) | `counter` (bigint string) | `money` (2-dp USD string). */
  readonly kind: "int" | "counter" | "money";
  readonly min?: number;
  readonly max?: number;
}

/** The six wire members of `quotas_upsert_request`, in the $def's `required` order. */
export const QUOTA_FIELDS: Readonly<Record<string, QuotaFieldMeta>> = {
  max_requests_per_second_per_user: { nullable: false, kind: "int", min: 1, max: 1000 },
  max_turns_per_day_per_user: { nullable: true, kind: "int", min: 0, max: 1_000_000 },
  monthly_token_cap: { nullable: true, kind: "counter" },
  monthly_spend_cap_usd: { nullable: true, kind: "money" },
  max_monthly_spend_per_user_usd: { nullable: true, kind: "money" },
  monthly_spend_alert_threshold_usd: { nullable: true, kind: "money" },
};

export const QUOTA_FIELD_NAMES: readonly string[] = Object.keys(QUOTA_FIELDS);

/** The nullable five — the ONLY legal `quota clear --fields` vocabulary (D-7). */
export const NULLABLE_QUOTA_FIELDS: readonly string[] = QUOTA_FIELD_NAMES.filter(
  (name) => QUOTA_FIELDS[name]!.nullable,
);

/** Form mirrors of the frozen envelope grammars (cross-checked against RS bytes by the test). */
export const COUNTER_STRING_RE = /^(0|[1-9][0-9]*)$/;
export const MONEY_STRING_RE = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;

// D-6: the ONE member with no legal null — a first-time configuration MUST state it explicitly.
const FIRST_TIME_RPS_DETAIL =
  "this project has no quota configuration yet — a first `agkit quota set` must state --max-requests-per-second-per-user explicitly (an integer 1..1000; the contract has no default and the CLI never invents one)";

// A carried-forward member missing from the server's own read DTO is the SERVER breaking its
// contract — refuse rather than fabricate (the same honesty rail as the list-envelope validation).
const PROTOCOL_DETAIL =
  "the management API's quota read is missing a required member, so the unnamed values cannot be carried forward — this is a server protocol error, not a request you can fix";

/**
 * Merge the full six-member `quotas_upsert_request` body (pure, total over its contract):
 *   • `base` — the server's current read DTO (or `null` when `quotas.get` 404'd: no row yet).
 *     ONLY the six wire members are picked from it — read-only usage members (`tokens_used`,
 *     `spend_usd`) and envelope residue (`object`, `etag`) never reach the write body.
 *   • `set`  — snake_case member overrides (from `quota set` flags), already grammar-validated.
 *   • `clear` — member names to null (from `quota clear --fields`), already validated ∈ nullable five.
 * Base-null rules (D-6): unnamed nullable members are `null` (= uncapped, the contract's own
 * meaning); an unnamed RPS is a static `usage_error` — the CLI never invents the one required cap.
 */
export function mergeQuotaBody(
  base: unknown | null,
  set: Readonly<Record<string, unknown>>,
  clear: readonly string[],
): Record<string, unknown> {
  const clearSet = new Set(clear);
  for (const name of clearSet) {
    // Defence-in-depth: callers validate the clear vocabulary; a non-nullable member reaching the
    // merge anyway must fail loud, never emit an illegal null.
    if (!QUOTA_FIELDS[name]?.nullable) {
      throw new CliLocalError("usage_error", {
        detail: "--fields may only name clearable (nullable) quota members",
      });
    }
  }

  const baseObj =
    base !== null && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : null;

  const body: Record<string, unknown> = {};
  for (const name of QUOTA_FIELD_NAMES) {
    if (clearSet.has(name)) {
      body[name] = null;
    } else if (Object.prototype.hasOwnProperty.call(set, name)) {
      body[name] = set[name];
    } else if (baseObj !== null) {
      if (!Object.prototype.hasOwnProperty.call(baseObj, name)) {
        throw new CliLocalError("usage_error", { detail: PROTOCOL_DETAIL });
      }
      body[name] = baseObj[name];
    } else if (QUOTA_FIELDS[name]!.nullable) {
      // First-time configuration: an unnamed nullable member is a DELIBERATE uncapped null —
      // exactly the contract's own semantics, not an invented value.
      body[name] = null;
    } else {
      throw new CliLocalError("usage_error", { detail: FIRST_TIME_RPS_DETAIL });
    }
  }
  return body;
}
