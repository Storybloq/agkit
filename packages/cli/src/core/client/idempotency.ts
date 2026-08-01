// Idempotency-Key application (T-211 step 3b, A27 / ticket D2). We auto-generate a
// UUIDv4 `Idempotency-Key` on EVERY mutating request (non-GET/HEAD) and send it as-is;
// a `--idempotency-key` override is honored on ANY route (never silently dropped —
// §B-9 honor-or-reject). The key is computed ONCE here, before the retry loop, and the
// resulting immutable request is what every resend reuses — so the key is byte-identical
// across attempts BY CONSTRUCTION (A37; a re-generated key would trip the server's
// idempotency fingerprint → 422 idempotency_key_conflict).
//
// ENFORCEMENT NOTE (not a client narrowing): the server mounts its replay-guard
// middleware on ONLY the 25 `idempotency:"required"` routes; on the other mutations the
// header is inert. Per ticket D2 the client still sends on all mutations — the honest
// resend protection for keyless mutations is the retry engine's A39 resend gate, not the
// header. The key generator is a DEDICATED seam (`uuid`), NEVER the jitter `random()`
// source used for backoff (A6) — key identity and backoff timing must not share entropy.
import type { PreparedRequest } from "./prepare";

/** The UUID generator seam. Defaults to the platform CSPRNG `crypto.randomUUID` (RFC 4122 v4). */
export type UuidFn = () => string;

const defaultUuid: UuidFn = () => crypto.randomUUID();

/** Is this a mutating verb (auto-gen a key)? GET/HEAD are safe reads and carry none. */
function isMutation(method: PreparedRequest["method"]): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * Return a NEW prepared request carrying the resolved `Idempotency-Key`:
 *   - an explicit `override` is used verbatim on ANY route;
 *   - otherwise a fresh UUIDv4 is generated for a mutation;
 *   - a GET/HEAD with no override carries no key.
 * The original request is never mutated.
 */
export function applyIdempotencyKey(
  request: PreparedRequest,
  override: string | undefined,
  uuid: UuidFn = defaultUuid,
): PreparedRequest {
  let key: string | undefined;
  if (override !== undefined) {
    key = override; // sent as-is on any route (validated non-empty/length at the flags layer)
  } else if (isMutation(request.method)) {
    key = uuid();
  }
  if (key === undefined) return request;
  return Object.freeze({
    ...request,
    headers: Object.freeze({ ...request.headers, "Idempotency-Key": key }),
  });
}
