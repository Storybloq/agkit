// Transport (T-211 step 3a). Owns the SINGLE fetch call for one send of a prepared
// request. It assembles the three CLI-owned headers, applies a per-request
// `AbortController` watchdog (RULES: the caller owns every unbounded wait), and reads
// the server's ADVERTISED management-version header off EVERY response — including
// errors — so step 5's version fence has the raw value. Transport does NOT act on the
// advertised version; it only surfaces it.
//
// Failure discipline: a network error or an abort (timeout) becomes a typed
// `TransportError` carrying `kind`; a real HTTP response — 2xx OR ≥400 — is returned as
// a `TransportResult` (classification is classify.ts's job, not transport's).
import { MANAGEMENT_ROUTES_VERSION } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import { VERSION } from "../../version";
import type { PreparedRequest } from "./prepare";
import { RequestPreparationError } from "./prepare";
import { MAX_RESPONSE_BYTES } from "./limits";

/** The server's version header — must match the constant in the management-version middleware. */
export const MANAGEMENT_VERSION_HEADER = "X-AgentKit-Management-Version";
/**
 * The client SURFACE-TAG header. Default value `cli/<version>` (same version source `agkit
 * version` reports); the MCP session overrides it to `mcp-local/<version>` via the `clientTag`
 * seam (T-227 R13a) — the server sanitizes and persists this tag into the PLAN_APPLIED audit row,
 * so the tag is what lets an auditor tell WHICH surface issued a mutation.
 */
