// The RFC 8628 device-authorization-grant machinery (T-213 S5). Two phases over injected
// fetch/sleep/now seams (no real network / waits in tests):
//
//   1. startDeviceAuthorization — POST device_authorization (client_id + optional space-delimited
//      `scope`, B-3) → the device_code (SECRET — never printed), user_code (already grouped
//      XXXX-XXXX by the server), verification_uri (+ optional verification_uri_complete), interval,
//      expires_in.
//   2. pollDeviceToken — poll the token endpoint (grant_type=…:device_code) at `interval` seconds:
//      authorization_pending → keep waiting; slow_down → +5s (RFC 8628 §3.5); access_denied /
//      expired_token / invalid_grant → terminal; a local deadline = min(expires_in, 600s cap) →
//      terminal timeout. Each RFC 6749 terminal outcome is returned as a discriminated verdict the
//      login handler maps to an EXISTING code (no new codes, B-9).
//
// SECRET CONFINEMENT (B-11): the device_code is NEVER printed and never embedded in any returned
// verdict/error — only the RFC 6749 `error` token (e.g. "invalid_scope") is surfaced. The
// prompt lines (devicePromptLines) print the user_code + verification URIs only; the
// verification_uri_complete is a PLAIN printed URL, NEVER handed to the browser opener.
import {
  postForm,
  postTokenEndpoint,
  parseTokenResponse,
  OAUTH_DEVICE_AUTHORIZATION_PATH,
  type OauthHttpDeps,
  type TokenResponse,
} from "./oauth-http";

/** The RFC 8628 device-code grant type. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Hard cap on the poll deadline regardless of the server's advertised `expires_in` (seconds). */
export const DEVICE_DEADLINE_CAP_S = 600;
/** RFC 8628 defaults when the device_authorization response omits them. */
export const DEFAULT_DEVICE_INTERVAL_S = 5;
/** slow_down bump (RFC 8628 §3.5). */
export const SLOW_DOWN_BUMP_S = 5;

export interface DeviceFlowDeps extends OauthHttpDeps {
  /** Bounded sleep between polls (injected — no real waits in tests). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Wall clock (ms) for the deadline. */
  readonly now: () => number;
}

/** The device_authorization response the CLI acts on. `deviceCode` is a SECRET. */
export interface DeviceAuthorization {
  /** SECRET — presented at the token endpoint, NEVER printed/logged/returned in a verdict. */
  readonly deviceCode: string;
  /** The grouped code the user types (server-normalized XXXX-XXXX). */
  readonly userCode: string;
  /** Where the user goes to authorize. */
  readonly verificationUri: string;
  /** The pre-filled convenience URL (printed as a PLAIN URL only) — optional (B-14). */
  readonly verificationUriComplete: string | null;
  /** Poll interval (seconds). */
  readonly interval: number;
  /** Server-advertised lifetime (seconds). */
  readonly expiresIn: number;
}

/** A refused device_authorization (e.g. invalid_client). Mapped to an existing code by the caller. */
export class DeviceAuthorizationError extends Error {
  override name = "DeviceAuthorizationError";
  constructor(readonly oauthError: string) {
    super(`device authorization was refused (${oauthError})`);
  }
}

/** The poll verdict — a token, or a terminal reason the handler maps to an existing code. */
export type DevicePollOutcome =
  | { readonly kind: "token"; readonly response: TokenResponse }
  | { readonly kind: "denied" } // access_denied
  | { readonly kind: "expired" } // expired_token OR the local deadline lapsed
  | { readonly kind: "invalid_grant" } // consumed / other RFC invalid_grant
  | { readonly kind: "unexpected"; readonly error: string }; // any other RFC 6749 error / malformed 200

/**
 * The CLOSED set of error identifiers the device_authorization (authorization) leg can
 * legitimately return. RFC 8628 §3.2 defers error responses to the RFC 6749 §5.2 format; of that
 * registry, a request carrying only `client_id` + `scope` can meaningfully draw invalid_request /
 * invalid_client / unauthorized_client / invalid_scope (no grant is presented, so invalid_grant /
 * unsupported_grant_type do not apply). access_denied (RFC 6749 §4.1.2.1) is included because
 * servers use it to signal a policy refusal of the device grant for this client. Everything else —
 * including arbitrary endpoint-controlled strings — is replaced by the fixed "unexpected_error",
 * so no server-controlled bytes ever reach an error message (the hazard class P3 closed in the
 * poll loop: control-character / terminal-injection payloads riding the `error` member).
 */
const AUTHORIZATION_LEG_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
  "access_denied",
]);

/** Allowlisted identifier → as-is; anything else (including null) → the fixed "unexpected_error". */
function sanitizeOauthError(raw: string | null): string {
  return raw !== null && AUTHORIZATION_LEG_ERRORS.has(raw) ? raw : "unexpected_error";
}

