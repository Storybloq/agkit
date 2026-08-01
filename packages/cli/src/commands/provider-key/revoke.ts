// `provider-key revoke` handler + direct_confirm `prepare` (T-217 step 4; credential.revoke,
// provider-keys:destroy, wire danger PR+D → spec PR (D4 dominant class), gating direct_confirm).
// Wired through T-212's LANDED runDirectConfirm — never a hand-rolled ceremony. Revoke is SOFT
// server-side: it stops dispatching immediately; the row survives for audit/rotation history.
//
// [codex F3, R-H #3] The captured ETag is REQUIRED — prepare FAILS CLOSED before any prompt. The
// token-revoke omit-if-absent precedent is deliberately NOT copied: `provider` is a REUSABLE
// natural key, so an unpinned revoke could destroy a REPLACEMENT credential rotated in between
// prepare and revoke. Without If-Match nothing binds the revoke to the reviewed row.
//
// [codex F4, R-H #4] The honest repeated-revoke split (byte-grounded server truth):
//   • post-revoke re-run: `credential.get` reads ACTIVE rows only ⇒ prepare 404s — surfaced as a
//     TEACHABLE not-found (hintOverride), exit nonzero. Token-style "repeated revoke = success"
//     is UNREACHABLE here and is not faked.
//   • 409 conflict/`already_revoked` from `credential.revoke` is reachable ONLY in the
//     prepare→apply race window ⇒ idempotent SUCCESS (exit 0), keyed on the reason ONLY; any
//     OTHER conflict reason propagates as a teachable error.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, readCapturedEtag } from "../types";
import { WireProblemError } from "../../core/errors";

export const providerKeyRevokeArgs = z
  .object({
    provider: z.string().min(1).describe("The provider slug whose credential to revoke (also the confirm value)."),
    // Per-spec typed-confirm channel (never a global flag): the PROVIDER SLUG the server verifies.
    confirm: z.string().optional().describe("The provider slug, to confirm the revoke (required non-interactively)."),
  })
  .strict();
export type ProviderKeyRevokeInput = z.infer<typeof providerKeyRevokeArgs>;

// STATIC contract-integrity message (R-H #3) — a wire-CLASS failure (the server broke the reviewed-
// row contract), NOT a usage_error: the operator's request was fine.
const MISSING_ETAG_DETAIL =
  "server response carried no ETag for the reviewed credential; refusing to revoke without optimistic concurrency";

// The teachable post-revoke not-found hint (R-H #4 — the honest 404 half).
const REVOKED_404_HINT =
  "no ACTIVE credential exists for this provider — an already-revoked credential cannot be revoked again; use provider-key list to see current state";

/** String member of a raw row, or a fixed placeholder (contract-minimal tolerance; never junk). */
function rowString(raw: unknown, key: string): string {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[key];
  return typeof value === "string" && value.length > 0 ? value : "(unknown)";
}

/**
 * The direct_confirm `prepare` (RC-8, invoked once before any render/prompt): etag-fetch the ACTIVE
 * credential row, fail CLOSED without an ETag, and return the preview + the confirm authority (the
 * provider slug) + the REQUIRED If-Match ETag + the reviewed target. A 404 (no active row — e.g. an
 * already-revoked credential) is decorated with the teachable hint and rethrown (never faked).
 */
export async function prepareProviderKeyRevoke(
  ctx: Ctx,
  input: unknown,
): Promise<DirectConfirmPrepared & { ifMatch: string }> {
  const parsed = input as ProviderKeyRevokeInput;
  const pid = requireProject(ctx);
  let raw: unknown;
  try {
    raw = await ctx.client.request({
      operationId: "credential.get",
      params: { pid, provider: parsed.provider },
      captureMeta: true,
    });
  } catch (err) {
    // R-H #4: the active-rows-only read 404s post-revoke — teach, honestly, at the prepare seam.
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = REVOKED_404_HINT;
    }
    throw err;
  }

  const etag = readCapturedEtag(raw);
  if (etag === undefined || etag.length === 0) {
    // R-H #3: FAIL CLOSED before any prompt. `provider` is a reusable natural key — an unpinned
    // revoke could destroy a REPLACEMENT credential rotated in after this read. A wire-class
    // contract-integrity failure (no fabricated problem members beyond the static title/detail;
    // classified on the closed generic path — never a new code, never a usage_error).
    throw new WireProblemError({ title: "missing ETag", detail: MISSING_ETAG_DETAIL });
  }

  return {
    preview: {
      title:
        "Revoke this provider credential — SOFT delete: it stops dispatching immediately; the row survives for audit/rotation history.",
      lines: [
        `provider: ${parsed.provider}`,
        `masked:   ${rowString(raw, "masked_secret")}`,
        `status:   active`,
      ],
    },
    // The confirm authority is the PROVIDER SLUG (D7: challenge "resource-name" — no union growth).
    expectedConfirm: parsed.provider,
    ifMatch: etag,
    // TOCTOU close: the handler revokes EXACTLY the reviewed provider carried on the pass, never a
    // re-read of input.
    target: { provider: parsed.provider },
  };
}

export const providerKeyRevoke: CommandHandler<ProviderKeyRevokeInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    throw new Error("agkit: internal — provider-key revoke requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  const provider = pass.target?.provider;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error("agkit: internal — provider-key revoke ceremony pass is missing the prepared target provider");
  }
  if (typeof pass.ifMatch !== "string" || pass.ifMatch.length === 0) {
    // prepare fails closed without an ETag, so a pass without one is an internal wiring fault.
    throw new Error("agkit: internal — provider-key revoke ceremony pass is missing the required If-Match ETag");
  }
  const pid = requireProject(ctx);

  try {
    const raw = await ctx.client.request({
      operationId: "credential.revoke",
      params: { pid, provider, confirm: pass.confirm },
      // ifMatch UNCONDITIONALLY present (R-H #3): the reviewed row is the only row we may revoke.
      preconditions: { ifMatch: pass.ifMatch },
    });
    const row = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      data: { ...row, provider, revoked: true },
      meta: { note: "credential revoked (SOFT) — it stops dispatching immediately; the row survives for audit/rotation history" },
    };
  } catch (err) {
    // R-H #4: 409 conflict/already_revoked is reachable ONLY in the prepare→apply race — the
    // desired end state (revoked) already holds ⇒ idempotent teachable SUCCESS, keyed on the
    // `already_revoked` reason ONLY. Any other conflict reason is a real error.
    if (
      err instanceof WireProblemError &&
      err.problem.status === 409 &&
      err.problem.code === "conflict" &&
      err.problem["reason"] === "already_revoked"
    ) {
      return {
        data: { provider, revoked: true, already_revoked: true },
        meta: { note: "this credential was already revoked — no change was made (revocation is idempotent)" },
      };
    }
    // A 412 precondition_failed (the credential rotated between prepare and revoke) propagates
    // unchanged — the existing teachable stale-precondition rendering; NEVER an auto-re-prepare.
    throw err;
  }
};