export const CLIENT_HEADER = "X-AgentKit-Client";
/** Default per-request watchdog (RULES: every unbounded wait gets a bound). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A transport-level failure (never a wire response). `kind` drives retry eligibility (A39). */
export class TransportError extends Error {
  override name = "TransportError";
  constructor(
    readonly kind: "network" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

/** All seams injected — no real network/clock in tests (RULES: caller owns timeouts). */
export interface TransportDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Per-request watchdog budget; defaults to DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * T-227 R13a: the `X-AgentKit-Client` surface tag. Defaults to `cli/<VERSION>` — the exact byte
   * pattern every CLI send has always carried, so an omitting caller sees ZERO behavior change.
   * The MCP session passes `mcp-local/<VERSION>` (built from the SAME `VERSION` source, never a
   * second hardcoded version) so the server's audit rows can distinguish which surface issued a
   * request. A tag, not a policy: transport stamps it verbatim and nothing downstream branches on it.
   */
  readonly clientTag?: string;
  /**
   * Injectable watchdog timer seam (finding 5); defaults to the globals. A test injects
   * recording timers to prove the watchdog handle is cleared on success and that firing the
   * captured callback aborts the in-flight request — with no real waits.
   */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** The raw outcome of ONE send. `advertisedVersion` is read off the response for step 5's fence. */
export interface TransportResult {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly advertisedVersion: string | null;
  /**
   * T-222 step 10b (B6): the response body is UNUSABLE — `bodyText` is empty/partial and MUST NOT
   * be parsed. ONE flag, two causes: the body exceeded `MAX_RESPONSE_BYTES` and was not fully read,
   * OR its bytes are not valid UTF-8 (the reader decodes FATALLY — a malformed sequence fails the
   * body instead of becoming a U+FFFD replacement char, which would hand the raw door something
   * that is no longer the server's bytes and hide the corruption entirely). classify.ts admits
   * either before any parse (≥500 → retryable transient, else terminal). Absent/false on every
   * normal (fully-read, well-encoded) response, so existing callers and their fixtures are
   * unaffected.
   */
  readonly bodyTruncated?: boolean;
}

/**
 * One send of an immutable prepared request under a specific bearer token. The optional
 * third param (T-222 S3) bounds THAT call's watchdog only — per-request probe budgets
 * (`RequestSpec.budget.timeoutMs`) ride here; two-arg call sites keep the instance default.
 */
export type Transport = (
  request: PreparedRequest,
  token: string,
  opts?: { readonly timeoutMs?: number; readonly maxResponseBytes?: number },
) => Promise<TransportResult>;

/**
 * Assemble the outgoing headers: the caller's prepared headers (content-type,
 * preconditions, Idempotency-Key) PLUS the three CLI-owned headers. `Authorization`
 * is derived from `token` on EVERY send, so a refresh only changes this one header
 * while the prepared bytes stay identical (A37). `clientTag` is the instance's resolved
 * surface tag (T-227 R13a) — resolved ONCE in `createTransport`, so every send of one
 * transport carries one identity.
 */
function assembleHeaders(request: PreparedRequest, token: string, clientTag: string): Headers {
  const headers = new Headers(request.headers as Record<string, string>);
  headers.set("Authorization", `Bearer ${token}`);
  // The pin is the IMPORT — never a hardcoded "1.1.0" literal (a literal would defeat drift detection).
  headers.set(MANAGEMENT_VERSION_HEADER, MANAGEMENT_ROUTES_VERSION);
  headers.set(CLIENT_HEADER, clientTag);
  return headers;
}

export function createTransport(deps: TransportDeps): Transport {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  // T-227 R13a: the surface tag defaults to the historical CLI bytes — the default is the SAME
  // template that was previously inlined in assembleHeaders, so an omitting caller (every CLI
  // composition) sends byte-identical requests before and after the seam.
  const clientTag = deps.clientTag ?? `cli/${VERSION}`;
  return async (request, token, opts) => {
    // Per-call budget wins over the instance default (T-222 S3); both fall back to the pin.
    const timeoutMs = opts?.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // T-222 step 10b (B6): the response-size ceiling — a per-call override (raw-door boundary tests
    // pin a tiny cap) falls back to the pinned MAX_RESPONSE_BYTES for every real send.
    const maxResponseBytes = opts?.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    // Header assembly is HOISTED out of the try/catch (finding 4). A CR/LF or control byte in
    // the bearer token or a precondition value makes `new Headers()`/`.set()` throw a
    // deterministic TypeError. That is a BROKEN request, never a network failure — wrapping it
    // as a retryable TransportError would resend a request that can never succeed. Translate it
    // to a typed, NON-retryable RequestPreparationError (usage_error, exit 2) BEFORE any fetch.
    let headers: Headers;
    try {
      headers = assembleHeaders(request, token, clientTag);
    } catch {
      // STATIC message (T-222 10b-iii, secret-leak fix): the underlying platform error echoes the
      // OFFENDING header value VERBATIM — for `Authorization` that is `Bearer <the bearer token>` —
      // and `request.url` is operator-controlled (a mistyped secret can ride in a raw-door path
      // segment). Interpolating either would leak past the redaction chokepoint (a control byte in
      // the value severs the `mgmt_…` run the redactor keys on). Name only the class of fault.
      throw new RequestPreparationError(
        "cannot construct the request headers: a header value contains an illegal character",
        "a header value (the bearer token or an If-Match/If-None-Match precondition) contains an illegal character (CR, LF, or a control byte)",
      );
    }

    const controller = new AbortController();
    const watchdog = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await deps.fetch(request.url, {
        method: request.method,
        headers,
        body: request.bodyBytes ?? undefined,
        signal: controller.signal,
        // NEVER follow redirects (re-review R1): fetch's default `follow` would silently traverse
        // a redirect chain BEFORE classification — classify.ts's 3xx→terminal branch must see the
        // ORIGINAL status, and a followed redirect could change which origin's response (and thus
        // whose version header) we treat as authoritative.
        redirect: "manual",
      });
      // B6: read the body under a hard byte ceiling AND a strict UTF-8 decode instead of an
      // unbounded, permissive `.text()`. A response over the cap — or one whose bytes are not valid
      // UTF-8 — is flagged unusable (NEVER thrown from here — classify decides): the raw door
      // forwards operator paths and consumes arbitrary server bodies, so an oversized or runaway
      // response can never exhaust memory and a corrupt one is never silently repaired into
      // replacement chars. Neither breach aborts the watchdog controller (it cancels the body reader
      // instead) so neither can be misread as a timeout.
      const { bodyText, truncated } = await readBoundedBody(response, maxResponseBytes);
      return {
        status: response.status,
        headers: response.headers,
        bodyText,
        advertisedVersion: response.headers.get(MANAGEMENT_VERSION_HEADER),
        bodyTruncated: truncated,
      };
    } catch {
      // STATIC messages (T-222 10b-iii, secret-leak fix): `request.url` is operator-controlled and a
      // mistyped secret can ride in a raw-door path segment; a NON-`mgmt_` secret (another system's
      // key) would pass the redaction net verbatim. The underlying network `err.message` ("fetch
      // failed") carries no diagnostic path anyway. The typed `kind` still drives retry eligibility;
      // the numeric watchdog budget is safe to name. Our own watchdog firing → a timeout; anything
      // else while unaborted → a network error.
      if (controller.signal.aborted) {
        throw new TransportError("timeout", `the request timed out after ${timeoutMs}ms`);
      }
      throw new TransportError("network", "a network error occurred while contacting the server");
    } finally {
      timers.clearTimeout(watchdog);
    }
  };
}

/** Stop the transfer, best-effort. NEVER `controller.abort()` — a cancel must not read as a timeout. */
async function cancelQuietly(reader: { cancel: () => Promise<unknown> }): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    /* best-effort */
  }
}