/** Extract the RFC 6749 `error` token from a response body, or null. Never returns the raw body. */
function parseOauthError(bodyText: string): string | null {
  try {
    const j = JSON.parse(bodyText) as unknown;
    if (j !== null && typeof j === "object") {
      const err = (j as Record<string, unknown>).error;
      if (typeof err === "string") return err;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Start the device flow: POST the device_authorization request. `scopes` (already validated by the
 * caller) are transmitted as the space-delimited `scope` param; when omitted the param is OMITTED
 * (the consent surface owns the default, B-3). Throws `DeviceAuthorizationError` on a refusal.
 */
export async function startDeviceAuthorization(
  deps: DeviceFlowDeps,
  origin: string,
  opts: { clientId: string; scopes?: readonly string[] },
): Promise<DeviceAuthorization> {
  const params = new URLSearchParams({ client_id: opts.clientId });
  if (opts.scopes && opts.scopes.length > 0) params.set("scope", opts.scopes.join(" "));

  const res = await postForm(deps, origin, OAUTH_DEVICE_AUTHORIZATION_PATH, params);
  if (res.status < 200 || res.status >= 300) {
    throw new DeviceAuthorizationError(sanitizeOauthError(parseOauthError(res.bodyText)));
  }

  let body: unknown;
  try {
    body = JSON.parse(res.bodyText);
  } catch {
    throw new DeviceAuthorizationError("invalid_response");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const deviceCode = asString(b.device_code);
  const userCode = asString(b.user_code);
  const verificationUri = asString(b.verification_uri);
  const expiresIn = asNumber(b.expires_in);
  if (deviceCode === null || userCode === null || verificationUri === null || expiresIn === null) {
    throw new DeviceAuthorizationError("invalid_response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: asString(b.verification_uri_complete), // optional (B-14)
    interval: asNumber(b.interval) ?? DEFAULT_DEVICE_INTERVAL_S,
    expiresIn,
  };
}

/**
 * Poll the token endpoint until the user approves/denies or the deadline lapses. The deadline is
 * `min(expiresIn, 600s)` from now (cap enforced even if the server advertises more). Waits
 * `interval` seconds (clamped to the remaining budget) before each poll; slow_down bumps the
 * interval by 5s; the deadline is re-checked after every wake so nothing is sent past it (P2).
 */
export async function pollDeviceToken(
  deps: DeviceFlowDeps,
  origin: string,
  opts: { clientId: string; deviceCode: string; interval: number; expiresIn: number },
): Promise<DevicePollOutcome> {
  let interval = opts.interval > 0 ? opts.interval : DEFAULT_DEVICE_INTERVAL_S;
  const cappedLifetime = Math.min(opts.expiresIn, DEVICE_DEADLINE_CAP_S);
  const deadline = deps.now() + cappedLifetime * 1000;

  for (;;) {
    // P2: the sleep is CLAMPED to the remaining budget, and the deadline is re-checked AFTER
    // waking, BEFORE constructing/sending — so the 600s cap holds under a hostile/large interval
    // and accumulated slow_down bumps, and nothing is ever sent past the deadline.
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { kind: "expired" }; // local deadline (cap-bounded)
    await deps.sleep(Math.min(interval * 1000, remaining));
    if (deps.now() >= deadline) return { kind: "expired" }; // post-wake re-check — never send late

    const params = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: opts.deviceCode,
      client_id: opts.clientId,
    });
    const res = await postTokenEndpoint(deps, origin, params);

    if (res.status >= 200 && res.status < 300) {
      const parsed = parseTokenResponse(res.bodyText);
      if (parsed === null) return { kind: "unexpected", error: "invalid_token_response" };
      return { kind: "token", response: parsed };
    }

    const error = parseOauthError(res.bodyText);
    switch (error) {
      case "authorization_pending":
        continue; // keep waiting (deadline re-checked at the top)
      case "slow_down":
        interval += SLOW_DOWN_BUMP_S;
        continue;
      case "access_denied":
        return { kind: "denied" };
      case "expired_token":
        return { kind: "expired" };
      case "invalid_grant":
        return { kind: "invalid_grant" };
      default:
        // P3: ALWAYS the fixed identifier — an unrecognized `error` is endpoint-controlled text
        // (it could echo the device_code or carry control characters) and NEVER reaches the
        // outcome. Only the closed set of recognized OAuth identifiers keeps named cases above.
        return { kind: "unexpected", error: "unexpected_error" };
    }
  }
}

/**
 * The stderr prompt lines for the device flow (decision (e) + B-11 + B-14). Prints the user_code +
 * the verification URI (and the plain convenience URL when present) — NEVER the device_code, and
 * the convenience URL is text only (never handed to the browser opener). Pure — the handler writes.
 */
export function devicePromptLines(auth: DeviceAuthorization): string[] {
  const lines = [
    `To authorize this CLI, open: ${auth.verificationUri}`,
    `and enter the code: ${auth.userCode}`,
  ];
  if (auth.verificationUriComplete !== null) {
    lines.push(`(or open this URL directly, which pre-fills the code: ${auth.verificationUriComplete})`);
  }
  lines.push("Waiting for approval in your browser…");
  return lines;
}
