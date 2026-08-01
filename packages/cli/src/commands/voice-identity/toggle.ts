// `voice-identity enable|disable <key> [--provider <p>]` — direct_confirm PR ceremonies over
// `identity.toggle` (T-220 §3; PATCH, if_match, idempotency required). direct_confirm because
// ENABLE re-validates the bound resource live at the provider (external, non-transactional) —
// the plan door is closed (`voice_identity:invoke` executable:false). The typed confirm is the
// identity KEY (D3 — `expectedConfirm = key`, local RC-2). The captured ETag is REQUIRED,
// fail-closed BEFORE any prompt (T-217 R-H#3: `(provider,key)` is a reusable natural key — an
// unpinned toggle could flip a row that was deleted+rebound after the preview). Provider comes
// from `--provider` or the S3 bounded scan — resolution failures also terminate pre-prompt.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, readCapturedEtag } from "../types";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";
import { resolveIdentityProvider } from "./resolve";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The identity KEY, to confirm (required non-interactively; checked locally and by the server).");

export const voiceIdentityToggleArgs = z
  .object({
    key: z.string().min(1).describe("Identity key (the row's natural key; also the typed confirm value)."),
    provider: z.string().min(1).optional().describe("Provider owning the key (skips the list scan)."),
    confirm: confirmArg,
  })
  .strict();
export type VoiceIdentityToggleInput = z.infer<typeof voiceIdentityToggleArgs>;

// The same fail-closed contract-integrity error class as set's rebind arm.
const ETAGLESS_DETAIL =
  "the management API returned this voice identity without an ETag, so the toggle precondition cannot be constructed — this is a server protocol error, not a request you can fix";

const KEY_CAP = 128;
const PROVIDER_CAP = 64;

/** A current-state preview line from the probe DTO (F5: the resourceId-free projection). */
function stateLine(raw: unknown, member: string): string {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[member];
  return `current ${member}: ${value === undefined ? "(not reported)" : JSON.stringify(value)}`;
}

/**
 * Build the direct_confirm `prepare` for one toggle direction. Provider resolution (flag ??
 * S3 scan) and the `identity.get` ETag capture BOTH precede any prompt; a keyed 404 is the
 * teachable not-found.
 */
export function prepareVoiceIdentityToggle(enabled: boolean) {
  return async function prepare(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
    const parsed = voiceIdentityToggleArgs.parse(input);
    const pid = requireProject(ctx);
    const provider = parsed.provider ?? (await resolveIdentityProvider(ctx, parsed.key)).provider;

    let raw: unknown;
    try {
      raw = await ctx.client.request({
        operationId: "identity.get",
        params: { pid, provider, key: parsed.key },
        captureMeta: true,
      });
    } catch (err) {
      if (err instanceof WireProblemError && err.problem.status === 404) {
        throw new CliLocalError("usage_error", {
          detail: `no voice identity with key '${displayCapped(parsed.key, KEY_CAP)}' under provider '${displayCapped(provider, PROVIDER_CAP)}'`,
          hint: "agkit voice-identity list",
        });
      }
      throw err;
    }

    const etag = readCapturedEtag(raw);
    if (etag === undefined) {
      throw new CliLocalError("usage_error", { detail: ETAGLESS_DETAIL });
    }

    const lines = [
      `key: ${parsed.key}`,
      `provider: ${provider}`,
      stateLine(raw, "enabled"),
      stateLine(raw, "validation_status"),
      `target enabled state: ${enabled}`,
    ];
    if (enabled) {
      lines.push(
        "enable re-validates the bound resource live (fail-closed: the identity only becomes valid if the provider confirms it)",
      );
    }
    return {
      preview: {
        title: enabled
          ? "Enable this voice identity (prod-rebinding)."
          : "Disable this voice identity (the binding is kept; enable restores it).",
        lines,
      },
      expectedConfirm: parsed.key,
      ifMatch: etag,
      target: { provider, key: parsed.key },
    };
  };
}

/** Build the handler for one toggle direction (TOCTOU: params from `pass.target` only). */
export function voiceIdentityToggleHandler(
  enabled: boolean,
  staleHint: string,
): CommandHandler<VoiceIdentityToggleInput> {
  return async (ctx) => {
    const pass = ctx.ceremony;
    if (pass === undefined || pass.kind !== "direct") {
      throw new Error("agkit: internal — voice-identity toggle requires a direct_confirm ceremony pass on ctx.ceremony");
    }
    if (typeof pass.ifMatch !== "string") {
      throw new Error("agkit: internal — voice-identity toggle pass is missing the prepared If-Match ETag");
    }
    const provider = pass.target?.provider;
    const key = pass.target?.key;
    if (typeof provider !== "string" || typeof key !== "string") {
      throw new Error("agkit: internal — voice-identity toggle ceremony pass is missing its prepared target");
    }
    const pid = requireProject(ctx);

    try {
      const resp = await ctx.client.request({
        operationId: "identity.toggle",
        params: { pid, provider, key, enabled, confirm: pass.confirm },
        preconditions: { ifMatch: pass.ifMatch },
      });
      return { data: resp };
    } catch (err) {
      if (err instanceof WireProblemError && err.problem.status === 412) {
        err.hintOverride = staleHint;
      }
      throw err;
    }
  };
}

// Race teaching: a 412 is terminal for THIS invocation — re-run to re-review current state.
export const HINT_412_ENABLE =
  "the voice identity changed since the preview — re-run `agkit voice-identity enable` to review current state";
export const HINT_412_DISABLE =
  "the voice identity changed since the preview — re-run `agkit voice-identity disable` to review current state";

export const prepareVoiceIdentityEnable = prepareVoiceIdentityToggle(true);
export const prepareVoiceIdentityDisable = prepareVoiceIdentityToggle(false);
export const voiceIdentityEnable = voiceIdentityToggleHandler(true, HINT_412_ENABLE);
export const voiceIdentityDisable = voiceIdentityToggleHandler(false, HINT_412_DISABLE);
