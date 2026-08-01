// The shared OAuth-boundary HTTP helper (T-213 S1 — extracted from the T-211 refresh
// executor). This is the ONE place a form-encoded RFC 6749/8628/7009 request is issued:
// the refresh executor (refresh.ts) delegates here, and the login flows (auth-code+PKCE,
// device-code) build on the SAME helper — so the A14/A31 rule that the management-version
// header is OMITTED on the OAuth boundary lives in EXACTLY one place.
//
// This is an OAuth boundary, NOT the management JSON envelope: it does NOT route through the
// typed client, it OMITS `X-AgentKit-Management-Version` (an absent header ⇒ "current major";
// sending it would let a skew mask itself as a 6749 login failure), and it applies a
// per-attempt watchdog so no unbounded wait ever escapes (RULES: the caller owns every wait).
// A network error or an abort (timeout) becomes a typed `TransportError` (the AMBIGUOUS
// "response lost" case) that the refresh executor's replay logic keys off; a real HTTP
// response — 2xx OR ≥400 — is returned verbatim as `{ status, bodyText }` (classification is
// the caller's job, never this helper's).
import { z } from "zod";
import { TransportError } from "../client/transport";

// Re-home the OAuth-boundary transport error onto this module so login/logout code imports it
// from the ONE OAuth-HTTP surface. It is the SAME class the client transport throws (single
// definition in transport.ts) — so the refresh executor's `instanceof TransportError` replay
// check, and any future login-flow catch, key off one identity (never two colliding classes).
export { TransportError };

/**
 * The public CLI OAuth client id (RFC 6749 public client, PKCE, no secret). Pinned as a
 * constant, NOT read from AS metadata: `management.json` meta carries NO `client_id` and
 * `ManagementAsMetadataPins` has no such member (byte-dead), so the ratifying anchor is the
 * server seed `packages/shared/drizzle/0035_token_model.sql:172-174`
 * (`INSERT INTO oauth_clients … VALUES ('agkit-cli', …)` — ratified id is `agkit-cli`, NOT
 * `agentkit-cli`). The device_authorization + token exchanges present this value.
 */
export const AGKIT_CLI_CLIENT_ID = "agkit-cli";

/** The OAuth-boundary token endpoint (RFC 6749 §6 — refresh, auth-code, device-code grants). */
export const OAUTH_TOKEN_PATH = "/v1/management/oauth/token";
/** The device-authorization endpoint (RFC 8628 §3.1). */
export const OAUTH_DEVICE_AUTHORIZATION_PATH = "/v1/management/oauth/device_authorization";
/** The token-revocation endpoint (RFC 7009). */
export const OAUTH_REVOCATION_PATH = "/v1/management/oauth/revocation";

/**
 * Per-attempt OAuth-boundary watchdog. Bounded so a refresh's send + single replay both
 * complete inside the server's ~60s proof-of-possession grace window (2 × 20s = 40s < 50s,
 * A41); the login and device flows reuse the same conservative per-request budget.
 */
export const ATTEMPT_TIMEOUT_MS = 20_000;

/** RFC 6750 §2.1 `b64token` — the only grammar a bearer can legally carry. */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
/** Upper bound on `expires_in` (100 years, seconds) — a hostile huge value must not push the
 * expiry computation outside JS's Date range (where `toISOString()` THROWS). */
const MAX_EXPIRES_IN_S = 3_153_600_000;

/** RFC 6749 §5.1 success body — validated in FULL before any credential write (A14). */
export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).regex(B64TOKEN),
    token_type: z.string().min(1),
    refresh_token: z.string().min(1), // MANDATORY: our AS rotates on EVERY grant (A1/A29)
    expires_in: z.number().int().nonnegative().max(MAX_EXPIRES_IN_S).optional(),
    scope: z.string().optional(),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Parse + FULLY validate an RFC 6749 §5.1 token response. Returns null on ANY shape violation. */
export function parseTokenResponse(bodyText: string): TokenResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const result = tokenResponseSchema.safeParse(parsed);
  if (!result.success) return null;
  // token_type MUST be the bearer type (RFC 6749 §7.1, case-insensitive) — anything else is unusable.
  if (result.data.token_type.toLowerCase() !== "bearer") return null;
  return result.data;
}

/** The raw outcome of ONE OAuth-boundary send — a COMPLETE HTTP response (2xx or ≥400). */
export interface OauthHttpResult {
  readonly status: number;
  readonly bodyText: string;
}

/** All I/O + timing seams injected — no real network / timers in tests. */
export interface OauthHttpDeps {
  /** OAuth-boundary fetch (NOT the management transport — no version header, no bearer). */
  readonly fetch: typeof globalThis.fetch;
  /** Per-request watchdog budget; defaults to `ATTEMPT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Injectable watchdog timers; defaults to the globals. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/**
 * One form-encoded POST to `origin + path`, grant-agnostic (`params` are forwarded VERBATIM),
 * bounded by a per-request watchdog. OMITS the management-version header (A14/A31),
 * `redirect:"manual"` (never traverse a redirect before the caller classifies). A network
 * error or an abort (timeout) is wrapped as a typed `TransportError`; a real HTTP response —
 * 2xx OR ≥400 — is returned as `{ status, bodyText }`. Body construction / URL parsing above
 * the try would throw a plain error (a bug), which the caller lets propagate.
 */
export async function postForm(
  deps: OauthHttpDeps,
  origin: string,
  path: string,
  params: URLSearchParams,
): Promise<OauthHttpResult> {
  const url = `${origin}${path}`;
  const body = params.toString();
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const controller = new AbortController();
  const watchdog = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.fetch(url, {
      method: "POST",
      // NO X-AgentKit-Management-Version (A14/A31): an absent header ⇒ server treats as current major.
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  } catch {
    // Our watchdog fired → an ambiguous timeout; anything else while unaborted → an ambiguous
    // network error. Either way the response is LOST — a typed TransportError the caller handles.
    // P7: the message is SANITIZED — the underlying fetch error is NEVER interpolated (an OAuth
    // request body carries device_code / refresh_token bytes, and a runtime's error text may echo
    // request details). Only the CLI-constructed URL (guard-approved origin + frozen path) appears.
    if (controller.signal.aborted) {
      throw new TransportError("timeout", `oauth request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new TransportError("network", `network error contacting ${url}`);
  } finally {
    timers.clearTimeout(watchdog);
  }
}

/** Sugar for the token endpoint (refresh / auth-code / device-code grants). */
export function postTokenEndpoint(
  deps: OauthHttpDeps,
  origin: string,
  params: URLSearchParams,
): Promise<OauthHttpResult> {
  return postForm(deps, origin, OAUTH_TOKEN_PATH, params);
}
