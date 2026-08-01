// BYO-endpoint FORM + STRUCTURAL TRANSPORT-SAFETY validation for `provider-key add` / `rotate`
// (T-217 §3B, RR-5a/c/d + RA-1). Shared by BOTH verbs.
//
// The distinction this module enforces is CUSTODY + TRANSPORT SAFETY — properties of the CHANNEL
// (what may safely ride in argv, cross a reconstruction, or alter HTTP transport semantics) — NOT
// provider realization POLICY. Provider policy (https-only, SSRF/egress ranges, the auth_style
// enum, the closed extra-header allowlist, count/size caps) is SERVER-OWNED (honor-or-reject: the
// client passes form-valid values through and lets the authority teach). So this module:
//   • parses `--endpoint-url` (structural: reject URL userinfo, #fragments, and credential-bearing
//     query params — RA-1 — because those put a secret in argv/a reconstruction; PLUS the
//     canonical-form rule, which is the #fragment rule generalized: the server stores exactly what
//     it dispatches, so any string the WHATWG URL parser would REWRITE is rejected there and is
//     rejected here first, at the point of typing, instead of after a round trip; it does NOT copy
//     https-only or SSRF policy);
//   • lowercase-FOLDS every header name (RR-5a: the fold is what the body carries — canonical form
//     to the server; case-insensitive duplicate/collision detection falls out of the fold);
//   • rejects, structurally, a header name that would create a SECOND auth header or a transport
//     hazard (the exactly-one-auth-header property, client half; the server proves the outbound half).
//
// [R-H #2 / RR-5d] EVERY rejection message is STATIC — it NEVER interpolates any flag value or
// header name (a mistaken paste can put a secret in any of these positions). Messages are sentinel-
// scanned in byo-form.test.ts.
import { CliLocalError } from "../../core/errors";

/** Conservative HTTP field-name token — mirrors the server's OAC_HEADER_NAME_RE (grammar, not policy;
 *  blocks CR/LF injection at the source). Applied to the LOWERCASE-FOLDED name. */
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Control characters an HTTP header VALUE must never carry (CR / LF / NUL and the C0/DEL class). */
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

/**
 * The CLOSED transport / hop-by-hop header set (RFC 7230 §6.1 connection-tokens + framing/routing
 * headers). Rejecting these as a `header_name` or an `extra_headers` key is ARGV/CUSTODY + TRANSPORT
 * SAFETY (a client must never let a config header rewrite framing/routing), NOT provider policy.
 * Additively extensible. All entries are lowercase (comparisons fold first).
 */
export const STRUCTURAL_HEADER_DENYLIST: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "expect",
];
const STRUCTURAL_HEADER_SET = new Set(STRUCTURAL_HEADER_DENYLIST);

/** Authorization-class header names (folded). These carry credentials — an `extra_headers` key may
 *  never be one (the API key rides the SELECTED auth header only). `authorization`/`proxy-authorization`
 *  are ALSO forbidden as a `header_name`; `cookie` is authorization-class for extra_headers. */
const AUTHORIZATION_CLASS = new Set(["authorization", "proxy-authorization", "cookie"]);
const HEADER_NAME_FORBIDDEN = new Set([...STRUCTURAL_HEADER_SET, "authorization", "proxy-authorization"]);

/**
 * RA-1: credential-bearing query-parameter names must never ride the endpoint URL (⇒ argv, shell
 * history, or a reconstruction). Detection tokenizes the name on EVERY non-alphanumeric boundary AND
 * camelCase boundaries, then classifies each lowercased segment — so `client_secret`,
 * `subscription-key`, `x-api-key`, `sessionToken`, `secretAccessKey`, and presigned-URL params
 * (`X-Amz-Credential`/`X-Amz-Signature`/`X-Amz-Security-Token`, `X-Goog-Signature`) are all caught,
 * while genuinely non-secret params (`api-version`, `x-amz-date`, `x-amz-algorithm`, `model`, and
 * ordinary words like `monkey`/`turnkey`) pass. Custody only — the server still owns
 * https-only/SSRF/allowlist policy. Classification per segment:
 *   • atomic credential word (exact: secret/password/signature/jwt/bearer/…); OR
 *   • ends with a strong credential suffix (secret/password/credential/signature — no common word
 *     ends in these, so jammed compounds like `clientsecret` are caught safely); OR
 *   • the AMBIGUOUS words `key`/`token` — classified via the KEY_CRED_PREFIX allowlist and the
 *     BENIGN_TOKEN_NAME whole-name allowlist below, which is where `apitoken`/`access_token` are
 *     caught and `page_token`/`sort_key` are let through.
 */
