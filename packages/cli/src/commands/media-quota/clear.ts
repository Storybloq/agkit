// `media-quota clear <field flags>` args + plan-change builder (T-220; quotas:write, danger PR —
// the same `media_quotas.upsert` plan door as `set`, in RESET mode). SIX OPTIONAL boolean flags
// with the set-flag names: presence = "NULL this member"; ≥1 must be named (an omitted-flags
// clear-everything default would be silent scope expansion). The body carries all six members:
// named → null, unnamed → the live row's values VERBATIM (exactly the six projected off the read
// DTO — `object`/`created_at` dropped; §5-F11). Clear is UPDATE-only: an absent row is the honest
// not-found + hint (you cannot clear caps that were never configured — a create-with-nulls would
// INVENT a configuration). The plan door takes no client precondition; drift between the read and
// apply is the plan machinery's review + typed confirm.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { MEDIA_QUOTA_FLAG_TO_MEMBER } from "./set";

/** A boolean presence flag that also accepts an explicit `--flag true|false` (route-plane
 *  precedent; never `z.coerce.boolean` — Boolean("false") is true, a silent inversion). */
const clearFlag = z.union([z.boolean(), z.enum(["true", "false"])]).optional();
const isNamed = (v: boolean | "true" | "false" | undefined): boolean => v === true || v === "true";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const mediaQuotaClearArgs = z
  .object({
    "max-image-generations-per-day": clearFlag.describe("Clear the daily image-generation cap to unlimited."),
    "max-audio-seconds-per-day": clearFlag.describe("Clear the daily audio-seconds cap to unlimited."),
    "max-video-generations-per-day": clearFlag.describe("Clear the daily video-generation cap to unlimited."),
    "max-dubbing-jobs-per-day": clearFlag.describe("Clear the daily dubbing-jobs cap to unlimited."),
    "monthly-media-budget-usd": clearFlag.describe("Clear the monthly media budget to unlimited."),
    "media-budget-alert-threshold-usd": clearFlag.describe("Clear the alert threshold to unset."),
    confirm: confirmArg,
  })
  .strict()
  .superRefine((val, refCtx) => {
    const named = Object.keys(MEDIA_QUOTA_FLAG_TO_MEMBER).some((flag) =>
      isNamed((val as Record<string, boolean | "true" | "false" | undefined>)[flag]),
    );
    if (!named) {
      refCtx.addIssue({
        code: "custom",
        message: "nothing to clear — name at least one field flag (see `agkit media-quota clear --help`)",
      });
    }
  });
export type MediaQuotaClearInput = z.infer<typeof mediaQuotaClearArgs>;

/** Module constant (D13): the honest clear-on-absent-row teaching. */
export const MEDIA_QUOTA_CLEAR_404_HINT =
  "no media quotas are configured for this project — there is nothing to clear; `agkit media-quota set` creates the configuration";

// A row member the live read is contractually bound to carry (the CLOSED read DTO requires all
// six) arriving ABSENT is a protocol fault — carrying `undefined` forward would silently drop
// the member from the PUT body and 422 after the typed confirm.
const MEMBER_PROTOCOL_DETAIL =
  "the management API returned the media-quotas row without one of its six cap members — this is a server protocol error, not a request you can fix";

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC, D13): ONE same-family read, then ONE
 * `media_quota:update` change (update-only — clear NEVER creates).
 */
export async function mediaQuotaClearChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = mediaQuotaClearArgs.parse(input);
  const pid = requireProject(ctx);

  let base: unknown;
  try {
    base = await ctx.client.request({ operationId: "media_quotas.get", params: { pid } });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = MEDIA_QUOTA_CLEAR_404_HINT;
    }
    throw err;
  }

  const current = (base !== null && typeof base === "object" ? base : {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [flag, member] of Object.entries(MEDIA_QUOTA_FLAG_TO_MEMBER)) {
    if (isNamed((parsed as Record<string, boolean | "true" | "false" | undefined>)[flag])) {
      body[member] = null;
    } else {
      const value = current[member];
      if (value === undefined) {
        throw new CliLocalError("usage_error", { detail: MEMBER_PROTOCOL_DETAIL });
      }
      body[member] = value; // VERBATIM carry — including existing nulls and money strings
    }
  }

  return [
    {
      action: "update",
      resource: "media_quota",
      path: renderRoutePath("media_quotas.upsert", { pid }),
      body,
    },
  ];
}
