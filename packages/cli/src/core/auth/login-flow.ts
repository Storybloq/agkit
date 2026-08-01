// The login-flow orchestration (T-213 S7). Composes the tranche-1 OAuth modules into the two
// RFC-standard login flows over a single injected I/O seam bundle (`LoginIoSeams`):
//
//   • runBrowserLogin — RFC 8252 authorization-code + PKCE via a loopback redirect listener.
//     Fetch AS metadata (authorization_endpoint) → mint a PKCE pair + CSRF `state` from the
//     CSPRNG seam → bind the one-shot loopback listener → open the browser to the authorize URL
//     (never the device convenience URL) → wait for the matching-state callback → exchange the
//     code (with the code_verifier) at the token endpoint → build the FULL CredentialRecord.
//   • runDeviceLogin — RFC 8628 device-authorization grant. POST device_authorization (scope in
//     the body, B-3) → print the user_code + verification URI to stderr (NEVER the device_code,
//     B-11) → poll the token endpoint → build the record.
//
// SECRET CONFINEMENT (B-11): the PKCE `code_verifier`, the authorization `code`, and the
// device_code are NEVER written to stderr. The authorize URL carries only public values
// (code_challenge / state / redirect_uri / client_id / scope). The `finally` always closes the
// loopback listener (port release on every path). Endpoint errors are sanitized through a closed
// RFC 6749 allowlist before they reach a message (endpoint-controlled bytes never surface).
//
// EXIT MAPPING (B-9) is the CALLER's job: a `TransportError` (network/timeout) escapes here for
// the handler to render as the retryable exit-1 error; a `LoginFlowError` (and the module errors
// AsMetadataError / DeviceAuthorizationError / OpenUrlError / Loopback*) is a terminal outcome
// the handler maps to `usage_error` (exit 2) with an `agkit login` hint. No new codes.
import { createLoopbackListener, type CreateLoopbackServer, type LoopbackDeps } from "./loopback";
import { createPkcePair, createState, type RandomBytes } from "./pkce";
import { fetchAsMetadata } from "./as-metadata";
import {
  postTokenEndpoint,
  parseTokenResponse,
  AGKIT_CLI_CLIENT_ID,
  type OauthHttpDeps,
  type TokenResponse,
} from "./oauth-http";
import {
  startDeviceAuthorization,
  pollDeviceToken,
  devicePromptLines,
  DEVICE_CODE_GRANT_TYPE,
  type DeviceFlowDeps,
} from "./device-flow";
import type { CredentialRecord } from "./record";

/** The RFC 6749 §4.1 authorization-code grant type (the browser-flow token exchange). */
export const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code";

/** Which flow produced the credential (announced in the result; never a secret). */
export type LoginFlowKind = "browser" | "device";

/**
 * The injected I/O the login flows need. Every network / timing / entropy / browser / socket seam
 * is here so the flows are deterministically testable (no real network, sockets, timers, or
 * browser launch in tests). Production wiring binds the real fetch/clock/CSPRNG + node:http +
 * the per-platform opener.
 */
export interface LoginIoSeams {
  /** OAuth-boundary fetch (no bearer, no version header — the oauth-http helper adds neither). */
  readonly fetch: typeof globalThis.fetch;
  /** Injectable watchdog timers (default: the globals) — shared by the loopback + oauth watchdogs. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Bounded sleep between device polls. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Wall clock (ms) — the token-expiry computation + the device deadline. */
  readonly now: () => number;
  /** CSPRNG seam for the PKCE verifier + the CSRF state (NEVER Math.random). */
  readonly randomBytes: RandomBytes;
  /** Open the authorize URL in the browser (best-effort; validated + re-serialized inside). */
  readonly openUrl: (url: string) => void;
  /** Loopback server factory (default node:http). Injected for the browser-flow tests. */
  readonly createServer?: CreateLoopbackServer;
  /** Host platform (for messaging only; the opener reads its own). */
  readonly platform: NodeJS.Platform;
  /** Interactive-progress sink (chosen-flow announcements are the handler's; device prompt is here). */
  readonly stderr: (line: string) => void;
  /** Overall browser-login watchdog override (tests). */
  readonly watchdogMs?: number;
}

/** Login inputs, resolved by the handler (apiUrl guard-approved; scopes already validated). */
export interface LoginParams {
  /** The guard-approved management base URL (its origin is the OAuth-boundary origin). */
  readonly apiUrl: string;
  /** The public OAuth client id; defaults to the ratified `agkit-cli`. */
  readonly clientId?: string;
  /** Validated scopes (may be empty ⇒ the `scope` param is OMITTED, consent owns the default). */
  readonly scopes: readonly string[];
}

