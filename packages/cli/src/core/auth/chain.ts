// THE credential chain (T-206, deliverable 1 + 2). NORMATIVE precedence — pinned
// to N-011 §APX-E.4's keychain-FIRST order (owner-ratify note: E.4/MCP-6 pin
// keychain-first; the older AUTH-29/d2-R38 helper-first order is superseded, the
// ratification rides ADJ-6 / a DESIGN.md refresh — non-blocking):
//
//   AGKIT_TOKEN  >  OS keychain (or the insecure file when present — it OCCUPIES
//                    the keychain slot)  >  credential-helper  >  LOUD keychain_unavailable
//
// Two entry points:
//   resolveCredential — the READ path (what a command consumes).
//   storeCredential   — the WRITE path (a future `login`; exercised now by tests).
// Neither EVER silently downgrades to plaintext: a missing keychain with no
// sanctioned fallback throws the loud two-remedy KeychainUnavailableError.
import { KeychainUnavailableError } from "./errors";
import { KeyringUnavailableError } from "./keyring";
import { readEnvToken, readHelperCommand, resolveProfile } from "./env";
import { readInsecureRecord, writeInsecureRecord } from "./insecure-file";
import { runCredentialHelper } from "./helper";
import { parseStoredRecord, recordFromToken, type CredentialRecord } from "./record";
import { NO_CREDENTIAL, type CredentialDeps, type CredentialSource, type ResolvedCredential } from "./types";

/** Ratified keychain service name (N-011 §E.4). */
export const KEYCHAIN_SERVICE = "agkit-cli";

function service(deps: CredentialDeps): string {
  return deps.service ?? KEYCHAIN_SERVICE;
}

/**
 * Resolve the active credential (READ path). Precedence per E.4. Short-circuits on
 * `AGKIT_TOKEN` with NO keychain access at all (deliverable 2 — the CI path).
 *
 * Terminal decision: if the keychain BACKEND was unavailable and no lower-precedence
 * source produced a credential, throw the loud two-remedy KeychainUnavailableError.
 * Only when the keychain was HEALTHY-but-empty (and the helper also empty) do we
 * return `none` — an honest "not logged in", not a masked broken backend.
 */
export async function resolveCredential(deps: CredentialDeps): Promise<ResolvedCredential> {
  const profile = resolveProfile(deps.env);

  // 1. AGKIT_TOKEN — short-circuit the ENTIRE chain; the keychain is never touched.
  const envToken = readEnvToken(deps.env);
  if (envToken) return { source: "env", token: envToken, insecure: false };

  // 2. The insecure file OCCUPIES the keychain slot when present. 0600 verified on read.
  const insecure = readInsecureRecord(profile, { homeDir: deps.homeDir, env: deps.env, isTTY: deps.isTTY });
  if (insecure) return { source: "insecure_file", token: insecure.access_token, insecure: true };

  // 3. OS keychain. Remember an unavailable backend but keep going to the helper
  //    (E.4 order: keychain -> helper -> loud).
  let keychainUnavailable = false;
  try {
    const raw = await deps.keyring.get(service(deps), profile);
    if (raw) {
      const record = parseStoredRecord(raw);
      return { source: "keychain", token: record.access_token, insecure: false };
    }
    // Healthy backend, no entry -> fall through to the helper.
  } catch (err) {
    if (err instanceof KeyringUnavailableError) keychainUnavailable = true;
    else throw err;
  }

  // 4. credential-helper (lower precedence than the keychain).
  const helperCommand = readHelperCommand(deps.env);
  if (helperCommand) {
    const token = await runCredentialHelper(helperCommand, { spawn: deps.spawn, warn: deps.warn });
    if (token) return { source: "helper", token, insecure: false };
  }

  // 5. Terminal. A broken backend with no fallback is LOUD; an empty healthy
  //    backend is honestly `none`.
  if (keychainUnavailable) throw new KeychainUnavailableError();
  return NO_CREDENTIAL;
}

/**
 * The FULL stored record plus WHERE it came from (T-211 step 6 / A1). Additive sibling
 * of `resolveCredential`: the token-refresh executor needs the whole `CredentialRecord`
 * (refresh_token, grant_id, issuer/client_id, scopes, expiry), not just the bearer, so
 * it can present the refresh token and re-store the server's rotated pair. `source` is
 * never `none` — an absent credential is `null` (mirrors resolveCredential's `NO_CREDENTIAL`).
 */
export interface ResolvedRecord {
  /** WHERE the record came from (drives A14's source-aware refreshability + hints). */
  readonly source: Exclude<CredentialSource, "none">;
  /** The full record. `env`/`helper` sources carry a token-only synthetic record (no refresh path). */
  readonly record: CredentialRecord;
}

