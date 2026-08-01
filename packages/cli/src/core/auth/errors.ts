// Credential-chain error taxonomy (T-206, canonical L2-CLI-05; A5 loud failure,
// §B-9 never silently downgrade). THREE CLI-local codes live here — they are
// PLACEHOLDER strings routed through the T-205 serializer as error envelopes
// exactly like T-205's `unknown_field`; the teachable-error renderer + the real
// global taxonomy are L2-CLI-04 / T-207. Do NOT mint a global taxonomy here.
//
//   keychain_unavailable      — no secret-service backend AND no fallback (exit 2)
//   insecure_storage_refused  — PL-14 CI double-opt-in not satisfied     (exit 2)
//   insecure_file_permissions — the 0600 file widened / not a regular file (exit 2)
//
// The whole point of this module is that a MISSING keychain is LOUD, never a
// silent plaintext fallback (gh's scars: cli/cli #8954/#10108/#13317).

/** The two remedies the loud `keychain_unavailable` failure MUST name (deliverable 3). */
export const KEYCHAIN_UNAVAILABLE_REMEDIES: readonly string[] = [
  "set AGKIT_TOKEN=<management token> — the CI / non-interactive path; no keychain is touched",
  "opt in explicitly with --insecure-storage to write a 0600 ~/.agentkit/credentials.json (under CI / non-interactive you must ALSO set AGKIT_ALLOW_INSECURE_STORAGE=1)",
];

/** The canonical two-remedy message. Names remedy (a) AGKIT_TOKEN + (b) --insecure-storage. */
export const KEYCHAIN_UNAVAILABLE_MESSAGE =
  "OS keychain is unavailable (no secret-service backend). agkit will NOT silently fall back to " +
  "plaintext storage. Choose a remedy: (1) set AGKIT_TOKEN=<management token> — the CI / " +
  "non-interactive path, no keychain is touched; or (2) opt in explicitly with --insecure-storage " +
  "to write a 0600 ~/.agentkit/credentials.json (under CI / non-interactive you must ALSO set " +
  "AGKIT_ALLOW_INSECURE_STORAGE=1).";

/**
 * The keychain is unavailable AND no sanctioned fallback (AGKIT_TOKEN /
 * credential-helper / explicit --insecure-storage) was available. LOUD, exit 2.
 * Carries the two remedies as a teachable extra.
 */
export class KeychainUnavailableError extends Error {
  override name = "KeychainUnavailableError";
  readonly code = "keychain_unavailable" as const;
  readonly remedies: readonly string[];
  constructor(message: string = KEYCHAIN_UNAVAILABLE_MESSAGE, remedies: readonly string[] = KEYCHAIN_UNAVAILABLE_REMEDIES) {
    super(message);
    this.remedies = remedies;
  }
}

/**
 * PL-14: an insecure WRITE was attempted under CI / non-interactive WITHOUT the
 * second opt-in (`AGKIT_ALLOW_INSECURE_STORAGE=1`). Refused, exit 2. Re-checked on
 * EVERY write (the gate is writes-only).
 */
export class InsecureStorageRefusedError extends Error {
  override name = "InsecureStorageRefusedError";
  readonly code = "insecure_storage_refused" as const;
}

/**
 * The insecure credentials file is not exactly a 0600 regular file (widened mode,
 * a symlink, or a non-regular target). Rejected teachably on EVERY read, exit 2 —
 * never trusted. The message names the file + the offending mode; it never
 * contains file CONTENTS (no token leak).
 */
export class InsecureFilePermissionsError extends Error {
  override name = "InsecureFilePermissionsError";
  readonly code = "insecure_file_permissions" as const;
  readonly path: string;
  readonly mode: string;
  constructor(message: string, filePath: string, mode: string) {
    super(message);
    this.path = filePath;
    this.mode = mode;
  }
}

/**
 * Stored credential data (keychain payload or insecure-file JSON) failed runtime
 * validation (bad JSON, wrong schema version, missing/oversized fields). The
 * message is a STATIC, non-secret string — it never echoes the corrupt bytes,
 * which could contain a token. Routed through the generic error path (no code of
 * its own — the three CLI-local codes above are the ratified set for T-206).
 */
export class MalformedCredentialError extends Error {
  override name = "MalformedCredentialError";
}