/** The flow's product: a FULL stored record + which flow minted it. Carries NO plaintext beyond the record. */
export interface LoginFlowResult {
  readonly record: CredentialRecord;
  readonly flow: LoginFlowKind;
}

/**
 * A terminal login failure the handler maps to `usage_error` (exit 2) with an `agkit login`
 * hint (B-9). `reason` is a SANITIZED identifier (a closed RFC 6749 token or a fixed string) —
 * never endpoint-controlled free text.
 */
export class LoginFlowError extends Error {
  override name = "LoginFlowError";
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The CLOSED set of RFC 6749 §4.1.2.1 authorization-endpoint error identifiers the loopback
 * callback may legitimately carry. Anything else — including arbitrary endpoint-controlled text
 * riding the `error` query param — collapses to the fixed "unexpected_error", so no
 * server/attacker-controlled bytes reach a surfaced message (mirrors device-flow's P3 closure).
 */
const AUTHORIZE_LEG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

function sanitizeAuthorizeError(raw: string): string {
  return AUTHORIZE_LEG_ERRORS.has(raw) ? raw : "unexpected_error";
}

/** Extract the RFC 6749 `error` token from a token-endpoint error body (never the raw body). */
function tokenErrorOf(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as unknown;
    if (j !== null && typeof j === "object") {
      const err = (j as Record<string, unknown>).error;
      if (typeof err === "string") return sanitizeTokenError(err);
    }
  } catch {
    /* fallthrough */
  }
  return "unexpected_error";
}

/** RFC 6749 §5.2 token-endpoint errors the exchange can draw; everything else → fixed identifier. */
const TOKEN_LEG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);
function sanitizeTokenError(raw: string): string {
  return TOKEN_LEG_ERRORS.has(raw) ? raw : "unexpected_error";
}

/** The OAuth-boundary origin (never a path/query) derived from the guard-approved base URL. */
function originOf(apiUrl: string): string {
  return new URL(apiUrl).origin;
}

/**
 * Build the FULL stored `CredentialRecord` from a validated token response (decision f + B-14).
 * `scope` in the response is AUTHORITATIVE (the server may narrow); the branch is on field
 * PRESENCE (X5): a PRESENT `scope` — including an explicitly EMPTY one — is the server's answer
 * (an empty string means "nothing granted" and stores `[]`; recording the REQUESTED scopes there
 * would be a false privilege recording). Only a truly ABSENT field falls back to the requested
 * scopes (RFC 6749 §5.1). `refresh_token` is schema-mandatory (our AS always rotates).
 * `grant_id` is null — the token success body carries no grant id (correlate later via whoami).
 */
function buildRecord(
  apiOrigin: string,
  clientId: string,
  resp: TokenResponse,
  requestedScopes: readonly string[],
  nowMs: number,
): CredentialRecord {
  const scopes =
    resp.scope !== undefined
      ? resp.scope.split(/\s+/).filter((s) => s.length > 0) // authoritative; "" → []
      : [...requestedScopes];
  const accessExpiresAt =
    resp.expires_in !== undefined ? new Date(nowMs + resp.expires_in * 1000).toISOString() : null;
  return {
    issuer: apiOrigin,
    client_id: clientId,
    access_token: resp.access_token,
    access_expires_at: accessExpiresAt,
    refresh_token: resp.refresh_token,
    grant_id: null,
    scopes,
    binding: null,
    schema: 1,
  };
}

/** Construct the RFC 8252 authorize URL (public params only — the verifier stays local). */
function buildAuthorizeUrl(
  authorizationEndpoint: string,
  opts: { clientId: string; redirectUri: string; challenge: string; state: string; scopes: readonly string[] },
): string {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  if (opts.scopes.length > 0) u.searchParams.set("scope", opts.scopes.join(" ")); // B-3
  return u.href;
}

/**
 * RFC 8252 browser flow: metadata → PKCE + state → loopback → authorize → callback → exchange.
 * The `finally` always closes the listener (port release on success / error / watchdog).
 */
