// AS-metadata fetch + fail-closed validation (T-213 S4, decision (e) + B-10). The CLI derives the
// credential-bearing endpoints (token / device_authorization / revocation) from the guard-approved
// apiUrl + the CONTRACT-FROZEN paths — it does NOT trust the metadata for those. The ONE thing it
// cannot derive is the `authorization_endpoint` (the dashboard origin ≠ the api origin), so it
// fetches the RFC 8414 document at login time for exactly that, plus a fail-closed cross-check:
//
//   • the metadata `issuer` MUST equal the guard-approved api origin (a mismatch is skew-grade);
//   • the advertised `token_endpoint` MUST EQUAL the frozen `{apiOrigin}${OAUTH_TOKEN_PATH}` —
//     merely sharing the origin is not enough (B-10 / codex #11): an AS contradicting our pinned
//     contract is never silently followed;
//   • the `authorization_endpoint` is parsed with `new URL`, required https (or http-to-loopback
//     for local dev), and RE-SERIALIZED before it ever reaches the browser opener.
//
// Any violation REFUSES with a teachable `AsMetadataError` — no credentials have been sent yet, so
// fail-closed is free. The document is NOT cached (login is a rare interactive one-shot).
import { OAUTH_TOKEN_PATH } from "./oauth-http";

/** The RFC 8414 AS-metadata document path (on the api origin). */
export const AS_METADATA_PATH = "/v1/management/.well-known/oauth-authorization-server";
/** Bounded fetch watchdog for the metadata GET. */
export const AS_METADATA_TIMEOUT_MS = 20_000;
/**
 * Max bytes the AS-metadata document may occupy (T-223 coordination). A valid RFC 8414 document is
 * a few hundred bytes; this is a generous ceiling a hostile confirmed origin cannot exceed to
 * exhaust memory. Promoting `fetchAsMetadata` from a rare interactive login one-shot to GA-command
 * duty (`dashboard` + `account security`) requires this bound. Enforced against BOTH a declared
 * `Content-Length` AND the bytes actually streamed — a lying or absent length cannot bypass it.
 * (This path does NOT flow through `core/client/transport.ts`, so the transport's bounded reader
 * does not cover it — the discipline is applied here directly.)
 */
export const AS_METADATA_MAX_BYTES = 65_536;

/** The single validated value the CLI consumes from the metadata: the authorize endpoint. */
export interface AsMetadata {
  /** The validated + re-serialized `authorization_endpoint` (dashboard origin). */
  readonly authorizationEndpoint: string;
}

export interface AsMetadataDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** A refused/failed AS-metadata resolution. Mapped to an existing code by the caller (no new codes). */
export class AsMetadataError extends Error {
  override name = "AsMetadataError";
}

/**
 * Is `hostname` a LITERAL loopback address? (Cleartext http to the authorize endpoint is local-dev
 * only.) "localhost" is deliberately excluded — it is resolver-controlled (hosts file / DNS) and
 * can point off-box; this predicate matches open-url's post-P4 predicate exactly.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** Parse an origin from a URL string, or throw AsMetadataError. */
function originOf(url: string, label: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new AsMetadataError(`${label} is not a valid URL`);
  }
}

/** Bounded GET of the metadata document (no bearer, no version header, redirect:manual). */
async function getMetadataBody(deps: AsMetadataDeps, url: string): Promise<string> {
  const timeoutMs = deps.timeoutMs ?? AS_METADATA_TIMEOUT_MS;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const controller = new AbortController();
  const watchdog = timers.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "manual",
    });
    // Reject an oversized DECLARED length up front (cheap), then bound the actual stream — a lying
    // or absent `Content-Length` still cannot bypass the mid-stream cap.
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > AS_METADATA_MAX_BYTES) {
      controller.abort();
      throw new AsMetadataError(oversizeMessage());
    }
    const bodyText = await readBoundedBody(res, controller);
    if (res.status < 200 || res.status >= 300) {
      throw new AsMetadataError(`could not fetch OAuth authorization-server metadata (HTTP ${res.status})`);
    }
    return bodyText;
  } catch (err) {
    if (err instanceof AsMetadataError) throw err;
    if (controller.signal.aborted) {
      throw new AsMetadataError(`fetching OAuth authorization-server metadata timed out after ${timeoutMs}ms`);
    }
    throw new AsMetadataError(`network error fetching OAuth authorization-server metadata`);
  } finally {
    timers.clearTimeout(watchdog);
  }
}

/** The single static over-cap message (no interpolation of any response byte). */
function oversizeMessage(): string {
  return `OAuth authorization-server metadata is larger than the ${AS_METADATA_MAX_BYTES}-byte limit`;
}

/**
 * Decode with the FATAL decoder, mapping its `TypeError` to the single static malformed-bytes
 * refusal — no byte of the response is ever interpolated into the message. Aborts the socket first,
 * like the oversize path: once the document is refused there is nothing left worth reading.
 */
function decodeOrRefuse(decode: () => string, controller: AbortController): string {
  try {
    return decode();
  } catch {
    controller.abort();
    throw new AsMetadataError("OAuth authorization-server metadata was not valid UTF-8");
  }
}

