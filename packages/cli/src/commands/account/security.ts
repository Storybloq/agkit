// `account security` handler (T-223, canonical L2-CLI-22). The HUMAN door to the dashboard's
// account-security page — TOTP enrollment, lockout and password are DASHBOARD-SESSION-ONLY
// ceremonies (management.json `meta.auth_model.excluded_ceremonies`), so there is no management
// route to call and none is invented: this command hands the operator the one place those live.
//
// Two halves, both server-derived:
//   1. the DEEP LINK — the dashboard origin is derived LIVE from the guard-approved apiUrl's
//      RFC 8414 AS metadata (D-10: never a fabricated/hardcoded URL), joined through the closed
//      page grammar. EVERY metadata failure (network, timeout, HTTP status, issuer/token-endpoint/
//      scheme skew, malformed JSON, over-size) is honor-or-reject: a STATIC `usage_error` (exit 2)
//      hinting `agkit status` — the reachability/skew diagnostic — never a guessed URL. There is NO
//      exit-1 path here (CX2).
//   2. the TOKEN FACTS — a BEST-EFFORT `whoami.get` self-lookup (N-011 §APX-A A003, scope —),
//      tolerant-parsed and reshaped through `principalFacts` (the single decision-E home). ANY
//      failure or parse-miss ⇒ `identity_shape:"unknown"` with the raw body WITHHELD; an expired
//      token must never hide the deep link.
//
// The network for BOTH halves happens inside `core/auth` / `core/service` functions and the typed
// client — this handler stays pure over the injected seams (it hands `auth.loginIo` whole, and
// never reaches into its I/O members).
import { z } from "zod";
import { type CommandHandler, requireAuth } from "../types";
import { insecureStorageSurface } from "../../core/auth";
import { AsMetadataError } from "../../core/auth/as-metadata";
import { OpenUrlError } from "../../core/auth/open-url";
import { CliLocalError } from "../../core/errors/cli-codes";
import { joinDashboardPage, resolveDashboardOrigin } from "../../core/service/dashboard-url";
import { principalFacts, whoamiResponseSchema, type WhoamiResponse } from "../whoami/get";

/** No input: the page is fixed and the account is anchored by the credential server-side. */
export const accountSecurityArgs = z.object({}).strict();
export type AccountSecurityInput = z.infer<typeof accountSecurityArgs>;

/** The ONE dashboard page this command deep-links (a literal of the closed page grammar). */
const SECURITY_PAGE = "account/security";

/**
 * The STATIC honesty note (§B-9 label-by-reality). It names the ceremonies by VALUE — never a key
 * (a `totp`/`password`-named key would be output vocabulary this plane does not own) — and states
 * the transport truth CX6 pins: the management API stamps `bearer_token` for EVERY caller, so even
 * an OAuth access-class credential acts as a bearer token here and cannot exercise a
 * dashboard-session action. No value of any kind is interpolated.
 */
const SECURITY_NOTE =
  "TOTP enrollment, lockout, and password are dashboard-session-only: open the URL in your browser. " +
  "A management token cannot read or change them — even an OAuth access-class credential acts as a " +
  "bearer token here and cannot exercise dashboard-session actions; use the dashboard page for those.";

/** The human-facing warning: this URL is for a BROWSER, not for a token principal to call. */
const BROWSER_WARNING = "open this URL in your browser to manage human-credential security";

export const accountSecurity: CommandHandler<AccountSecurityInput> = async (ctx, _input) => {
  const auth = requireAuth(ctx);
  // The SAME memoized guard the shell already ran (at most one prompt per invocation) — the
  // dashboard origin is derived from the CONFIRMED api URL, never a fresh unconfirmed read.
  const { apiUrl } = await auth.ensureApiUrl();

  // CX2: every derivation failure is a terminal usage_error (exit 2) with the `agkit status` hint —
  // status is the reachability/skew diagnostic (login's hint would be a wrong turn: a perfectly
  // valid credential cannot fix an unreachable or skewed authorization server).
  let url: string;
  try {
    const origin = await resolveDashboardOrigin(auth.loginIo, apiUrl);
    url = joinDashboardPage(origin, SECURITY_PAGE);
  } catch (err) {
    if (err instanceof AsMetadataError || err instanceof OpenUrlError) {
      throw new CliLocalError("usage_error", { detail: err.message, hint: "agkit status" });
    }
    // A `CliLocalError` from the page grammar propagates AS ITSELF (already terminal + teachable);
    // anything else is a programming fault and hits run.ts's generic fallback.
    throw err;
  }

  // Best-effort enrichment (the whoami discipline, verbatim): SKIPPED with no credential (an
  // unauthenticated self-lookup cannot succeed), and ANY throw or parse-miss leaves `parsed: null`
  // with the raw body WITHHELD — never dumped.
  let parsed: WhoamiResponse | null = null;
  if (ctx.credential.source !== "none") {
    try {
      const raw = await ctx.client.request({ operationId: "whoami.get", params: {} });
      const result = whoamiResponseSchema.safeParse(raw);
      if (result.success) parsed = result.data;
    } catch {
      parsed = null;
    }
  }

  const data = {
    dashboard: { url, page: SECURITY_PAGE },
    note: SECURITY_NOTE,
    // WHERE the credential came from: env | keychain | insecure_file | helper | none.
    credential_source: ctx.credential.source,
    // Presence, NOT "authenticated": the local resolve cannot itself vouch for validity.
    credential_present: ctx.credential.source !== "none",
    // The tolerant-parse verdict: "golden" (matched the recording) or "unknown" (withheld body).
    identity_shape: parsed ? "golden" : "unknown",
    // CX6: `transport`/`dashboard_session` are CONSTANTS on this plane — the management API stamps
    // transport `bearer_token` for every caller and dashboard sessions are not a management-API
    // transport (SESSION_TRANSPORT_ENABLED=false). They disambiguate TRANSPORT authority from the
    // OAuth grant CLASS in `type`, and are added ONLY here (principalFacts stays untouched).
    principal: parsed ? { ...principalFacts(parsed), transport: "bearer_token", dashboard_session: false } : null,
  };

  // PL-14 parity with `whoami` (:111): `insecure_storage:true` in `--json` via the envelope meta
  // whenever the plaintext path is active (the stderr banner is the shell's job).
  return ctx.credential.insecure
    ? { data, warnings: [BROWSER_WARNING], meta: insecureStorageSurface().meta }
    : { data, warnings: [BROWSER_WARNING] };
};
