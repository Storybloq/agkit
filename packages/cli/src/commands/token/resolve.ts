// Client-side token-id prefix resolution (T-213 S10, plan §c + B-1 / B-12 / B-18). The
// management get/revoke routes take a UUID ONLY (a malformed id is a server 404); there is NO
// server-side prefix lookup. This module lets an operator pass a full id OR a short prefix and
// resolves it to exactly one id, entirely client-side:
//
//   1. a full UUID passes through directly (NO list call) — this is the ONLY path that reaches a
//      REVOKED token (the live-list index is `revoked_at IS NULL`), so `get`/`revoke` by full id
//      still work outside the index.
//   2. anything else is a PREFIX, matched over a FULL `management_token.list` drain (the landed
//      client seam's page walk, bounded by the T-211 page-safety cap). A candidate matches iff
//      `id.startsWith(prefix)` OR `masked_secret.startsWith(prefix)` — both display forms an
//      operator actually sees in `token list`.
//
// Honesty rails:
//   • B-1  — an input that IS a full ratified token secret (mgmt_/mgmt_ci_/at_/rt_ + 43) is a
//            pasted secret, never an id. REFUSE it up front, WITHOUT echoing a single secret byte
//            (no drain, no interpolation of the value into any message).
//   • B-12 — the verdict REQUIRES a provably COMPLETE drain. Any resumable stop (mid-drain
//            retry-exhausted failure, the page-safety cap, a leftover next_cursor) leaves the set
//            of candidates UNKNOWABLE — refuse teachably, NEVER guess a verdict.
//   • B-18 — an ambiguous prefix raises `AmbiguousPrefixError` whose candidates carry the FULL id
//            + name + masked display (ids disambiguate even when name AND display collide).
//   • zero match → `usage_error` (a local input fault; passing a non-UUID through would just be a
//            shape-invalid 404). The closed CLI-local code set is honored — no new code.
import type { Ctx } from "../types";
import { requireProject } from "../types";
import { CliLocalError, AmbiguousPrefixError } from "../../core/errors";
import { drainList } from "../../core/client/paginate";
import { isMgmtToken } from "../../core/output/redaction";
import { toTokenDisplayRow } from "./dto";

/**
 * RFC 4122 canonical UUID (the shape `ResourceBase.id` takes for a token). A full match is passed
 * straight through as the resolved id; anything else is treated as a prefix. Case-insensitive.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `value` a canonical full UUID? */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve `input` (a full UUID or an id/masked-display prefix) to exactly one token id for the
 * effective project. Throws a teachable `CliLocalError` (usage_error / ambiguous_prefix) on a
 * refusal / miss / ambiguity — never returns a guessed id.
 */
export async function resolveTokenId(ctx: Ctx, input: string): Promise<string> {
  // B-1: a pasted FULL token secret is refused BEFORE anything touches it — no drain, and the
  // refusal message NEVER contains the value (nothing to leak into logs / error envelopes).
  if (isMgmtToken(input)) {
    throw new CliLocalError("usage_error", {
      detail:
        "that looks like a full token secret, not a token id — pass the token id (a UUID) or a short id prefix instead",
      hint: "agkit token list",
    });
  }

  // 1. A full UUID is the id itself — pass through, no list call (reaches revoked tokens too).
  if (isUuid(input)) return input;

  // 2. Prefix path — a FULL drain of the live token list for the effective project.
  const pid = requireProject(ctx);
  const drained = await drainList(ctx.client, "management_token.list", { pid });

  // B-12: the drain MUST be provably complete. A `meta.next_cursor` means it stopped early (a
  // page-cap or a mid-drain retry-exhausted failure) — the full candidate set is unknowable, so
  // ANY verdict (including "no match" or "exactly one") would be a guess. Refuse instead.
  if (drained.meta && "next_cursor" in drained.meta) {
    throw new CliLocalError("usage_error", {
      detail:
        "could not enumerate all tokens to resolve that prefix (the listing did not complete) — retry, or pass the full token id",
      hint: "agkit token list",
    });
  }

  // X4: match RAW DTO values ONLY — the display-row mapping's synthetic "(unknown)" placeholders
  // must never participate ("(u" would prefix-match every contract-minimal row, and a row with a
  // missing id could RETURN "(unknown)" as the resolved id). A row participates only with a valid
  // UUID raw `id` (resolution must return a real, server-addressable id — never a placeholder or a
  // non-UUID); the display leg compares only a REAL, non-empty raw `masked_secret`. Rows missing a
  // valid id are excluded from matching entirely (the full-UUID passthrough above still reaches
  // any token whose id the operator knows). Display rows are used ONLY to FORMAT the ambiguity
  // candidates, after raw matching.
  const matches: Array<{ readonly id: string; readonly raw: unknown }> = [];
  for (const raw of drained.data as unknown[]) {
    const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!isUuid(id)) continue;
    const masked = typeof r.masked_secret === "string" && r.masked_secret.length > 0 ? r.masked_secret : null;
    if (id.startsWith(input) || (masked !== null && masked.startsWith(input))) matches.push({ id, raw });
  }

  if (matches.length === 1) return matches[0]!.id;

  if (matches.length >= 2) {
    // B-18: candidates carry the FULL id (the runnable, unique selector) + name + masked display,
    // so a same-name/same-display collision is still disambiguated by the id. The display row is
    // FORMATTING only here — the match verdict above came from the raw values.
    const candidates = matches.map(({ raw }) => {
      const d = toTokenDisplayRow(raw);
      return `${d.id}  (name: ${d.name}, display: ${d.display})`;
    });
    throw new AmbiguousPrefixError(input, candidates);
  }

  // Zero match — a local input fault (a non-UUID would only be a shape-invalid server 404).
  throw new CliLocalError("usage_error", {
    detail: `no token matches '${input}' in this project`,
    hint: "agkit token list",
  });
}