export async function runBrowserLogin(io: LoginIoSeams, params: LoginParams): Promise<LoginFlowResult> {
  const apiOrigin = originOf(params.apiUrl);
  const clientId = params.clientId ?? AGKIT_CLI_CLIENT_ID;
  const oauthDeps: OauthHttpDeps = { fetch: io.fetch, timers: io.timers };

  // 1. AS metadata (fail-closed: issuer + frozen token_endpoint cross-checked inside).
  const meta = await fetchAsMetadata({ fetch: io.fetch, timers: io.timers }, params.apiUrl);

  // 2. PKCE pair + CSRF state — both from the CSPRNG seam (never Math.random).
  const pkce = createPkcePair(io.randomBytes);
  const state = createState(io.randomBytes);

  // 3. One-shot loopback listener (127.0.0.1, ephemeral port).
  const loopbackDeps: LoopbackDeps = { createServer: io.createServer, timers: io.timers, watchdogMs: io.watchdogMs };
  const listener = await createLoopbackListener(state, loopbackDeps);
  try {
    const authorizeUrl = buildAuthorizeUrl(meta.authorizationEndpoint, {
      clientId,
      redirectUri: listener.redirectUri,
      challenge: pkce.challenge,
      state,
      scopes: params.scopes,
    });
    // 4. Open the browser (best-effort). Print the URL to stderr as the fallback (public values only).
    io.openUrl(authorizeUrl);
    io.stderr(`If your browser did not open, visit this URL to authorize:\n  ${authorizeUrl}\n`);
    io.stderr("Waiting for the browser authorization to complete…\n");

    // 5. Wait for the matching-state callback (a mismatched/forged probe never consumes it).
    const outcome = await listener.waitForCallback();
    if (outcome.kind === "error") {
      const reason = sanitizeAuthorizeError(outcome.error);
      throw new LoginFlowError(reason, `browser authorization was refused (${reason})`);
    }

    // 6. Exchange the code (+ the PKCE verifier) at the token endpoint.
    const exchange = new URLSearchParams({
      grant_type: AUTHORIZATION_CODE_GRANT_TYPE,
      code: outcome.code,
      redirect_uri: listener.redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    const res = await postTokenEndpoint(oauthDeps, apiOrigin, exchange);
    if (res.status < 200 || res.status >= 300) {
      const reason = tokenErrorOf(res.bodyText);
      throw new LoginFlowError(reason, `the login token exchange failed (${reason})`);
    }
    const parsed = parseTokenResponse(res.bodyText);
    if (parsed === null) {
      throw new LoginFlowError("invalid_token_response", "the login token exchange returned an unusable response");
    }
    return { record: buildRecord(apiOrigin, clientId, parsed, params.scopes, io.now()), flow: "browser" };
  } finally {
    // Idempotent teardown — releases the ephemeral port on every settle path.
    listener.close();
  }
}

/**
 * RFC 8628 device flow: device_authorization → print the user_code (never the device_code) →
 * poll the token endpoint → build the record. A denied/expired/invalid poll verdict becomes a
 * teachable `LoginFlowError`; a refusal at the authorization leg is `DeviceAuthorizationError`
 * (both mapped to `usage_error` by the handler).
 */
export async function runDeviceLogin(io: LoginIoSeams, params: LoginParams): Promise<LoginFlowResult> {
  const apiOrigin = originOf(params.apiUrl);
  const clientId = params.clientId ?? AGKIT_CLI_CLIENT_ID;
  const deviceDeps: DeviceFlowDeps = {
    fetch: io.fetch,
    timers: io.timers,
    sleep: io.sleep,
    now: io.now,
  };

  const auth = await startDeviceAuthorization(deviceDeps, apiOrigin, {
    clientId,
    scopes: params.scopes.length > 0 ? params.scopes : undefined,
  });
  // Print the user_code + verification URI (+ optional convenience URL) — NEVER the device_code.
  for (const line of devicePromptLines(auth)) io.stderr(line + "\n");

  const outcome = await pollDeviceToken(deviceDeps, apiOrigin, {
    clientId,
    deviceCode: auth.deviceCode,
    interval: auth.interval,
    expiresIn: auth.expiresIn,
  });
  switch (outcome.kind) {
    case "token":
      return { record: buildRecord(apiOrigin, clientId, outcome.response, params.scopes, io.now()), flow: "device" };
    case "denied":
      throw new LoginFlowError("access_denied", "the authorization was denied — nothing was stored");
    case "expired":
      throw new LoginFlowError("expired_token", "the device code expired before it was approved — re-run agkit login");
    case "invalid_grant":
      throw new LoginFlowError("invalid_grant", "the device code is no longer valid — re-run agkit login");
    case "unexpected":
      throw new LoginFlowError(outcome.error, `device authorization failed (${outcome.error})`);
  }
}

/** The device-code grant type, re-exported so the handler/tests reference one constant. */
export { DEVICE_CODE_GRANT_TYPE };
