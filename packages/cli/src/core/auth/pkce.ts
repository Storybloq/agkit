// PKCE (RFC 7636, S256-only) + the CSRF `state` nonce for the auth-code loopback flow
// (T-213 S2). A `code_verifier`/`state` is a SECRET the whole login exchange rests on, so its
// ONLY source is the injected CSPRNG seam (`RandomBytes`, default `node:crypto.randomBytes`) —
// `Math.random` and the client's jitter `random()` seam are FORBIDDEN here and the entropy
// guard-grep (pkce.test.ts) reddens if any core/auth source reaches for them. S256 is the ONLY
// challenge method the server accepts (AS metadata `code_challenge_methods_supported == ["S256"]`);
// there is deliberately no `plain` path.
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

/** Injectable CSPRNG seam: return `n` cryptographically-random bytes. */
export type RandomBytes = (n: number) => Uint8Array;

/** Production entropy source — node's CSPRNG (a `randomBytes`, NOT the swept `randomUUID`). */
export const defaultRandomBytes: RandomBytes = (n) => nodeRandomBytes(n);

/**
 * 32 random bytes → a 43-char base64url verifier (RFC 7636 §4.1 recommends 43–128 chars;
 * 32 bytes is the standard 256-bit choice, base64url-encoded to exactly 43 unreserved chars).
 */
export const PKCE_VERIFIER_BYTES = 32;
/** 16 random bytes for the `state` CSRF nonce (128 bits — unguessable, single-use per login). */
export const PKCE_STATE_BYTES = 16;

/** base64url(bytes): standard base64 with `+`→`-`, `/`→`_`, and padding stripped (RFC 4648 §5). */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE code-verifier / code-challenge pair (S256). The verifier stays local; the challenge goes on the wire. */
export interface PkcePair {
  /** The secret `code_verifier` — presented at the token exchange, NEVER sent on the authorize request. */
  readonly verifier: string;
  /** The public `code_challenge` = base64url(SHA-256(verifier)) — sent on the authorize request. */
  readonly challenge: string;
  /** Always `"S256"` — the only method the server accepts. */
  readonly method: "S256";
}

/** Compute the S256 `code_challenge` for a `code_verifier` (RFC 7636 §4.2). */
export function computeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/**
 * Draw EXACTLY `n` bytes from the entropy seam, or refuse (P6). A short-changing source (a broken
 * injected seam, a hostile shim) would silently mint a weak/empty verifier or state — the whole
 * login's security rests on these bytes, so a wrong count is a hard error BEFORE any encoding.
 * The message is FIXED and non-secret.
 */
function drawBytes(randomBytes: RandomBytes, n: number): Uint8Array {
  const bytes = randomBytes(n);
  if (bytes.length !== n) {
    throw new Error("entropy source returned the wrong number of bytes — refusing to mint a login secret");
  }
  return bytes;
}

/** Mint a fresh PKCE pair from the CSPRNG seam. The verifier is a secret; the challenge is public. */
export function createPkcePair(randomBytes: RandomBytes = defaultRandomBytes): PkcePair {
  const verifier = base64url(drawBytes(randomBytes, PKCE_VERIFIER_BYTES));
  return { verifier, challenge: computeChallenge(verifier), method: "S256" };
}

/** Mint a fresh `state` CSRF nonce from the CSPRNG seam (strict-equality checked on the callback). */
export function createState(randomBytes: RandomBytes = defaultRandomBytes): string {
  return base64url(drawBytes(randomBytes, PKCE_STATE_BYTES));
}
