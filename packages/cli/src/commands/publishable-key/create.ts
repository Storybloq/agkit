// `publishable-key create --name <n>` handler (T-216 R6; N-011 keys family, keys:write, M direct
// mint, secret_bearing:response). Mints a publishable key for the effective project and discloses
// the full `ak_pk_live_*` value EXACTLY ONCE.
//
// The `ak_pk_live_*` value is a contract-ratified NON-secret (FORBIDDEN row 3): NO field rename,
// NO masking, the FULL value rides `data.key` and `--json` — the redaction chokepoint EXEMPTS the
// grammar (`isPublishableExempt`). We still allowlist the exact minted value through
// `meta[SHOWN_ONCE_META_KEY]` belt-and-suspenders (S2), so the disclosure never depends on the
// exemption alone.
//
// The 201 body is classified EXACTLY against the frozen `publishable_key_mint_response`
// (`management-resources.schema.json` — required {key, secret_unavailable, recovery_hint};
// key:string|null, secret_unavailable:boolean, recovery_hint:string|null; the $comments fix the
// pairing semantics). A STRICT presence-gated discriminated union (R6):
//   • presence gate FIRST — all three members must be PRESENT (`in`); any absent → MALFORMED;
//   • FRESH  ⇔ key is a string ACCEPTED BY the IMPORTED `isPublishableExempt` (RR-4e: the
//     `^ak_pk_live_…$` grammar lives ONLY at redaction.ts — never restated here) AND
//     secret_unavailable === false AND recovery_hint === null;
//   • REPLAY ⇔ key === null AND secret_unavailable === true AND recovery_hint is a non-empty string;
//   • EVERY other combination (wrong-typed member, grammar-failing key, contradictory pairing) is
//     MALFORMED → the FIXED non-secret usage_error (the token-create X3 rationale, verbatim shape) —
//     fabricating a verdict from it would silently lose a minted shown-once key.
import { z } from "zod";
import type { CommandHandler, CommandResult } from "../types";
import { requireProject } from "../types";
import { CliLocalError } from "../../core/errors";
import { SHOWN_ONCE_META_KEY } from "../../core/output/envelope";
import { isPublishableExempt } from "../../core/output/redaction";

export const publishableKeyCreateArgs = z
  .object({
    // Bounds mirror the frozen `publishable_key_create_request.name` (1..200); {name} is the ONLY member.
    name: z.string().min(1).max(200).describe("Human label for the publishable key."),
  })
  .strict();
export type PublishableKeyCreateInput = z.infer<typeof publishableKeyCreateArgs>;

/** The FIXED malformed-mint message (X3): non-secret, no server-controlled bytes, no new code. */
const MALFORMED_MINT_DETAIL =
  "the management API returned a malformed publishable-key mint response — this is a server protocol error, not a request you can fix";

/**
 * Shape the mint 201 into the shown-once (or REPLAY) result envelope — a STRICT presence-gated
 * discriminated union bound EXACTLY to `publishable_key_mint_response` (R6). The key-grammar leg is
 * the IMPORTED `isPublishableExempt` predicate, so mint classification and the redaction exemption
 * can never drift apart (RR-4e). The grammar is validated BEFORE the value is allowlisted shown-once.
 */
export function shapePublishableKeyMint(resp: unknown): CommandResult {
  const r = (resp !== null && typeof resp === "object" ? resp : {}) as Record<string, unknown>;
  // Presence gate FIRST: the three frozen-required members must all be present (no "absent" tolerance).
  if (!("key" in r) || !("secret_unavailable" in r) || !("recovery_hint" in r)) {
    throw new CliLocalError("usage_error", { detail: MALFORMED_MINT_DETAIL });
  }
  const key = r.key;
  const secretUnavailable = r.secret_unavailable;
  const recoveryHint = r.recovery_hint;

  const isFresh =
    typeof key === "string" && isPublishableExempt(key) && secretUnavailable === false && recoveryHint === null;
  const isReplay =
    key === null && secretUnavailable === true && typeof recoveryHint === "string" && recoveryHint.length > 0;
  if (!isFresh && !isReplay) {
    // X3: never a fabricated verdict. Fixed message — no key/server bytes ride the error.
    throw new CliLocalError("usage_error", { detail: MALFORMED_MINT_DETAIL });
  }

  // The resource display members = every member EXCEPT the shown-once envelope trio (which is the
  // disclosure envelope, not the resource). Forward-verbatim (RC-2/RC-8) — masked_secret, id,
  // name, created_at, object, etc. all pass through.
  const { key: _key, secret_unavailable: _su, recovery_hint: _rh, ...resource } = r;

  if (isFresh) {
    const fresh = key as string;
    return {
      data: { ...resource, key: fresh, shown_once: true },
      // belt-and-suspenders shown-once allowlist (S2) — the value is already exempt, this is defensive.
      meta: { [SHOWN_ONCE_META_KEY]: fresh },
      warnings: ["shown once — record it now; revoke + re-mint to recover"],
    };
  }

  // Idempotency REPLAY: OMIT `key` (a null under the `key` field would misleadingly read as "no key");
  // surface the server's recovery_hint verbatim.
  return {
    data: { ...resource, shown_once: false, secret_unavailable: true, recovery_hint: recoveryHint },
  };
}

export const publishableKeyCreate: CommandHandler<PublishableKeyCreateInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  // publishable_key_create_request is {name} ONLY. idempotency:"required" → the client auto-mints
  // an Idempotency-Key (a client-wide `--idempotency-key` is the documented safe-retry lever).
  const resp = await ctx.client.request({
    operationId: "publishable_key.create",
    params: { pid, name: input.name },
  });
  return shapePublishableKeyMint(resp);
};
