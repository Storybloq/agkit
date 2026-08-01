// `token revoke` handler + its direct_confirm ceremony `prepare` (T-213 S12; N-011 tokens family,
// tokens:destroy, danger D). The wire route `management_token.revoke` is
// gating:"direct_confirm" + concurrency:"if_match" + idempotency:"required" — so this is wired
// through T-212's LANDED mutation ceremony (runDirectConfirm), never a hand-rolled parallel one.
//
// Two halves, both pure over injected seams:
//   • `prepare(ctx, input)` (the mutation binding, RC-8: invoked EXACTLY once by the dispatch hook
//     BEFORE the handler): resolve the id-or-prefix → id (the S10 resolver), then `management_token.get`
//     the row WITH `captureMeta` to read its ETag. Returns a DirectConfirmPrepared whose
//     `expectedConfirm` is the token NAME (the server verifies `{confirm}` == name; a mismatch →
//     422 confirm_required) and whose `ifMatch` is that ETag (PL-13 optimistic concurrency). The
//     ceremony renders the redacted preview + the `confirm value: <name>` authority line and runs
//     the typed-confirm / non-TTY-halt paths — accepted AS-IS (the ratified T-212 seam).
//   • `tokenRevoke(ctx, input)` (the handler): reads the ceremony's `{confirm, ifMatch}` pass off
//     `ctx.ceremony`, resolves the id, and sends the revoke — `{confirm}` body + `If-Match`
//     precondition + an auto Idempotency-Key (A27, client-owned). An already-revoked token
//     (409 conflict / reason:"already_revoked") renders as an idempotent teachable success (exit
//     0): the desired end state already holds, so it is NOT an error (no new error code).
//
// Secret confinement: the fetched row NEVER carries a raw secret (`toTokenDisplayRow` rekeys
// `masked_secret` → `display`), the name is not a secret, and every preview line is redacted +
// terminal-safe through the ceremony's chokepoint. Nothing secret rides the request or the render.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, readCapturedEtag } from "../types";
import { WireProblemError } from "../../core/errors";
import { resolveTokenId } from "./resolve";
import { toTokenDisplayRow, UNKNOWN_DISPLAY } from "./dto";

export const tokenRevokeArgs = z
  .object({
    id: z.string().min(1).describe("Token id (a UUID) or an unambiguous id/display prefix."),
    // Per-spec typed-confirm channel (NEVER a global flag — F4 strip-set hazard): the token NAME
    // the server verifies. On a TTY it is prompted; non-interactively it is REQUIRED (with --yes).
    confirm: z.string().optional().describe("The token name, to confirm the revoke (required non-interactively)."),
  })
  .strict();
export type TokenRevokeInput = z.infer<typeof tokenRevokeArgs>;

/** The raw, non-placeholder token name from a fetched row — `undefined` when the row omits it. */
function realName(raw: unknown): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = r.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * The direct_confirm ceremony binding's `prepare` (RC-8, invoked once before any render/prompt).
 * Resolves the target, etag-fetches its row, and returns the preview + the confirm authority (the
 * token NAME) + the If-Match ETag. When the row omits a usable name, `expectedConfirm` is OMITTED —
 * the ceremony then forwards the operator's typed value verbatim and the server teaches (422
 * confirm_required), rather than demanding a value the CLI could not display (display-is-authority).
 */
export async function prepareTokenRevoke(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = input as TokenRevokeInput;
  const pid = requireProject(ctx);
  const id = await resolveTokenId(ctx, parsed.id);
  const raw = await ctx.client.request({
    operationId: "management_token.get",
    params: { pid, id },
    captureMeta: true,
  });
  const row = toTokenDisplayRow(raw);
  const name = realName(raw);
  const etag = readCapturedEtag(raw);

  const lines = [
    `id:      ${row.id}`,
    `name:    ${row.name}`,
    `display: ${row.display}`,
  ];
  if (row.revoked_at !== null) lines.push(`already revoked at: ${row.revoked_at}`);

  const prepared: {
    preview: DirectConfirmPrepared["preview"];
    expectedConfirm?: string;
    ifMatch?: string;
    target: { id: string };
  } = {
    preview: { title: "Revoke this management token — it stops working immediately.", lines },
    // TOCTOU close (S12 review): carry the CANONICAL id resolved+previewed+etag-got HERE so the
    // handler revokes EXACTLY this row — never a re-resolve of the prefix that a changed live
    // listing could rebind to a different token (a shared name defeats the confirm check; an absent
    // ETag defeats If-Match). A destructive op must act on the reviewed target.
    target: { id },
  };
  // `expectedConfirm` only when a genuine, displayable name exists (never the `(unknown)`
  // placeholder — an operator cannot type a value the CLI never showed).
  if (name !== undefined && name !== UNKNOWN_DISPLAY) prepared.expectedConfirm = name;
  if (etag !== undefined) prepared.ifMatch = etag;
  return prepared;
}

export const tokenRevoke: CommandHandler<TokenRevokeInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    // The dispatch hook always resolves a direct_confirm pass for this spec before the handler; a
    // missing/mis-kinded pass is an internal wiring fault, never a user-facing path.
    throw new Error("agkit: internal — token revoke requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  // TOCTOU close (S12 review): revoke EXACTLY the id `prepare` resolved+reviewed (carried on the
  // pass), NOT a re-resolve of `_input.id`. Re-resolving could bind a DIFFERENT token if the live
  // listing changed between prepare and now — and since the operator confirmed the reviewed row's
  // NAME (which another token may share) with a possibly-absent ETag, nothing else would catch the
  // substitution. A missing/non-string target is an internal wiring fault (prepare always sets it).
  const targetId = pass.target?.id;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("agkit: internal — token revoke ceremony pass is missing the prepared target id");
  }
  const pid = requireProject(ctx);
  const id = targetId;

  try {
    const raw = await ctx.client.request({
      operationId: "management_token.revoke",
      params: { pid, id, confirm: pass.confirm },
      preconditions: pass.ifMatch !== undefined ? { ifMatch: pass.ifMatch } : undefined,
    });
    const row = toTokenDisplayRow(raw);
    return { data: { ...row, revoked: true }, meta: { note: "token revoked — the secret stops working immediately" } };
  } catch (err) {
    // Idempotent already-revoked (409 conflict / reason:"already_revoked"): the desired end state
    // (revoked) already holds, so this is a teachable SUCCESS, not an error — no new error code.
    if (
      err instanceof WireProblemError &&
      err.problem.status === 409 &&
      err.problem.code === "conflict" &&
      err.problem["reason"] === "already_revoked"
    ) {
      return {
        data: { id, revoked: true, already_revoked: true },
        meta: { note: "this token was already revoked — no change was made (revocation is idempotent)" },
      };
    }
    throw err;
  }
};
