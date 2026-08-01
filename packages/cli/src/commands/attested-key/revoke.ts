// `attested-key revoke` handler + its direct_confirm ceremony `prepare` (T-214 step 9; L2-CLI-16,
// attest:destroy, danger D). The wire route `attested_key.revoke` is gating:"direct_confirm" +
// concurrency:"if_match" + idempotency:"required" — so this is wired through T-212's LANDED mutation
// ceremony (runDirectConfirm), never a hand-rolled parallel one. It is the SECOND direct_confirm
// consumer, structurally MIRRORING `token/revoke.ts` — with ONE deliberate divergence (RC-11, below).
//
// Two halves, both pure over injected seams (mirror token revoke):
//   • `prepareAttestedKeyRevoke(ctx, input)` (the mutation binding, RC-8: invoked EXACTLY once by the
//     dispatch hook BEFORE any render/prompt). Unlike token revoke there is NO prefix resolution:
//     `--id` is the attested-key ROW uuid, used VERBATIM. Two modes:
//       – `--if-match` supplied → use it verbatim as `ifMatch`, SKIP the lookup, and OMIT
//         `expectedConfirm` (without a lookup the CLI cannot DISPLAY the key_id, so it cannot
//         pre-verify — the server teaches via 422; RC-2 forward-verbatim). Preview from args only.
//       – else → a BOUNDED early-stop list search (`findInList` over `attested_key.list`) for the row
//         whose id === `--id`; take its `etag` (→ `ifMatch`, PL-13 optimistic concurrency) and its
//         `key_id` (→ `expectedConfirm`). A lookup that cannot COMPLETE (no match / cap / cycle /
//         retry-exhausted) is a TEACHABLE `--if-match` refusal — NEVER a wrong-row verdict.
//     Always threads `target:{ id }` (T-213 S12 TOCTOU close: the handler acts on EXACTLY this id).
//   • `attestedKeyRevoke(ctx, input)` (the handler): reads the ceremony's `{confirm, ifMatch, target}`
//     pass off `ctx.ceremony`, and sends the revoke — `{confirm}` body (the key_id) + `If-Match`
//     precondition + an auto Idempotency-Key (T-211 A27, client-owned).
//
// ⚠️ RC-11 — THE ONE DIVERGENCE FROM THE TOKEN TEMPLATE: an already-revoked attested key returns
//   HTTP 409 conflict with `reason:"already_revoked"` (server: managementProblem "conflict",
//   ext.reason spread to the body top-level). Token revoke renders that as an idempotent teachable
//   SUCCESS (exit 0). For THIS plane it is a TEACHABLE ERROR (exit 2): honesty / label-by-reality —
//   "already revoked" means this revoke did NOTHING, so the WireProblemError PROPAGATES (exit 2) with
//   a teachable hint attached (hint metadata only, NO new error code). Idempotent-success-on-
//   already-revoked exists only on oauth.grant.revoke; it is WRONG here.
//
// Secret confinement: an attested_key row carries NO raw secret — the enrolled public key stays OFF
// the wire (D-8 absence-on-the-wire: only key_id + metadata surface). The key_id is the stable
// OPERATOR-VISIBLE identifier (never a secret), so showing it as the confirm authority is correct.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject } from "../types";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { findInList } from "../../core/client/paginate";

export const attestedKeyRevokeArgs = z
  .object({
    id: z.string().min(1).describe("The attested-key ROW id (a UUID). Used verbatim — there is no prefix resolution."),
    // Per-spec typed-confirm channel (NEVER a global flag): the Apple App Attest key_id the server
    // verifies. On a TTY it is prompted; non-interactively it is REQUIRED (with --yes).
    confirm: z.string().optional().describe("The key's Apple App Attest key_id, to confirm the revoke (required non-interactively)."),
    // Optimistic-concurrency escape hatch (D-8): pass a known ETag to revoke WITHOUT the list lookup.
    "if-match": z.string().min(1).optional().describe("Revoke against this exact ETag (skips the etag lookup; from `attested-key list`)."),
  })
  .strict();