// Unambiguous credential words — any segment equal to one is credential-bearing.
const CREDENTIAL_ATOM: ReadonlySet<string> = new Set([
  "secret", "password", "passphrase", "passwd", "pwd", "credential", "credentials",
  "signature", "sig", "auth", "authorization", "sas", "hmac", "jwt", "bearer", "assertion", "verifier",
]);
/** Suffixes safe to match on ANY compound — no common word ends in these (jammed `clientsecret`). */
const CREDENTIAL_SUFFIX: readonly string[] = ["secret", "password", "passphrase", "credential", "signature", "assertion"];
/**
 * `key` and `token` are AMBIGUOUS — a credential (`api-key`, `access_token`) or a benign identifier/
 * cursor (`sort_key`, `partition-key`, `page_token`, `continuation_token`) — but the two words sit on
 * OPPOSITE default sides, so they classify in opposite directions:
 *   • `key`: benign `*_key` names are common and open-ended (sort/partition/routing/range/group/…),
 *     while credential keys are an ENUMERABLE set → ALLOWLIST: `key` is a credential only as the whole
 *     name or after a credential prefix (KEY_CRED_PREFIX); any other qualifier keeps it benign.
 *   • `token`: benign `*_token` names are essentially ONLY a handful of pagination cursors, while
 *     credential/capability tokens are open-ended → FAIL-CLOSED WHOLE-NAME ALLOWLIST: ANY name that
 *     contains a `token` word (or a jammed `*token` compound) is credential-bearing UNLESS the WHOLE
 *     normalized name exactly equals a benign pagination cursor (BENIGN_TOKEN_NAME). Whole-name (not
 *     prefix) matching is deliberate — it cannot be bypassed by prepending or inserting a credential
 *     qualifier (`pageaccesstoken`, `access_page_token` both reject), and a future OAuth-family or
 *     capability token needs no new vocabulary here.
 * This is a BEST-EFFORT client custody heuristic (fail-fast on an obvious pasted secret) — the SERVER
 * owns the authoritative BYO policy (https-only, SSRF, the closed allowlist) and is the final
 * honor-or-reject authority, so a residual heuristic gap is defense-in-depth, not the sole gate.
 */
const KEY_CRED_PREFIX = new Set([
  "api", "access", "secret", "private", "shared", "subscription", "signing", "signature", "hmac", "app",
  "auth", "client", "consumer", "license", "master", "encryption", "session", "account",
]);
/**
 * The CLOSED set of benign pagination-cursor names — normalized to the space-joined tokenization
 * (delimited + camelCase forms) AND their all-lowercase jammed equivalents. A token-bearing name that
 * is not EXACTLY one of these is credential-bearing.
 */
const BENIGN_TOKEN_NAME = new Set([
  "page token", "pagetoken",
  "next token", "nexttoken",
  "next page token", "nextpagetoken",
  "continuation token", "continuationtoken",
  "sync token", "synctoken",
]);

