// `voice-identity revalidate <key> [--provider <p>]` — the M-direct ceremony (T-220 D4 as
// corrected by r2b-3; wire `identity.revalidate` = POST, danger M, gating direct,
// identities:write, idempotency required). Consumes T-215's `kind:"direct"` seam at exactly M
// (`--yes` or TTY y/N; no typed confirm — the registry teeth forbid one on kind:direct).
//
// r2b-3 (byte-verified server semantics): the 200 body `{verdict, persisted, checked_at,
// identity}` sets `persisted` PURELY by transient-vs-definitive — DEFINITIVE verdicts
// (valid/invalid/unvalidated) are recorded on the row ({validation_status, last_checked_at}
// only; `is_enabled` never touched) ⇒ persisted:true; TRANSIENT results (auth_failed/
// unavailable/no_credential) write NOTHING ⇒ persisted:false with the OLD checked_at. A genuine
// rebind/delete race is NEVER a 200: vanished row ⇒ 404; rebound/stale row ⇒ 409
// {revalidation_stale}. The CLI renders the body VERBATIM (§5-F3: persisting, caching, or
// re-labeling any of it client-side would be the §B-9 lie) and exits 0 on ANY 200 — the verdict
// is data, not an error.
import { z } from "zod";
import type { CommandHandler, Ctx } from "../types";
import { requireProject } from "../types";
import { WireProblemError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";
import { resolveIdentityProvider } from "./resolve";

export const voiceIdentityRevalidateArgs = z
  .object({
    key: z.string().min(1).describe("Identity key (the row's natural key, with its provider)."),
    provider: z.string().min(1).optional().describe("Provider owning the key (skips the list scan)."),
  })
  .strict();
export type VoiceIdentityRevalidateInput = z.infer<typeof voiceIdentityRevalidateArgs>;

const KEY_CAP = 128;

/** The PURE preview (T-215 Seam-1 contract: input-derived only, ZERO wire calls). */
export function voiceIdentityRevalidatePreview(input: unknown): { title: string; lines: readonly string[] } {
  const parsed = voiceIdentityRevalidateArgs.parse(input);
  return {
    title: "voice-identity revalidate",
    lines: [
      `re-checks '${displayCapped(parsed.key, KEY_CAP)}' against the live provider`,
      "records definitive verdicts (valid/invalid/unvalidated) on the identity row; reports transient results (auth-failure/provider-unavailable/no-credential) honestly without persisting",
      "the binding and enabled state are untouched",
      "returns the verdict; exit 0",
    ],
  };
}

const HINT_409 = "state changed under the check — re-run `agkit voice-identity revalidate`";

/**
 * Runs ONLY on a `{kind:"proceed"}` pass (T-215 invariant: `runDirect` itself makes zero client
 * calls — the SR provider-resolution read happens POST-proceed, here).
 */
export const voiceIdentityRevalidate: CommandHandler<VoiceIdentityRevalidateInput> = async (ctx, input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "proceed") {
    throw new Error("agkit: internal — voice-identity revalidate requires a proceed ceremony pass on ctx.ceremony");
  }
  const parsed = voiceIdentityRevalidateArgs.parse(input);
  const pid = requireProject(ctx);
  const provider = parsed.provider ?? (await resolveIdentityProvider(ctx, parsed.key)).provider;

  try {
    const resp = await ctx.client.request({
      operationId: "identity.revalidate",
      params: { pid, provider, key: parsed.key },
    });
    // VERBATIM passthrough (§5-F3): {verdict, persisted, checked_at, identity} — no client
    // reshaping, no re-labeling, exit 0 regardless of the verdict value.
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 409) {
      err.hintOverride = HINT_409;
    }
    throw err;
  }
};
