// `publishable-key revoke <id>` handler + its direct_confirm ceremony `prepare` (T-216 R7; N-011
// keys family, keys:destroy, danger D). The wire route `publishable_key.revoke` is
// gating:"direct_confirm" + concurrency:"if_match" + idempotency:"required" — wired through T-212's
// LANDED mutation ceremony (runDirectConfirm), the token-revoke precedent verbatim.
//
// Two halves, both pure over injected seams:
//   • `preparePublishableKeyRevoke(ctx, input)` (the mutation binding, RC-8 — invoked EXACTLY once
//     by the dispatch hook BEFORE the handler): `publishable_key.get` the row WITH `captureMeta` to
//     read its ETag. Returns a DirectConfirmPrepared whose `expectedConfirm` is the key NAME (the
//     server re-verifies `{confirm}` == name → 422 on mismatch) and whose `ifMatch` is that ETag
//     (PL-13 optimistic concurrency). The id is the positional (no prefix resolver here — unlike
//     token revoke, publishable keys are addressed by id directly), carried on `target` for the
//     TOCTOU close.
//   • `publishableKeyRevoke(ctx)` (the handler): reads the ceremony's `{confirm, ifMatch, target}`
//     pass off `ctx.ceremony` and sends the revoke — `{confirm}` body + `If-Match` precondition +
//     an auto Idempotency-Key (client-owned). An already-revoked key (409 conflict /
//     reason:"already_revoked") renders as an idempotent teachable SUCCESS (exit 0): the desired
//     end state already holds, so it is NOT an error (no new error code — token-revoke canonical).
//
// Secret confinement: `masked_secret` is already masked by the server (and the `masked_secret` FIELD
// re-masks at the chokepoint); the name is not a secret; every preview line is redacted +
// terminal-safe through the ceremony's chokepoint. Nothing secret rides the request or the render.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, readCapturedEtag } from "../types";
import { CliLocalError, WireProblemError } from "../../core/errors";

export const publishableKeyRevokeArgs = z
  .object({
    id: z.string().min(1).describe("Publishable key id to revoke."),
    // Per-spec typed-confirm channel (NEVER a global flag): the key NAME the server re-verifies. On
    // a TTY it is prompted; non-interactively it is REQUIRED (with --yes).
    confirm: z.string().optional().describe("The publishable key's name, to confirm the revoke (required non-interactively)."),
  })
  .strict();
export type PublishableKeyRevokeInput = z.infer<typeof publishableKeyRevokeArgs>;

/** A non-empty string member of a fetched row (`undefined` when absent/empty/non-string). */
function pickString(raw: unknown, key: string): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The direct_confirm ceremony binding's `prepare` (RC-8, invoked once before any render/prompt).
 * Etag-fetches the target row and returns the preview + the confirm authority (the key NAME) + the
 * If-Match ETag. When the row omits a usable name, `expectedConfirm` is OMITTED — the ceremony then
 * forwards the operator's typed value verbatim and the server teaches (422), rather than demanding a
 * value the CLI could not display (display-is-authority).
 */
export async function preparePublishableKeyRevoke(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = input as PublishableKeyRevokeInput;
  const pid = requireProject(ctx);
  const id = parsed.id;
  const raw = await ctx.client.request({
    operationId: "publishable_key.get",
    params: { pid, id },
    captureMeta: true,
  });
  const name = pickString(raw, "name");
  const maskedSecret = pickString(raw, "masked_secret");
  const createdAt = pickString(raw, "created_at");
  const etag = readCapturedEtag(raw);
  // R7 fail-closed (route concurrency:"if_match"): the revoke MUST carry an If-Match precondition
  // (the sibling provider-key revoke standard). Abort PRE-PROMPT if the GET did not yield a usable
  // ETag — sending an unconditioned destructive revoke would open the TOCTOU window the preview is
  // meant to close. No new code: the server failing to advertise the required concurrency token is a
  // protocol condition the operator cannot fix (the malformed-mint X3 rationale).
  if (etag === undefined) {
    throw new CliLocalError("usage_error", {
      detail:
        "the management API did not return an ETag for this publishable key, so the revoke cannot be safely conditioned (If-Match) — this is a server protocol error, not a request you can fix",
    });
  }

  const lines = [`id:      ${id}`];
  if (name !== undefined) lines.push(`name:    ${name}`);
  if (maskedSecret !== undefined) lines.push(`key:     ${maskedSecret}`);
  if (createdAt !== undefined) lines.push(`created: ${createdAt}`);
  lines.push("revoking bricks shipped apps using this key");

  const prepared: {
    preview: DirectConfirmPrepared["preview"];
    expectedConfirm?: string;
    ifMatch: string;
    target: { id: string };
  } = {
    preview: { title: "Revoke this publishable key — apps using it stop working immediately.", lines },
    // TOCTOU close: revoke EXACTLY the id resolved+previewed+etag-got here (never a re-resolve).
    target: { id },
    // Guaranteed non-empty by the fail-closed guard above (route concurrency:"if_match").
    ifMatch: etag,
  };
  if (name !== undefined) prepared.expectedConfirm = name;
  return prepared;
}

export const publishableKeyRevoke: CommandHandler<PublishableKeyRevokeInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    // The dispatch hook always resolves a direct_confirm pass for this spec before the handler; a
    // missing/mis-kinded pass is an internal wiring fault, never a user-facing path.
    throw new Error("agkit: internal — publishable-key revoke requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  // TOCTOU close: revoke EXACTLY the id `prepare` reviewed (carried on the pass), NOT a re-resolve.
  const targetId = pass.target?.id;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("agkit: internal — publishable-key revoke ceremony pass is missing the prepared target id");
  }
  // R7 fail-closed: `prepare` guarantees a non-empty ifMatch (route concurrency:"if_match"); a missing
  // one here is an internal wiring fault, never an unconditioned revoke.
  if (typeof pass.ifMatch !== "string" || pass.ifMatch.length === 0) {
    throw new Error("agkit: internal — publishable-key revoke ceremony pass is missing the required If-Match ETag");
  }
  const pid = requireProject(ctx);

  try {
    const raw = await ctx.client.request({
      operationId: "publishable_key.revoke",
      params: { pid, id: targetId, confirm: pass.confirm },
      preconditions: { ifMatch: pass.ifMatch },
    });
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      data: { ...r, id: targetId, revoked: true },
      meta: { note: "publishable key revoked — apps using it stop working immediately" },
    };
  } catch (err) {
    // Idempotent already-revoked (409 conflict / reason:"already_revoked"): the desired end state
    // (revoked) already holds → a teachable SUCCESS, not an error (no new error code).
    if (
      err instanceof WireProblemError &&
      err.problem.status === 409 &&
      err.problem.code === "conflict" &&
      err.problem["reason"] === "already_revoked"
    ) {
      return {
        data: { id: targetId, revoked: true, already_revoked: true },
        meta: { note: "this publishable key was already revoked — no change was made (revocation is idempotent)" },
      };
    }
    throw err;
  }
};