export type AttestedKeyRevokeInput = z.infer<typeof attestedKeyRevokeArgs>;

/** Read a non-empty string field off a raw row, or `undefined`. */
function rowString(raw: unknown, key: string): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
/** The raw wire `key_id` (snake_case — the D-8 wire DTO shape; verified credentials-deps.ts). */
function rowKeyId(raw: unknown): string | undefined {
  return rowString(raw, "key_id");
}
/** The row `etag` (contract resource_base requires it; the revoke If-Match reads it). */
function rowEtag(raw: unknown): string | undefined {
  return rowString(raw, "etag");
}
/** The row `revoked_at` (RFC3339 or null). */
function rowRevokedAt(raw: unknown): string | null {
  return rowString(raw, "revoked_at") ?? null;
}

/** The teachable `--if-match` refusal for a lookup that cannot COMPLETE (never a wrong-row verdict). */
function lookupFailed(): CliLocalError {
  return new CliLocalError("usage_error", {
    detail:
      "could not resolve the attested key's etag by listing the project's keys — pass --if-match <etag> to revoke without a lookup (read <etag> from `agkit attested-key list`)",
    hint: "agkit attested-key revoke --id <id> --if-match <etag> --yes --confirm <key-id>",
  });
}

const PREVIEW_TITLE = "Revoke this attested device key — it is unenrolled immediately and can no longer attest.";

/**
 * The direct_confirm ceremony binding's `prepare` (RC-8, invoked once before any render/prompt).
 * See the file header for the two modes. Threads `target:{ id }` verbatim (TOCTOU close).
 */
export async function prepareAttestedKeyRevoke(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = input as AttestedKeyRevokeInput;
  const pid = requireProject(ctx);
  const id = parsed.id; // the ROW uuid, VERBATIM (no prefix resolution — a device key has no name)

  // Escape hatch (D-8 / RC-2): --if-match supplied → SKIP the lookup, forward the confirm verbatim
  // (the server is the verifier), preview from args only. `expectedConfirm` is OMITTED because the
  // CLI never fetched — and thus can never DISPLAY — the key_id, so it must not pre-verify.
  const ifMatchFlag = parsed["if-match"];
  if (ifMatchFlag !== undefined) {
    return {
      preview: {
        title: PREVIEW_TITLE,
        lines: [`id:      ${id}`, `confirm: the key's Apple App Attest key_id (the server verifies it)`],
      },
      ifMatch: ifMatchFlag,
      target: { id },
    };
  }

  // Lookup path — a BOUNDED early-stop list search for the row whose id === id. A search that cannot
  // COMPLETE (no match / cap / cycle / retry-exhausted) yields the teachable --if-match refusal:
  // a destructive op must NEVER act on a guessed / wrong row.
  let row: unknown;
  try {
    row = await findInList(ctx.client, "attested_key.list", { pid, limit: 200 }, (r) => rowString(r, "id") === id);
  } catch {
    throw lookupFailed();
  }
  if (row === undefined) throw lookupFailed();

  const keyId = rowKeyId(row);
  const etag = rowEtag(row);
  // FAIL CLOSED on a malformed matched row (codex review): `validateListPage` (in findInList) checks
  // only the ENVELOPE, not a row's fields, so a matched row could still omit `key_id`/`etag`. The
  // lookup path's whole purpose is to supply BOTH the DISPLAYABLE confirm authority (key_id) AND the
  // route-REQUIRED If-Match concurrency token (etag). Missing EITHER → the teachable --if-match
  // refusal — NEVER a degraded forward-verbatim confirm (that is reserved for the explicit --if-match
  // escape hatch), and NEVER a destructive send without the route's required If-Match. A contract-
  // conformant row always carries both (resource_base requires `etag`; the list projects `key_id`),
  // so this only fires on a server protocol violation — where guessing a verdict is unsafe.
  if (keyId === undefined || etag === undefined) throw lookupFailed();
  const revokedAt = rowRevokedAt(row);

  const lines = [`id:      ${id}`, `key_id:  ${keyId}`];
  if (revokedAt !== null) lines.push(`already revoked at: ${revokedAt}`);

  return {
    preview: { title: PREVIEW_TITLE, lines },
    // Both MANDATORY on the lookup path (fail-closed above): the displayed key_id IS the confirm
    // authority the operator re-types, and the row etag IS the required If-Match. TOCTOU close (mirror
    // token S12): `target` carries the CANONICAL id reviewed here so the handler revokes EXACTLY this
    // row, never a re-resolve.
    expectedConfirm: keyId,
    ifMatch: etag,
    target: { id },
  };
}