function isSecretQueryParam(name: string): boolean {
  // Insert boundaries at camelCase transitions (aB → a B; ABCd → AB Cd for acronym runs), then split
  // on EVERY non-alphanumeric boundary — not just `-_.` — so bracket/nesting syntax can't hide a
  // credential word: `token[]`, `access_token[0]`, `auth[token]` (and percent-decoded `auth%5Btoken%5D`,
  // since URLSearchParams decodes before this check) all tokenize a bare `token`/`auth` segment out.
  // `secretAccessKey`/`nextPageToken` tokenize into words while `monkey`/`turnkey` stay whole.
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const segments = spaced.split(/[^A-Za-z0-9]+/).filter((s) => s !== "").map((s) => s.toLowerCase());
  const sole = segments.length === 1;

  // token-bearing names are fail-closed: any name with a `token` word or jammed `*token` compound is a
  // credential UNLESS the WHOLE normalized name is an exact benign pagination cursor. Whole-name (not
  // prefix/adjacency) matching blocks `pageaccesstoken` and `access_page_token`.
  const tokenBearing = segments.some((s) => s === "token" || (s.length > 5 && s.endsWith("token")));
  if (tokenBearing && !BENIGN_TOKEN_NAME.has(segments.join(" "))) return true;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (CREDENTIAL_ATOM.has(seg)) return true;
    for (const suffix of CREDENTIAL_SUFFIX) {
      if (seg.length > suffix.length && seg.endsWith(suffix)) return true;
    }
    const prev = i > 0 ? segments[i - 1]! : undefined;
    if (seg === "key") {
      // ALLOWLIST: credential only as the whole name or after a credential prefix (not sort_key/pageKey).
      if (sole || (prev !== undefined && KEY_CRED_PREFIX.has(prev))) return true;
    } else if (seg.length > 3 && seg.endsWith("key")) {
      // jammed compound (`apikey`, `accesskey`) — a credential prefix decides (not `monkey`/`turnkey`).
      for (const prefix of KEY_CRED_PREFIX) if (seg.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** The `--extra-header` help/description text — NOTES the server allowlist (no allowlist values
 *  embedded: policy copy = drift). Referenced by both `add` and `rotate` arg schemas. */
export const EXTRA_HEADER_HELP =
  "A non-secret metadata header, name=value (repeatable). The server enforces a CLOSED allowlist of non-secret header names and teaches on violation; a secret NEVER belongs here (the key rides the auth header only).";

// The STATIC messages (zero interpolation of any input byte).
const M = {
  urlInvalid: "--endpoint-url must be a valid URL.",
  urlUserinfo:
    "the endpoint URL must not carry userinfo (user:password@) — credentials never ride in argv or URLs; use --api-key-env or the hidden prompt.",
  urlFragment: "the endpoint URL must not carry a #fragment.",
  urlNotCanonical:
    "the endpoint URL must already be in the canonical form that gets dispatched — lowercase scheme and host, no default :443 port, no surrounding whitespace or control characters, an ASCII (punycode) host, an explicit path (at least /), and a path/query the URL parser leaves untouched (percent-encoding already applied, no dot segments, no backslashes). The server stores what it dispatches, so it rejects rather than rewrite your URL — and so does this, before the round trip.",
  urlSecretQuery:
    "the endpoint URL must not carry a credential in a query parameter (e.g. ?api_key=… or ?token=…) — credentials never ride in argv or URLs; use --api-key-env or the hidden prompt.",
  headerNameGrammar:
    "--header-name must be a valid HTTP header name (letters, digits, hyphen; starting alphanumeric).",
  headerNameForbidden:
    "--header-name must not be a transport/hop-by-hop or authorization header.",
  extraMalformed: "each --extra-header must be name=value.",
  extraNameGrammar:
    "each --extra-header name must be a valid HTTP header name (letters, digits, hyphen; starting alphanumeric).",
  extraValueControl: "an --extra-header value must not contain control characters (CR, LF, or NUL).",
  extraDuplicate:
    "duplicate --extra-header names (case-insensitive): each header name may appear at most once.",
  extraAuthClass:
    "an --extra-header must not be an authorization-class header (authorization, proxy-authorization, cookie) — the API key rides the auth header only.",
  extraTransport: "an --extra-header must not be a transport/hop-by-hop header.",
  extraReusesHeaderName:
    "an --extra-header must not reuse the selected --header-name — the auth header must remain the only auth-bearing header.",
} as const;

function reject(detail: string): never {
  throw new CliLocalError("usage_error", { detail });
}

/** The BYO members `add`/`rotate` may carry, before validation (kebab flag keys). */
export interface ByoFormInput {
  readonly "endpoint-url"?: string;
  readonly "auth-style"?: string;
  readonly "header-name"?: string;
  readonly "extra-header"?: string | string[];
}

/** Normalize the scalar-or-array `--extra-header` input to an ordered string[]. */
function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Structural endpoint-URL check (form + RA-1). Passes the ORIGINAL string through verbatim on
 *  success — the server owns https-only/SSRF policy. Static messages; never echoes the URL. */
function validateEndpointUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    reject(M.urlInvalid);
  }
  if (url.username !== "" || url.password !== "") reject(M.urlUserinfo); // userinfo = a secret in argv
  if (url.hash !== "") reject(M.urlFragment); // a #fragment never belongs on a dispatch URL
  for (const name of url.searchParams.keys()) {
    if (isSecretQueryParam(name)) reject(M.urlSecretQuery); // RA-1: a credential-bearing query
  }
  // CANONICAL FORM — FORM, not policy. The server stores what it dispatches, so a URL the WHATWG
  // parser would rewrite (uppercase host/scheme, `:443`, surrounding whitespace/C0 controls, an
  // IDN host, an omitted path, an unencoded path byte, a dot segment) is a hard REJECT there, never
  // a silent normalization. Catching it HERE turns a round-trip rejection into a fail-fast at the
  // point of typing. This is the same shape as the #fragment rule directly above (both are "the
  // string is not what would go on the wire"), NOT a copy of https-only/SSRF policy. LAST, so a
  // custody rejection above always wins the message. The canonical form is deliberately NOT shown:
  // [R-H #2 / RR-5d] every message in this module is static, sentinel-scanned, and a BYO URL's path
  // or query can carry pasted key material — which a JSON-envelope error would carry into whatever
  // consumes this CLI's stderr. The enumerated rules are the actionable half.
  if (raw !== url.href) reject(M.urlNotCanonical);
  return raw;
}

/** Fold + grammar-check + structural-denylist a `--header-name`. Returns the FOLDED name (RR-5a). */
function validateHeaderName(raw: string): string {
  const folded = raw.toLowerCase();
  if (!HEADER_NAME_RE.test(folded)) reject(M.headerNameGrammar);
  // RR-5b: an api-key-STYLE name (e.g. `api-key`) is LEGAL for header_name — that is its purpose.
  if (HEADER_NAME_FORBIDDEN.has(folded)) reject(M.headerNameForbidden);
  return folded;
}

/**
 * Build the validated BYO config members from parsed flags (kebab→snake). ONLY members whose flag
 * is present are included — an add/rotate without BYO flags returns `{}` (v1.1.0-compatible bytes).
 * Header names are lowercase-folded; the fold is what the body carries. All rejections are static.
 */
export function buildByoConfig(parsed: ByoFormInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (parsed["endpoint-url"] !== undefined) {
    body["endpoint_url"] = validateEndpointUrl(parsed["endpoint-url"]);
  }

  // auth_style — non-empty (zod min(1)) string passed through VERBATIM; the closed enum is server
  // policy (no client copy — vocabulary drift; honor-or-reject belongs to the authority).
  if (parsed["auth-style"] !== undefined) {
    body["auth_style"] = parsed["auth-style"];
  }

  // header_name — the SELECTED auth header; folded, grammar-checked, structural-denied.
  let selectedHeader: string | undefined;
  if (parsed["header-name"] !== undefined) {
    selectedHeader = validateHeaderName(parsed["header-name"]);
    body["header_name"] = selectedHeader;
  }

  const extraOccurrences = asArray(parsed["extra-header"]);
  if (extraOccurrences.length > 0) {
    const extraHeaders: Record<string, string> = {};
    for (const occurrence of extraOccurrences) {
      const eq = occurrence.indexOf("=");
      if (eq <= 0) reject(M.extraMalformed); // no name, or leading `=`
      const name = occurrence.slice(0, eq).toLowerCase(); // RR-5a: fold at validation
      const value = occurrence.slice(eq + 1);
      if (!HEADER_NAME_RE.test(name)) reject(M.extraNameGrammar);
      if (CONTROL_CHAR.test(value)) reject(M.extraValueControl);
      // case-folded COLLISION rejections (structural, custody) — per class:
      if (AUTHORIZATION_CLASS.has(name)) reject(M.extraAuthClass);
      if (STRUCTURAL_HEADER_SET.has(name)) reject(M.extraTransport);
      if (selectedHeader !== undefined && name === selectedHeader) reject(M.extraReusesHeaderName);
      // case-insensitive duplicate (the fold collapses casing variants to one key).
      if (Object.prototype.hasOwnProperty.call(extraHeaders, name)) reject(M.extraDuplicate);
      extraHeaders[name] = value; // repeats fold to the `extra_headers` object (lowercased keys)
    }
    body["extra_headers"] = extraHeaders;
  }

  return body;
}
