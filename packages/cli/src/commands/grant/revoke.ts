// `grant revoke <grant-id>` handler + its direct_confirm ceremony `prepare` (T-299 R3; N-011 tokens
// family, tokens:destroy, danger D). The frozen v1.2.0 row `oauth.grant.revoke` is
// gating:"direct_confirm" + concurrency:"if_match" + idempotency:"required" — COLUMN-FOR-COLUMN the
// `management_token.revoke` gating (wire-contract ADJUDICATION 3) — so this rides T-212's LANDED
// mutation ceremony (runDirectConfirm), never a hand-rolled parallel one, and it is NOT plannable:
// `CHANGE_TABLE` carries no oauth/grant key, so `--plan-only` is the tested refusal
// (`plan_only_on_direct_confirm`) rather than a door.
//
// Two halves, both pure over injected seams (the publishable-key revoke precedent):
//   • `prepareGrantRevoke(ctx, input)` (the mutation binding, RC-8 — invoked EXACTLY once by the
//     dispatch hook BEFORE any render or prompt): ONE `oauth.grant.get` with `captureMeta` to read
//     the row + its ETag. Returns a DirectConfirmPrepared whose `expectedConfirm` is the grant's
//     CLIENT DISPLAY NAME (`GRANT_CONFIRM_FIELD` = "grant's client display name"; a grant has no
//     name of its own, so the server compares `{confirm}` against the client's display name) and
//     whose `ifMatch` is that ETag (PL-13 optimistic concurrency).
//   • `grantRevoke(ctx)` (the handler): reads the ceremony's `{confirm, ifMatch, target}` pass off
//     `ctx.ceremony` and sends the revoke — `{confirm}` body + `If-Match` precondition + an auto
//     Idempotency-Key (client-owned, per the route's `idempotency:"required"` column).
//
// ⚠️ THE ONE DIVERGENCE FROM THE TOKEN/PUBLISHABLE-KEY TEMPLATE: an already-revoked grant is NOT a
//   409. D-GMT.1 makes it a 200 SUCCESS carrying `already_revoked: true` (`oauth-grants.ts` spreads
//   the flag then `c.json(dto, 200, {ETag})`) — the flag exists on `$defs.oauth_grant` for
//   `oauth.grant.revoke` ONLY. So there is NO `WireProblemError` 409 catch here: both the fresh
//   revoke and the idempotent no-op ride the success body straight through, and the note labels the
//   one that actually happened (label-by-reality, §B-9).
//
// Secret confinement: the `oauth_grant` projection carries NO token material of ANY kind — no
// plaintext, hash, prefix, suffix, or masked display (D-GMT.1 absence-on-the-wire); even the raw
// client_id stays off it. The display name is not a secret, and every preview line still passes the
// ceremony's redact + terminal-safe chokepoint.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { readCapturedEtag } from "../types";
import { CliLocalError } from "../../core/errors";

export const grantRevokeArgs = z
  .object({
    id: z.string().min(1).describe("Grant id to revoke."),
    // Per-spec typed-confirm channel (NEVER a global flag): the grant's CLIENT DISPLAY NAME, which
    // the server re-verifies. On a TTY it is prompted; non-interactively it is REQUIRED (with --yes).
    confirm: z.string().optional().describe("The grant's client display name, to confirm the revoke (required non-interactively)."),
  })
  .strict();
export type GrantRevokeInput = z.infer<typeof grantRevokeArgs>;

/** A non-empty string member of a fetched row (`undefined` when absent/empty/non-string). */
function pickString(raw: unknown, key: string): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** `access=2 ci=0 legacy=1` from the CLOSED `live_token_counts` object, or `undefined`. */
function renderTokenCounts(raw: unknown): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const counts = r["live_token_counts"];
  if (counts === null || typeof counts !== "object") return undefined;
  const c = counts as Record<string, unknown>;
  const parts = (["access", "ci", "legacy"] as const)
    .filter((key) => typeof c[key] === "number")
    .map((key) => `${key}=${String(c[key])}`);
  return parts.length > 0 ? parts.join("  ") : undefined;
}

const PREVIEW_TITLE = "Revoke this OAuth grant — its live tokens are cascade-revoked immediately.";

/** The server-protocol refusal (the X3 rationale): a condition the operator cannot fix. */
function protocolError(detail: string): CliLocalError {
  return new CliLocalError("usage_error", { detail });
}

/**
 * The direct_confirm ceremony binding's `prepare` (RC-8, invoked once before any render/prompt).
 * Etag-fetches the target row and returns the preview + the confirm authority (the CLIENT DISPLAY
 * NAME) + the If-Match ETag. When the row omits a usable display name, `expectedConfirm` is OMITTED
 * — the ceremony then forwards the operator's typed value verbatim and the server teaches (422
 * confirm_required), rather than demanding a value the CLI could not display (display-is-authority,
 * the RATIFIED token-revoke seam).
 */