/**
 * Decode `bytes` as UTF-8 STRICTLY, or null when they are not valid UTF-8. The decoder is fatal on
 * purpose: the permissive default silently substitutes U+FFFD for every malformed sequence, so the
 * caller would return a body that is NOT the server's bytes (the raw door prints bodies verbatim)
 * with the corruption undetectable after the fact. Returns null rather than throwing — the reader's
 * contract is a flag, never an exception.
 */
function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * T-222 step 10b (B6): read `response` into text under a hard `maxBytes` ceiling AND a strict UTF-8
 * decode. An oversized DECLARED `Content-Length` is rejected up front (cheap); the actual stream is
 * then bounded WHILE consuming, so a lying or absent length cannot bypass the cap. Over-cap OR
 * undecodable ⇒ `{ truncated: true }` with a partial/empty body the caller MUST NOT parse — this
 * NEVER throws (classify.ts, not transport, decides an unusable response's disposition). Cancels the
 * body reader on either breach (stops the transfer) WITHOUT aborting the timeout controller, so
 * neither is ever confused with a watchdog timeout. Mirrors the AS-metadata bounded reader
 * (core/auth/as-metadata.ts), differing only in returning a flag instead of throwing.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bodyText: string; readonly truncated: boolean }> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    // Declared over-cap: don't read a byte. Best-effort cancel to release the socket.
    try {
      await response.body?.cancel();
    } catch {
      /* best-effort */
    }
    return { bodyText: "", truncated: true };
  }
  const stream = response.body;
  if (!stream || typeof stream.getReader !== "function") {
    // No readable stream (e.g. a test stub Response): take the RAW BYTES and strict-decode them.
    // `.text()` is the last resort only (a stub exposing no `arrayBuffer`) — it decodes permissively,
    // and once it has returned, an already-decoded string carries no bytes left to validate.
    if (typeof response.arrayBuffer === "function") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) return { bodyText: "", truncated: true };
      const decoded = decodeUtf8Strict(bytes);
      if (decoded === null) return { bodyText: "", truncated: true };
      return { bodyText: decoded, truncated: false };
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) return { bodyText: "", truncated: true };
    return { bodyText: text, truncated: false };
  }
  const reader = stream.getReader();
  // Fatal for the same reason as decodeUtf8Strict. `{ stream: true }` is what keeps a multi-byte
  // character SPLIT across chunk boundaries legal — the partial sequence is buffered, not an error —
  // so only genuinely malformed bytes fail; the flush below is where an UNFINISHED trailing sequence
  // at EOF (a body cut mid-character) surfaces instead of decaying into U+FFFD.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (total + value.byteLength > maxBytes) {
          // Cancel the reader (NOT controller.abort()): stops the transfer without tripping the
          // watchdog's aborted-signal, so the catch below can never misclassify this as a timeout.
          await cancelQuietly(reader);
          return { bodyText: out, truncated: true };
        }
        total += value.byteLength;
        try {
          out += decoder.decode(value, { stream: true });
        } catch {
          // Malformed UTF-8. Same cancel discipline as the size breach, and the decoded PREFIX is
          // DROPPED: a body known to be corrupt must never be handed back as if it were the server's
          // verbatim bytes. Flagged, not thrown — classify.ts owns the disposition.
          await cancelQuietly(reader);
          return { bodyText: "", truncated: true };
        }
      }
    }
    try {
      out += decoder.decode();
    } catch {
      return { bodyText: "", truncated: true };
    }
    return { bodyText: out, truncated: false };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* best-effort: releasing an errored/cancelled reader must never mask the real failure */
    }
  }
}
