// `token create` handler (T-213 S11; N-011 tokens:write, M, secret-bearing mint). Mints a
// management token for the effective project and discloses the freshly-minted secret EXACTLY ONCE.
//
// Ratified rulings woven in:
//   - B-2  — the request body ALWAYS binds `binding:"projects"` + `project_ids:[pid]` where
//            `pid = requireProject(ctx)`. Account-wide mint is NOT offered by this surface (the
//            route is project-scoped; the path pid must be in the set per the $def). name / scopes
//            / expires_at ride the body; nothing else.
//   - (h)  — at least one `--scope` is REQUIRED and EVERY scope is membership-validated against the
//            contract registry before anything is sent (an unknown scope → usage_error, zero sends).
//   - (i)/B-16 — `--expires-in` uses the closed m/h/d grammar, normalized to ms and bound-checked
//            (<= 366d) before send; it is REQUIRED non-interactively (missing → usage_error naming
//            it) and defaults to 30d on a TTY (announced in meta.note).
//   - (j)  — shown-once: a fresh mint returns `data.token` = the full secret (allowlisted for one
//            render via `meta[SHOWN_ONCE_META_KEY]`) + `shown_once:true`. An idempotency REPLAY
//            (`token:null, secret_unavailable:true`) OMITS the token key (a null under a
//            secret-named key would render a misleading "(sensitive)"), sets `shown_once:false`,
//            and surfaces `recovery_hint` + a teachable revoke-and-recreate note.
//   - B-13 — re-running mints a NEW token; `--idempotency-key <k>` is the safe-retry lever (help/reference).
import { z } from "zod";
import type { CommandHandler, CommandResult } from "../types";
import { requireProject, requireRuntime } from "../types";
import { CliLocalError } from "../../core/errors";
import { SHOWN_ONCE_META_KEY } from "../../core/output/envelope";
import { isMgmtToken } from "../../core/output/redaction";
import { validateScopeMembership } from "../scope-validate";
import { toTokenDisplayRow, UNKNOWN_DISPLAY } from "./dto";
import { parseExpiresInMs, DEFAULT_EXPIRES_IN } from "./duration";

export const tokenCreateArgs = z
  .object({
    name: z.string().min(1).describe("Human label for the token."),
    // Repeatable: `--scope a --scope b` (the tokenizer collects repeats into an array); a single
    // `--scope a` stays scalar. At least one is required (enforced in the handler for a clean message).
    scope: z.union([z.string(), z.array(z.string())]).optional().describe("A required scope (repeatable): --scope <family:verb>."),
    "expires-in": z.string().optional().describe("Token lifetime: <n>m|h|d (<= 366d). Required non-interactively; 30d default on a TTY."),
  })
  .strict();
export type TokenCreateInput = z.infer<typeof tokenCreateArgs>;

