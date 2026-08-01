// `whoami get` handler (T-206 + T-211 + T-213 S9; N-011 §APX-A A003 `whoami.get`). LOCAL-FIRST:
// it reports the LOCAL credential — WHERE it came from and whether the plaintext path is active —
// from `ctx.credential`, UNCONDITIONALLY. T-211 ENRICHES it with the server identity via A003.
//
// S9 upgrade: there is NO RFC 7662 introspection route and NO response `$def` — the committed
// golden recording (`golden/management-whoami.get.response.json`) is the ONLY shape authority. The
// enrichment body is TOLERANT-parsed against a schema pinned to that golden (B-5): a body carrying
// the structural discriminants (`object:"whoami"`, a string `token.class`, `actor` + `account`
// present) is the `identity_shape:"golden"` verdict; ANY other body (or a failed/absent lookup) is
// the `identity_shape:"unknown"` fallback with the raw body WITHHELD — never dumped.
//
// The output NEVER re-uses the wire key `token` (decision E redaction hazard: a `token`-named key
// masks its whole value). The identity is reshaped into `data.principal` / `data.actor` /
// `data.account`; the raw token class rides `principal.class` (NOT `token_class`, which would match
// FIELD_NAME_PATTERN — B-19). Local-first, offline-safe, exit-0-always, and the PL-14
// insecure_storage meta + stderr banner are all PRESERVED.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { insecureStorageSurface } from "../../core/auth";

/** No input. */
export const whoamiGetArgs = z.object({}).strict();
export type WhoamiGetInput = z.infer<typeof whoamiGetArgs>;

/**
 * The TOLERANT whoami.get schema, PINNED to the golden recording (whoami.test asserts it parses the
 * committed golden bytes). Requires the structural discriminants for the "golden" verdict; every
 * VOLATILE field (id/display/last_used_at/actor.email) is optional/nullable so a live variation
 * never reddens the verdict. `.passthrough()` keeps forward-added fields from failing the parse.
 */
export const whoamiResponseSchema = z
  .object({
    object: z.literal("whoami"),
    token: z
      .object({
        class: z.string(),
        display: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        binding: z
          .object({ kind: z.string().optional(), project_ids: z.array(z.string()).optional() })
          .passthrough()
          .optional(),
        expires_at: z.string().nullable().optional(),
        last_used_at: z.string().nullable().optional(),
        id: z.string().optional(),
      })
      .passthrough(),
    actor: z
      .object({ email: z.string().nullable().optional(), user_id: z.string().nullable().optional() })
      .passthrough(),
    account: z.object({ id: z.string().optional() }).passthrough(),
  })
  .passthrough();
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

/** Principal TYPE from the wire token class (label by reality; classes ∈ MANAGEMENT_TOKEN_CLASSES). */
export function principalType(cls: string): "user_session" | "management_token" | "unknown" {
  if (cls === "access") return "user_session";
  if (cls === "ci" || cls === "legacy") return "management_token";
  return "unknown";
}

/**
 * The SINGLE home of the decision-E discipline: every consumer of the server identity reshapes it
 * HERE, so the redaction rules are enforced in exactly one place.
 *   - NEVER re-emit the wire key `token` (a `token`-named key masks its whole value at the
 *     redaction chokepoint — the identity would render as `(sensitive)`).
 *   - The raw class rides `class`, NOT `token_class` (which would match FIELD_NAME_PATTERN — B-19).
 *   - R-A's "grant" ≙ `binding` {kind, project_ids} + `class`: the binding object is ALWAYS
 *     present (kind null / project_ids [] when the wire omits it), so a consumer never
 *     optional-chains its way into a false "unbound" reading.
 * Pure: no I/O, no ctx — the caller owns the lookup and the tolerant parse.
 */
export function principalFacts(parsed: WhoamiResponse) {
  return {
    type: principalType(parsed.token.class),
    class: parsed.token.class, // raw class (B-19: `class`, not `token_class`)
    display: parsed.token.display ?? null,
    scopes: parsed.token.scopes ?? [],
    binding: {
      kind: parsed.token.binding?.kind ?? null,
      project_ids: parsed.token.binding?.project_ids ?? [],
    },
    expires_at: parsed.token.expires_at ?? null,
    last_used_at: parsed.token.last_used_at ?? null,
  };
}

export const whoamiGet: CommandHandler<WhoamiGetInput> = async (ctx, _input) => {
  const { source, insecure } = ctx.credential;

  // Best-effort server identity (A003), tolerant-parsed. Any failure — transport error, a wire
  // problem (expired/revoked token), a skew, OR a body that does not match the golden discriminants
  // — leaves `parsed:null` (identity_shape "unknown"); whoami never fails on it (local-first).
  // SKIPPED entirely with no credential (an unauthenticated lookup cannot succeed).
  let parsed: WhoamiResponse | null = null;
  if (source !== "none") {
    try {
      const raw = await ctx.client.request({ operationId: "whoami.get", params: {} });
      const result = whoamiResponseSchema.safeParse(raw);
      if (result.success) parsed = result.data;
    } catch {
      parsed = null;
    }
  }

  const data: Record<string, unknown> = {
    // WHERE the credential came from: env | keychain | insecure_file | helper | none.
    credential_source: source,
    // Presence, NOT "authenticated": the local resolve cannot itself vouch for validity.
    credential_present: source !== "none",
    // True only on the plaintext-file path (drives the persistent warning).
    insecure_storage: insecure,
    // The tolerant-parse verdict: "golden" (matched the recording) or "unknown" (withheld body).
    identity_shape: parsed ? "golden" : "unknown",
    // The reshaped identity (decision E: NEVER the wire key `token`). Null on the unknown verdict.
    principal: parsed ? principalFacts(parsed) : null,
    actor: parsed ? { email: parsed.actor.email ?? null, user_id: parsed.actor.user_id ?? null } : null,
    account: parsed ? { id: parsed.account.id ?? null } : null,
  };

  // PL-14: `insecure_storage:true` in `--json` via the envelope `meta` whenever the plaintext path
  // is active (the stderr banner is the shell's job, emitted at resolution time).
  return insecure ? { data, meta: insecureStorageSurface().meta } : { data };
};