/**
 * Read `res` into text, enforcing `AS_METADATA_MAX_BYTES` WHILE consuming (so an absent/lying
 * `Content-Length` cannot bypass the bound). Streams via the body reader when present; a Response
 * with no readable stream falls back to `.arrayBuffer()` with a post-hoc byte check. Aborts the
 * socket + throws `AsMetadataError` the instant the accumulated byte count exceeds the cap.
 *
 * The decode is FATAL on BOTH paths. This is an authorization-server trust boundary, and a lenient
 * decoder substitutes U+FFFD for malformed bytes — a legal JSON string character, so the corruption
 * sails through the parse guard and lands INSIDE a validated endpoint. Bytes that are not UTF-8 are
 * not a document; they are refused. (`res.text()` is non-fatal by spec and cannot express this,
 * which is why the no-stream path reads raw bytes and decodes them here.)
 */
async function readBoundedBody(res: Response, controller: AbortController): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = res.body;
  if (!stream || typeof stream.getReader !== "function") {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > AS_METADATA_MAX_BYTES) {
      throw new AsMetadataError(oversizeMessage());
    }
    return decodeOrRefuse(() => decoder.decode(bytes), controller);
  }
  const reader = stream.getReader();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > AS_METADATA_MAX_BYTES) {
          controller.abort();
          throw new AsMetadataError(oversizeMessage());
        }
        out += decodeOrRefuse(() => decoder.decode(value, { stream: true }), controller);
      }
    }
    // The flush is where a TRUNCATED trailing multi-byte sequence surfaces — `{ stream: true }`
    // legitimately holds an incomplete tail back, so only this final decode can reject it.
    out += decodeOrRefuse(() => decoder.decode(), controller);
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* best-effort: releasing an errored reader must never mask the real failure */
    }
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Fetch + validate the AS metadata for `apiUrl`. Returns ONLY the validated authorize endpoint;
 * throws `AsMetadataError` (fail-closed) on any fetch/parse/skew violation. `apiUrl` is the
 * guard-approved management base URL.
 */
export async function fetchAsMetadata(deps: AsMetadataDeps, apiUrl: string): Promise<AsMetadata> {
  const apiOrigin = originOf(apiUrl, "the management API URL");
  const bodyText = await getMetadataBody(deps, `${apiOrigin}${AS_METADATA_PATH}`);

  let doc: unknown;
  try {
    doc = JSON.parse(bodyText);
  } catch {
    throw new AsMetadataError("OAuth authorization-server metadata was not valid JSON");
  }
  if (doc === null || typeof doc !== "object") {
    throw new AsMetadataError("OAuth authorization-server metadata was not an object");
  }
  const meta = doc as Record<string, unknown>;

  // 1. issuer must EQUAL the guard-approved api origin EXACTLY (P1) — not merely share an origin.
  //    `https://api.agkit.cloud/other-tenant` or `…?tenant=x` names a DIFFERENT authorization
  //    server on the same host; following it is skew-grade. Parsed with `new URL`, then required
  //    to carry no userinfo / query / fragment and no path beyond the bare root ("" or "/" — the
  //    URL-normalized twin of the bare origin the golden pins).
  const issuer = asString(meta.issuer);
  if (issuer === null) throw new AsMetadataError("OAuth metadata is missing the issuer");
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new AsMetadataError("the OAuth metadata issuer is not a valid URL");
  }
  const issuerIsExactOrigin =
    issuerUrl.origin === apiOrigin &&
    issuerUrl.username === "" &&
    issuerUrl.password === "" &&
    issuerUrl.search === "" &&
    issuerUrl.hash === "" &&
    (issuerUrl.pathname === "/" || issuerUrl.pathname === "");
  if (!issuerIsExactOrigin) {
    throw new AsMetadataError(
      "the OAuth metadata issuer does not exactly equal the management API origin — refusing (possible endpoint skew)",
    );
  }

  // 2. token_endpoint must EQUAL the frozen contract path on the api origin (not merely share origin).
  const tokenEndpoint = asString(meta.token_endpoint);
  const expectedTokenEndpoint = `${apiOrigin}${OAUTH_TOKEN_PATH}`;
  if (tokenEndpoint === null || tokenEndpoint !== expectedTokenEndpoint) {
    throw new AsMetadataError(
      "the OAuth metadata token_endpoint does not match the frozen contract endpoint — refusing (skew)",
    );
  }

  // 3. authorization_endpoint: parse, require https (or http-to-loopback), re-serialize.
  const authEndpoint = asString(meta.authorization_endpoint);
  if (authEndpoint === null) throw new AsMetadataError("OAuth metadata is missing the authorization_endpoint");
  let authUrl: URL;
  try {
    authUrl = new URL(authEndpoint);
  } catch {
    throw new AsMetadataError("the OAuth metadata authorization_endpoint is not a valid URL");
  }
  const httpsOk = authUrl.protocol === "https:";
  const httpLoopbackOk = authUrl.protocol === "http:" && isLoopbackHostname(authUrl.hostname);
  if (!httpsOk && !httpLoopbackOk) {
    throw new AsMetadataError(
      `refusing a non-https authorization_endpoint (scheme '${authUrl.protocol.replace(/:$/, "")}')`,
    );
  }

  return { authorizationEndpoint: authUrl.href };
}