export const attestedKeyRevoke: CommandHandler<AttestedKeyRevokeInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    // The dispatch hook always resolves a direct_confirm pass for this spec before the handler; a
    // missing/mis-kinded pass is an internal wiring fault, never a user-facing path (mirror token).
    throw new Error("agkit: internal — attested-key revoke requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  // TOCTOU close: revoke EXACTLY the id `prepare` reviewed (carried on the pass), NOT a re-derive of
  // `_input.id`. A missing/non-string target is an internal wiring fault (prepare always sets it).
  const targetId = pass.target?.id;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("agkit: internal — attested-key revoke ceremony pass is missing the prepared target id");
  }
  const pid = requireProject(ctx);

  try {
    const raw = await ctx.client.request({
      operationId: "attested_key.revoke",
      params: { pid, id: targetId, confirm: pass.confirm },
      preconditions: pass.ifMatch !== undefined ? { ifMatch: pass.ifMatch } : undefined,
    });
    return {
      data: {
        id: targetId,
        key_id: rowKeyId(raw) ?? null,
        revoked_at: rowRevokedAt(raw),
        revoked: true,
      },
      meta: { note: "attested key revoked — the device key is unenrolled and can no longer attest" },
    };
  } catch (err) {
    // ⚠️ RC-11 (the ONE place this MUST NOT copy the token template): an already-revoked attested key
    // (409 conflict / reason:"already_revoked") is a TEACHABLE ERROR here, NOT the idempotent SUCCESS
    // token revoke returns. Honesty / label-by-reality: the desired op did NOTHING, so it is not a
    // success. Attach a teachable hint (hint metadata only, NO new error code) and RE-THROW → exit 2.
    if (
      err instanceof WireProblemError &&
      err.problem.status === 409 &&
      err.problem.code === "conflict" &&
      err.problem["reason"] === "already_revoked"
    ) {
      err.hintOverride = "this attested key was already revoked — nothing to do";
      throw err;
    }
    // C-7: a 412 precondition_failed means the passed/fetched ETag is stale (the key changed since
    // it was read). Teach the refresh path — hint metadata only, NO new error code — and RE-THROW.
    if (err instanceof WireProblemError && err.problem.status === 412 && err.problem.code === "precondition_failed") {
      err.hintOverride =
        "the attested key changed since it was read (stale If-Match) — re-run `agkit attested-key list` for a fresh etag, or drop --if-match to let the lookup fetch it";
      throw err;
    }
    // D-8: a 422 confirm_required means the server rejected the `{confirm}` value (the wrong key_id).
    // This is reachable when the operator supplied --if-match (so `prepare` skipped the lookup and did
    // NOT pre-verify the value — RC-2 forward-verbatim); on the lookup path a known key_id is checked
    // client-side, so the server rarely sees a mismatch. Teach the concrete re-run — hint metadata
    // only, NO new error code, the key_id is NEVER echoed — and RE-THROW (exit 2).
    if (err instanceof WireProblemError && err.problem.status === 422 && err.problem.code === "confirm_required") {
      err.hintOverride =
        "the confirm value did not match this key — re-run with the key_id shown by `agkit attested-key list`, or drop --if-match so the lookup can display and verify it";
      throw err;
    }
    throw err;
  }
};