/** Normalize the scalar-or-array `--scope` input to an ordered, non-empty-trimmed string[]. */
function normalizeScopes(scope: string | string[] | undefined): string[] {
  const raw = scope === undefined ? [] : Array.isArray(scope) ? scope : [scope];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The FIXED malformed-mint message (X3): non-secret, no server-controlled bytes, no new code. */
const MALFORMED_MINT_DETAIL =
  "the management API returned a malformed token-mint response — this is a server protocol error, not a request you can fix";

/**
 * Shape the mint response into the shown-once (or REPLAY) result envelope (decision (j)) — a
 * STRICT discriminated union (X3):
 *   • FRESH  ⇔ `token` matches the ratified management-token grammar (`isMgmtToken` — the SAME
 *     pattern set the redaction chokepoint enforces, never a second regex) AND
 *     `secret_unavailable !== true`;
 *   • REPLAY ⇔ `token` null/absent AND `secret_unavailable === true`;
 *   • EVERY other combination (a missing token without the replay attestation, a token riding a
 *     secret_unavailable:true contradiction, a token failing the grammar) is a malformed/
 *     contradictory response → the EXISTING typed protocol error (fixed non-secret message,
 *     `usage_error`, exit 2 — the same landed path the list-envelope validator uses). Fabricating
 *     a "replay" verdict from it would silently lose a minted shown-once secret.
 * The grammar is validated BEFORE the token value is allowlisted shown-once.
 */
function shapeMint(
  resp: unknown,
  ctx: { requestedName: string; requestedScopes: string[]; requestedExpiresAt: string; notes: string[] },
): CommandResult {
  const r = (resp !== null && typeof resp === "object" ? resp : {}) as Record<string, unknown>;
  const rawToken = r.token;
  const secretUnavailable = r.secret_unavailable;
  const recoveryHint = typeof r.recovery_hint === "string" ? r.recovery_hint : null;

  const isFresh =
    typeof rawToken === "string" && isMgmtToken(rawToken) && secretUnavailable !== true;
  const isReplay = (rawToken === null || rawToken === undefined) && secretUnavailable === true;
  if (!isFresh && !isReplay) {
    // X3: never a fabricated verdict. Fixed message — no token/server bytes ride the error.
    throw new CliLocalError("usage_error", { detail: MALFORMED_MINT_DETAIL });
  }

  const row = toTokenDisplayRow(resp);
  // The common, secret-free display facts. `name`/`scopes`/`expires_at` fall back to the REQUESTED
  // values (forward-verbatim, RC-2/RC-8) when the contract-minimal response omits them.
  const base = {
    id: row.id,
    name: row.name === UNKNOWN_DISPLAY ? ctx.requestedName : row.name,
    display: row.display,
    scopes: row.scopes.length > 0 ? row.scopes : ctx.requestedScopes,
    project_ids: row.project_ids,
    expires_at: row.expires_at ?? ctx.requestedExpiresAt,
  };

  if (isFresh) {
    // Fresh mint — disclose the grammar-validated secret for EXACTLY one render via the shown-once
    // allowlist. The full value rides `data.token` (a secret-named key: masked everywhere EXCEPT
    // this one render).
    const token = rawToken as string;
    const meta: Record<string, unknown> = { [SHOWN_ONCE_META_KEY]: token };
    if (ctx.notes.length > 0) meta.note = ctx.notes.join(" ");
    return {
      data: { ...base, token, shown_once: true },
      meta,
      warnings: ["store this token now — the secret is shown once and cannot be retrieved again"],
    };
  }

  // Idempotency REPLAY (token null/absent + secret_unavailable:true, attested): NO token key (a
  // null under a secret-named key renders a misleading "(sensitive)"). Surface recovery_hint
  // verbatim + the teachable revoke-and-recreate line.
  const noteParts = [
    recoveryHint,
    "the secret was disclosed on the original mint and cannot be re-shown; revoke and re-create the token if it was lost",
    ...ctx.notes,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return {
    data: { ...base, shown_once: false, secret_unavailable: true, recovery_hint: recoveryHint },
    meta: { note: noteParts.join(" ") },
  };
}

export const tokenCreate: CommandHandler<TokenCreateInput> = async (ctx, input) => {
  const runtime = requireRuntime(ctx);
  const pid = requireProject(ctx);

  // (h): at least one scope, every one membership-valid — validated BEFORE anything is sent.
  const scopes = normalizeScopes(input.scope);
  if (scopes.length === 0) {
    throw new CliLocalError("usage_error", {
      detail: "at least one --scope is required to mint a token (a scopeless token can do nothing)",
      hint: "agkit token create --name <n> --scope <family:verb> [--scope …] --expires-in <dur>",
    });
  }
  validateScopeMembership(scopes);

  // (i): --expires-in is REQUIRED non-interactively; a TTY applies the 30d default with a note.
  const notes: string[] = [];
  let expiresInRaw = input["expires-in"];
  if (expiresInRaw === undefined) {
    if (!runtime.isTTY) {
      throw new CliLocalError("usage_error", {
        detail:
          "--expires-in is required non-interactively: a minted token must carry an explicit lifetime (no silent default)",
        hint: "agkit token create --name <n> --scope <s> --expires-in 30d",
      });
    }
    expiresInRaw = DEFAULT_EXPIRES_IN;
    notes.push(`no --expires-in given; applied the default ${DEFAULT_EXPIRES_IN} — pass --expires-in <dur> to override`);
  }
  const expiresAt = new Date(Date.now() + parseExpiresInMs(expiresInRaw)).toISOString();

  // B-2: the body is ALWAYS project-bound to the effective project. scopes has length >= 1 (never
  // an explicit [] — the server rejects that with 422).
  const resp = await ctx.client.request({
    operationId: "management_token.create",
    params: { pid, name: input.name, binding: "projects", project_ids: [pid], scopes, expires_at: expiresAt },
  });

  return shapeMint(resp, { requestedName: input.name, requestedScopes: scopes, requestedExpiresAt: expiresAt, notes });
};
