// `media-quota` noun (T-220; N-011 quotas family — the media-cap singleton beside T-219's
// `quota` noun). SR read (get) + PR plan-kind writes (set/clear) over `media_quotas.upsert`.
// MCP (D9): this noun FOLDS to the `quota` tool names with the `{kind:media}` discriminator —
// `agkit_quota_read` / `agkit_quota_plan` — never derivable `agkit_media_quota_*` names.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { mediaQuotaGet, mediaQuotaGetArgs } from "./get";
import { mediaQuotaSetArgs, mediaQuotaSetChanges } from "./set";
import { mediaQuotaClearArgs, mediaQuotaClearChanges } from "./clear";
import { planMutationHandler } from "../plan/apply";

export const mediaQuotaCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "media-quota",
    verb: "get",
    summary: "Show the project's media quotas (absent = not configured).",
    args: mediaQuotaGetArgs,
    scopes: ["quotas:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-quota", "get"),
    examples: ["agkit media-quota get"],
    handler: mediaQuotaGet,
    execution: "remote",
  }),
  defineCommand({
    noun: "media-quota",
    verb: "set",
    summary: "Set ALL six media caps (each an explicit value or `unlimited`; prod-rebinding).",
    args: mediaQuotaSetArgs,
    scopes: ["quotas:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("media-quota", "set"),
    examples: [
      "agkit media-quota set --max-image-generations-per-day 1000 --max-audio-seconds-per-day 36000 --max-video-generations-per-day unlimited --max-dubbing-jobs-per-day 50 --monthly-media-budget-usd 500.00 --media-budget-alert-threshold-usd 400.00",
    ],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: mediaQuotaSetChanges },
    execution: "remote",
  }),
  defineCommand({
    noun: "media-quota",
    verb: "clear",
    summary: "Clear named media caps to unlimited (other caps carried forward unchanged).",
    args: mediaQuotaClearArgs,
    scopes: ["quotas:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("media-quota", "clear"),
    examples: ["agkit media-quota clear --max-video-generations-per-day"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: mediaQuotaClearChanges },
    execution: "remote",
  }),
];