/**
 * Read the active credential as a FULL record (READ path, A1). Precedence is IDENTICAL
 * to `resolveCredential` (E.4: env > insecure-file/keychain > helper > loud) — this is a
 * sibling reader, NOT a replacement; existing `{source,token,insecure}` callers are
 * untouched. `env`/`helper` sources have NO refresh token (a bare bearer), so they surface
 * a `recordFromToken` synthetic record whose `refresh_token` is null; the executor reads
 * that as "no refresh path" and goes terminal with a source-aware hint. A broken keychain
 * backend with no fallback is LOUD (KeychainUnavailableError), never a masked `null`.
 */
export async function readCredentialRecord(deps: CredentialDeps): Promise<ResolvedRecord | null> {
  const profile = resolveProfile(deps.env);

  // 1. AGKIT_TOKEN — a bare bearer; no keychain touch, no refresh path (synthetic record).
  const envToken = readEnvToken(deps.env);
  if (envToken) return { source: "env", record: recordFromToken(envToken) };

  // 2. The insecure file OCCUPIES the keychain slot when present (full record, 0600-verified).
  const insecure = readInsecureRecord(profile, { homeDir: deps.homeDir, env: deps.env, isTTY: deps.isTTY });
  if (insecure) return { source: "insecure_file", record: insecure };

  // 3. OS keychain (full record). Remember an unavailable backend but keep going to the helper.
  let keychainUnavailable = false;
  try {
    const raw = await deps.keyring.get(service(deps), profile);
    if (raw) return { source: "keychain", record: parseStoredRecord(raw) };
  } catch (err) {
    if (err instanceof KeyringUnavailableError) keychainUnavailable = true;
    else throw err;
  }

  // 4. credential-helper — a bare bearer; no refresh path (synthetic record).
  const helperCommand = readHelperCommand(deps.env);
  if (helperCommand) {
    const token = await runCredentialHelper(helperCommand, { spawn: deps.spawn, warn: deps.warn });
    if (token) return { source: "helper", record: recordFromToken(token) };
  }

  // 5. Terminal — a broken backend with no fallback is LOUD; an empty healthy backend is `null`.
  if (keychainUnavailable) throw new KeychainUnavailableError();
  return null;
}

/**
 * The STORED record for the active profile (T-213, B-7b/B-7c) — the keychain / insecure-file
 * source ONLY, DELIBERATELY bypassing `AGKIT_TOKEN` and the credential-helper. `login` reads it to
 * revoke a prior grant; `logout` reads it to revoke a refresh token before deleting the record —
 * both need the record that is actually STORED, not whatever the read-precedence chain would
 * resolve (env/helper are bare bearers with no refresh path anyway). A broken keychain backend
 * with no stored file is treated as "nothing stored" (null) — logout is housekeeping, never an
 * auth probe. Returns null when no record is stored for the profile.
 */
export async function readStoredCredentialRecord(deps: CredentialDeps): Promise<CredentialRecord | null> {
  const profile = resolveProfile(deps.env);
  // The insecure file OCCUPIES the keychain slot when present (full record, 0600-verified).
  const insecure = readInsecureRecord(profile, { homeDir: deps.homeDir, env: deps.env, isTTY: deps.isTTY });
  if (insecure) return insecure;
  try {
    const raw = await deps.keyring.get(service(deps), profile);
    if (raw) return parseStoredRecord(raw);
  } catch (err) {
    // A broken backend is "nothing stored" here (housekeeping, not an auth probe) — never LOUD.
    if (err instanceof KeyringUnavailableError) return null;
    throw err;
  }
  return null;
}

/** Options for a credential WRITE. */
export interface StoreOptions {
  /** Explicit opt-in to the plaintext 0600 file instead of the keychain (deliverable 3). */
  readonly insecureStorage?: boolean;
}

/**
 * Persist `record` for the active profile (WRITE path — a future `login`). Returns
 * the source it landed in.
 *
 *   --insecure-storage  -> the 0600 file (PL-14 double-opt-in re-checked inside).
 *   otherwise           -> the OS keychain; if the backend is unavailable, throw
 *                          the loud two-remedy error (NEVER a silent plaintext write).
 */
export async function storeCredential(
  record: CredentialRecord,
  opts: StoreOptions,
  deps: CredentialDeps,
): Promise<CredentialSource> {
  const profile = resolveProfile(deps.env);

  if (opts.insecureStorage) {
    writeInsecureRecord(profile, record, { homeDir: deps.homeDir, env: deps.env, isTTY: deps.isTTY });
    return "insecure_file";
  }

  try {
    await deps.keyring.set(service(deps), profile, JSON.stringify(record));
    return "keychain";
  } catch (err) {
    if (err instanceof KeyringUnavailableError) throw new KeychainUnavailableError();
    throw err;
  }
}
