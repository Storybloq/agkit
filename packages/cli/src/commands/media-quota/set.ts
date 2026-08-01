// `media-quota set <six required cap flags>` args + plan-change builder (T-220; quotas:write,
// danger PR, wire `media_quotas.upsert` = plan_required PUT). The frozen $def requires ALL SIX
// members — the forced-explicit-choice shape is the POINT (the spend-caps footgun rule): every
// flag is REQUIRED, each taking an explicit value OR the literal `unlimited` (→ wire null =
// deliberately uncapped); an absent flag is a usage_error naming it, NEVER a silent null or
// default (§5-F11). Count flags accept the canonical decimal only (L-053 — no z.coerce
// laundering); money flags mirror the envelope `money_string` grammar. Both mirrors are
// DRIFT-LOCKED by the plane fixture against the pin-loaded $defs — the mirrors follow bytes.
// The alert≤budget cross-field invariant stays SERVER-owned (a 422 passthrough, §5-F9).
//
// AM-0b (presence congruence): plan.create rejects an `update` on an absent row / `create` on a
// present one, so the builder prefetches `media_quotas.get` and forks honestly (404 ⇒ create,
// present ⇒ update). The `media_quota:create` INSERT-ONLY race is fail-LOUD server-side
// (conflict/already_exists — never a silent no-op; §10-r2b-4/F15).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { WireProblemError } from "../../core/errors";

// Grammar mirrors (drift-locked at step 12 against the frozen bundle — never edit by memory).
export const MEDIA_COUNT_MAX = 10_000_000;
export const MEDIA_MONEY_RE = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;

const CANONICAL_INT_RE = /^(0|[1-9][0-9]*)$/;
const canonicalInt = (v: unknown): unknown =>
  typeof v === "string" && CANONICAL_INT_RE.test(v) ? Number(v) : v;

/** A count cap: canonical decimal 0..10000000, or the literal `unlimited` (→ wire null). */
const countCap = z.union([
  z.literal("unlimited").transform(() => null),
  z.preprocess(canonicalInt, z.number().int().min(0).max(MEDIA_COUNT_MAX)),
]);
/** A money cap: 2-dp non-negative USD decimal STRING, or the literal `unlimited` (→ wire null). */
const moneyCap = z.union([
  z.literal("unlimited").transform(() => null),
  z.string().regex(MEDIA_MONEY_RE, 'must be a 2-decimal USD string (e.g. "100.00") or `unlimited`'),
]);

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const mediaQuotaSetArgs = z
  .object({
    "max-image-generations-per-day": countCap.describe("Daily image-generation cap (int or `unlimited`)."),
    "max-audio-seconds-per-day": countCap.describe("Daily audio-seconds cap (int or `unlimited`)."),
    "max-video-generations-per-day": countCap.describe("Daily video-generation cap (int or `unlimited`)."),
    "max-dubbing-jobs-per-day": countCap.describe("Daily dubbing-jobs cap (int or `unlimited`)."),
    "monthly-media-budget-usd": moneyCap.describe('Monthly media budget (2-dp USD string or `unlimited`).'),
    "media-budget-alert-threshold-usd": moneyCap.describe(
      "Alert threshold (2-dp USD string or `unlimited`; server enforces threshold <= budget).",
    ),
    confirm: confirmArg,
  })
  .strict();
export type MediaQuotaSetInput = z.infer<typeof mediaQuotaSetArgs>;

// The POST-transform shape — what the dispatcher hands the builder AFTER `mediaQuotaSetArgs`
// ran (`unlimited` is already null). The builder's defensive re-check must use THIS schema:
// re-running the INPUT grammar is non-idempotent (`null` fails the `unlimited` literal), which
// crashed every `unlimited` cap with a raw ZodError before any wire call (found via T-226 S3b).
// The input grammar above is untouched — `null` is NOT a legal caller spelling anywhere.
const parsedCount = z.union([z.null(), z.number().int().min(0).max(MEDIA_COUNT_MAX)]);
const parsedMoney = z.union([z.null(), z.string().regex(MEDIA_MONEY_RE)]);
const mediaQuotaSetParsed = z
  .object({
    "max-image-generations-per-day": parsedCount,
    "max-audio-seconds-per-day": parsedCount,
    "max-video-generations-per-day": parsedCount,
    "max-dubbing-jobs-per-day": parsedCount,
    "monthly-media-budget-usd": parsedMoney,
    "media-budget-alert-threshold-usd": parsedMoney,
    confirm: confirmArg,
  })
  .strict();

/** kebab flag → snake wire member (the six, verbatim) — shared with `clear`. */
export const MEDIA_QUOTA_FLAG_TO_MEMBER: Readonly<Record<string, string>> = {
  "max-image-generations-per-day": "max_image_generations_per_day",
  "max-audio-seconds-per-day": "max_audio_seconds_per_day",
  "max-video-generations-per-day": "max_video_generations_per_day",
  "max-dubbing-jobs-per-day": "max_dubbing_jobs_per_day",
  "monthly-media-budget-usd": "monthly_media_budget_usd",
  "media-budget-alert-threshold-usd": "media_budget_alert_threshold_usd",
};

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC). Emits ONE change whose body ALWAYS
 * carries all six members (values or nulls — never a partial), action forked on presence (AM-0b).
 */
export async function mediaQuotaSetChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = mediaQuotaSetParsed.parse(input);
  const pid = requireProject(ctx);

  const body: Record<string, unknown> = {};
  for (const [flag, member] of Object.entries(MEDIA_QUOTA_FLAG_TO_MEMBER)) {
    body[member] = (parsed as Record<string, unknown>)[flag] as number | string | null;
  }

  let base: unknown | null;
  try {
    base = await ctx.client.request({ operationId: "media_quotas.get", params: { pid } });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      base = null; // no row yet — first-time configuration (the create arm)
    } else {
      throw err;
    }
  }

  return [
    {
      action: base === null ? "create" : "update",
      resource: "media_quota",
      path: renderRoutePath("media_quotas.upsert", { pid }),
      body,
    },
  ];
}
