// `voice-identity delete <key> [--provider <p>]` args + plan-change builder (T-220 §3; wire
// `identity.delete` = DELETE, PR+D → CLI "PR" via projectWireDanger, gating plan_required,
// identities:destroy, if_match). The plan door is the ONLY legal path (CHANGE_TABLE
// `voice_identity:delete` → executable, defName BODYLESS) — the change carries NO `body` key
// (GAP-12). The typed confirm is the SERVER plan confirm_string (challenge "confirm-string",
// D5 — NOT the identity key; the project-archive precedent). HARD delete: a live voice bound
// to this identity re-binds — the summary says so.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveIdentityProvider } from "./resolve";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const voiceIdentityDeleteArgs = z
  .object({
    key: z.string().min(1).describe("Identity key (the row's natural key, with its provider)."),
    provider: z.string().min(1).optional().describe("Provider owning the key (skips the list scan)."),
    confirm: confirmArg,
  })
  .strict();
export type VoiceIdentityDeleteInput = z.infer<typeof voiceIdentityDeleteArgs>;

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC — provider resolution may read). With
 * `--provider`: ZERO client calls (pinned by test). Without: exactly one bounded S3 scan; a 0/≥2
 * result throws the teachable refusal BEFORE any plan.create.
 */
export async function voiceIdentityDeleteChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = voiceIdentityDeleteArgs.parse(input);
  const pid = requireProject(ctx);
  const provider = parsed.provider ?? (await resolveIdentityProvider(ctx, parsed.key)).provider;
  return [
    {
      action: "delete",
      resource: "voice_identity",
      path: renderRoutePath("identity.delete", { pid, provider, key: parsed.key }),
      // NO `body` member — the identity.delete request is BODYLESS (defName null).
    },
  ];
}