export async function prepareGrantRevoke(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = input as GrantRevokeInput;
  const requestedId = parsed.id;
  const raw = await ctx.client.request({
    operationId: "oauth.grant.get",
    params: { id: requestedId },
    captureMeta: true,
  });

  // FAIL CLOSED #1 — the reviewed row must BE the row that was asked for. The id is what the
  // handler will destroy (TOCTOU close), so a server that answers with a different grant must never
  // be acted on: nothing downstream would catch the substitution (a display name can be shared, and
  // the ETag would be the wrong row's own valid ETag).
  //
  // The compare is CASE-INSENSITIVE, and that is not a loosening: the route gate is
  // `UUID_RE = /^[0-9a-f]{8}-…$/i` (`direct-confirm-http.ts:17`), so ANY spelling of a uuid reaches
  // the handler, while `oauthGrants.id` is a Postgres `uuid` column (`db/schema.ts:240ff`) — Postgres
  // parses input case-insensitively and always RETURNS the canonical lowercase form. So an uppercase
  // request id and a lowercase answer are the SAME identity, never a substitution; two DISTINCT
  // uuids differ in hex DIGITS, never only in case. A strict compare would refuse a server that
  // behaved exactly per contract, with a false "server protocol error" diagnostic.
  const reviewedId = pickString(raw, "id");
  if (reviewedId === undefined || reviewedId.toLowerCase() !== requestedId.toLowerCase()) {
    throw protocolError(
      "the management API returned a grant whose id is not the one requested, so the revoke cannot be safely targeted — this is a server protocol error, not a request you can fix",
    );
  }

  // FAIL CLOSED #2 (route concurrency:"if_match", the publishable-key revoke standard): abort
  // PRE-PROMPT if the GET yielded no usable ETag. Sending an unconditioned destructive revoke would
  // open the very TOCTOU window the preview exists to close. No new error code — the server failing
  // to advertise the required concurrency token is a protocol condition the operator cannot fix.
  const etag = readCapturedEtag(raw);
  if (etag === undefined) {
    throw protocolError(
      "the management API did not return an ETag for this OAuth grant, so the revoke cannot be safely conditioned (If-Match) — this is a server protocol error, not a request you can fix",
    );
  }

  const displayName = pickString(raw, "client_display_name");
  const binding = pickString(raw, "binding");
  const projectIds = (raw as { project_ids?: unknown }).project_ids;
  const scopes = (raw as { scopes?: unknown }).scopes;
  const counts = renderTokenCounts(raw);
  const createdAt = pickString(raw, "created_at");
  const absoluteExpiresAt = pickString(raw, "absolute_expires_at");
  const revokedAt = pickString(raw, "revoked_at");

  const lines = [`id:        ${reviewedId}`];
  if (displayName !== undefined) lines.push(`client:    ${displayName}`);
  if (binding !== undefined) lines.push(`binding:   ${binding}`);
  if (binding === "projects" && Array.isArray(projectIds)) lines.push(`projects:  ${projectIds.join(", ")}`);
  if (Array.isArray(scopes)) lines.push(`scopes:    ${scopes.join(" ")}`);
  if (counts !== undefined) lines.push(`live tokens: ${counts}`);
  if (createdAt !== undefined) lines.push(`created:   ${createdAt}`);
  if (absoluteExpiresAt !== undefined) lines.push(`expires:   ${absoluteExpiresAt}`);
  if (revokedAt !== undefined) lines.push(`already revoked at: ${revokedAt}`);
  // The teaching trailer tracks the `client:` line's OWN presence: pointing at "the name shown
  // above" when that line was never pushed would send the operator to read something that is not
  // there. The absent arm is not an error — it is the ratified display-is-authority seam (the CLI
  // demands no value it could not display), so it says what will actually happen: the typed value
  // rides to the server, which verifies it (422 confirm_required teaches the rest).
  lines.push(
    displayName !== undefined
      ? "the confirm value is the CLIENT display name shown above — a grant has no name of its own"
      : "this grant's client display name could not be displayed — the value you type is verified by the server (a grant has no name of its own)",
  );

  const prepared: {
    preview: DirectConfirmPrepared["preview"];
    expectedConfirm?: string;
    ifMatch: string;
    target: { id: string };
  } = {
    preview: { title: PREVIEW_TITLE, lines },
    // TOCTOU close: revoke EXACTLY the id reviewed + etag-got HERE (never a re-read of the input).
    target: { id: reviewedId },
    // Guaranteed non-empty by FAIL CLOSED #2 above (route concurrency:"if_match").
    ifMatch: etag,
  };
  if (displayName !== undefined) prepared.expectedConfirm = displayName;
  return prepared;
}

export const grantRevoke: CommandHandler<GrantRevokeInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    // The dispatch hook always resolves a direct_confirm pass for this spec before the handler; a
    // missing/mis-kinded pass is an internal wiring fault, never a user-facing path.
    throw new Error("agkit: internal — grant revoke requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  // TOCTOU close: revoke EXACTLY the id `prepare` reviewed (carried on the pass), NOT `_input.id`.
  const targetId = pass.target?.id;
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("agkit: internal — grant revoke ceremony pass is missing the prepared target id");
  }
  // `prepare` guarantees a non-empty ifMatch (route concurrency:"if_match"); a missing one here is
  // an internal wiring fault, never an unconditioned revoke — so the precondition is ALWAYS sent.
  if (typeof pass.ifMatch !== "string" || pass.ifMatch.length === 0) {
    throw new Error("agkit: internal — grant revoke ceremony pass is missing the required If-Match ETag");
  }

  const resp = await ctx.client.request({
    operationId: "oauth.grant.revoke",
    params: { id: targetId, confirm: pass.confirm },
    preconditions: { ifMatch: pass.ifMatch },
  });
  // D-GMT.1: already-revoked is a 200 SUCCESS carrying `already_revoked: true`, NOT a 409 — so the
  // body passes through untouched and only the NOTE distinguishes the two (label-by-reality).
  const alreadyRevoked = (resp as { already_revoked?: unknown } | null)?.already_revoked === true;
  return {
    data: resp,
    meta: {
      note: alreadyRevoked
        ? "this grant was already revoked — no change was made (revocation is idempotent, and no re-cascade ran)"
        : "grant revoked — its live tokens were cascade-revoked and stop working immediately",
    },
  };
};
