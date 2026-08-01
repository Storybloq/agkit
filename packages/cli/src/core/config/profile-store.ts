// Profile operations over the config file + the OS keychain (T-208, deliverable 3).
// Profiles are CREATED by `login --profile` (T-213); this ticket owns the
// list/show/use/rename/delete surface on top of the config document (profile
// defaults + the active-profile pointer) and the keychain (the per-profile
// credential, keyed by profile name under service `agkit-cli`).
//
// Two invariants the ticket is emphatic about (FORBIDDEN otherwise):
//   - `delete` MUST remove the profile's keychain entry (and its plaintext record),
//     never leaving a credential behind.
//   - NEVER a cross-profile fallback: every keychain op names the EXACT profile.
// All I/O is injected (config dir via env+homeDir, the KeyringPort, cwd/flags for
// resolving the active profile), so the whole surface is deterministically testable.
import { mkdirSync } from "node:fs";
import {
  KEYCHAIN_SERVICE,
  KeyringUnavailableError,
  readInsecureRecord,
  removeInsecureRecord,
  copyInsecureRecord,
  type KeyringPort,
  type InsecureFileDeps,
} from "../auth";
import { withConfigFileLock, type FileLockDeps } from "../auth/file-lock";
import { ConfigError } from "./errors";
import { loadConfig, saveConfig } from "./config-file";
import { discoverRepoProject } from "./repo-project";
import { resolveContext, type ContextFlags } from "./context";
import { resolveConfigDir, type ConfigDirDeps } from "./dirs";
import type { ConfigData } from "./schema";

/** Everything the profile operations read/write (all injected). */
export interface ProfileStoreDeps extends ConfigDirDeps {
  readonly keyring: KeyringPort;
  readonly cwd: string;
  readonly flags: ContextFlags;
}

/** The InsecureFileDeps slice (its writes here are removal/move — un-gated by PL-14). */
function insecureDeps(deps: ProfileStoreDeps): InsecureFileDeps {
  return { homeDir: deps.homeDir, env: deps.env, isTTY: false };
}

/** Load config + resolve which profile is active (for the `active` marker + `show` default). */
function activeProfile(deps: ProfileStoreDeps, config: ConfigData): string {
  const repo = discoverRepoProject(deps.cwd)?.project ?? null;
  return resolveContext({ flags: deps.flags, env: deps.env, repo, config }).profile.value;
}

/** The union of every profile name we know about (config defaults + pointer + builtin). */
function knownProfileNames(config: ConfigData, active: string): string[] {
  const names = new Set<string>(["default", active]);
  for (const name of Object.keys(config.profiles ?? {})) names.add(name);
  if (config.default_profile) names.add(config.default_profile);
  return [...names].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

// --- credential presence probe (show) ----------------------------------------
export type CredentialPresenceSource = "keychain" | "insecure_file" | "none" | "unknown";
export interface CredentialPresence {
  readonly present: boolean;
  readonly source: CredentialPresenceSource;
}

/**
 * Probe whether `profile` has a stored credential, WITHOUT resolving/using it. The
 * insecure file occupies the keychain slot, so it is checked first. A missing
 * keychain BACKEND is reported as `unknown` (not `none`) — we cannot confirm absence.
 */
async function credentialPresence(deps: ProfileStoreDeps, profile: string): Promise<CredentialPresence> {
  if (readInsecureRecord(profile, insecureDeps(deps))) return { present: true, source: "insecure_file" };
  try {
    const raw = await deps.keyring.get(KEYCHAIN_SERVICE, profile);
    return raw ? { present: true, source: "keychain" } : { present: false, source: "none" };
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return { present: false, source: "unknown" };
    throw err;
  }
}

// --- list --------------------------------------------------------------------
export interface ProfileSummary {
  readonly name: string;
  readonly active: boolean;
  readonly project: string | null;
  readonly api_url: string | null;
}
export interface ProfileListResult {
  readonly active: string;
  readonly profiles: ProfileSummary[];
}

/** List known profiles with their config defaults + the active marker. (No keychain probe.) */
export function listProfiles(deps: ProfileStoreDeps): ProfileListResult {
  const { config } = loadConfig(deps);
  const active = activeProfile(deps, config);
  const profiles = knownProfileNames(config, active).map((name) => {
    const d = config.profiles?.[name];
    return { name, active: name === active, project: d?.project ?? null, api_url: d?.api_url ?? null };
  });
  return { active, profiles };
}

// --- show --------------------------------------------------------------------
export interface ProfileDetail {
  readonly name: string;
  readonly active: boolean;
  readonly project: string | null;
  readonly api_url: string | null;
  readonly credential_present: boolean;
  readonly credential_source: CredentialPresenceSource;
}

/** Show one profile's defaults + credential presence. `name` defaults to the active profile. */
export async function showProfile(deps: ProfileStoreDeps, name?: string): Promise<ProfileDetail> {
  const { config } = loadConfig(deps);
  const active = activeProfile(deps, config);
  const target = name && name.trim().length > 0 ? name.trim() : active;
  const d = config.profiles?.[target];
  const presence = await credentialPresence(deps, target);
  return {
    name: target,
    active: target === active,
    project: d?.project ?? null,
    api_url: d?.api_url ?? null,
    credential_present: presence.present,
    credential_source: presence.source,
  };
}

// --- use ---------------------------------------------------------------------
export interface ProfileUseResult {
  readonly profile: string;
  readonly config_path: string;
}

/**
 * Make `name` the active profile: set `default_profile` and ensure a (possibly
 * empty) `profiles[name]` entry exists so it is listable. A `--profile`/env override
 * still wins at resolution time; this sets the persistent default.
 */
export function useProfile(deps: ProfileStoreDeps, name: string): ProfileUseResult {
  const profile = requireName(name, "profile use <name>");
  const { config } = loadConfig(deps);
  const profiles = { ...(config.profiles ?? {}) };
  if (!profiles[profile]) profiles[profile] = {};
  const path = saveConfig(deps, { ...config, default_profile: profile, profiles });
  return { profile, config_path: path };
}

// --- ensure entry (login) ----------------------------------------------------
/**
 * Ensure a listable (possibly empty) `profiles[name]` config entry WITHOUT changing the active
 * pointer (T-213 B-4). `login --profile p` calls this so the profile becomes listable + reachable
 * by `logout --all-profiles`, while `default_profile` is left exactly as it was (a login must not
 * silently re-point the active profile). Idempotent: an existing entry is left untouched (no
 * config rewrite when nothing changes). Returns the config path when written, else null.
 *
 * X6: the load-modify-save is a CROSS-PROCESS RMW on config.json — two concurrent logins for
 * different profiles could otherwise each read the same document and atomically rename over each
 * other, dropping the earlier writer's entry (a stored keychain credential with no listable
 * profile is unreachable by `logout --all-profiles`). The whole RMW holds the SAME ISS-202 lock
 * protocol as the credentials file, under the CONFIG-scoped lock file (`withConfigFileLock`):
 * acquire → RE-READ → add-if-absent → save → release. `lockDeps` is test-injection only.
 */
export function ensureProfileEntry(
  deps: ProfileStoreDeps,
  name: string,
  lockDeps: FileLockDeps = {},
): string | null {
  const profile = requireName(name, "login --profile <name>");
  // The lock file lives beside config.json; ensure the dir exists (0700, same as saveConfig).
  const dir = resolveConfigDir(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withConfigFileLock(
    dir,
    () => {
      const { config } = loadConfig(deps); // re-read AFTER acquiring — the holder sees the latest bytes
      if (config.profiles && Object.hasOwn(config.profiles, profile)) return null; // already listable
      const profiles = { ...(config.profiles ?? {}) };
      profiles[profile] = {};
      return saveConfig(deps, { ...config, profiles });
    },
    lockDeps,
  );
}

// --- rename ------------------------------------------------------------------
export interface ProfileRenameResult {
  readonly from: string;
  readonly to: string;
  readonly credential_migrated: boolean;
  readonly config_path: string;
}

/** Move a key `from`->`to` in a config sub-record (profiles / confirmed_api_urls),
 * immutably. Unchanged when there is no `from` key. */
function renameKey<T>(rec: Record<string, T> | undefined, from: string, to: string): Record<string, T> | undefined {
  if (!rec || !Object.hasOwn(rec, from)) return rec;
  const next = { ...rec };
  next[to] = next[from]!;
  delete next[from];
  return next;
}

/**
 * Rename `oldName` -> `newName`: migrate the config defaults, the active pointer,
 * and the API-URL confirmation ledger, AND move the credential (keychain + any
 * plaintext record) so nothing is orphaned. Refuses if `newName` already exists —
 * including as a config-invisible CREDENTIAL — so a rename never clobbers a secret.
 *
 * Ordering is COPY -> save config -> DELETE-old so no single mid-op failure ever
 * strands `from`'s secret away from the config that names it: the copy is
 * non-destructive (source intact); if the config save fails we roll the copy back;
 * only after config is durable do we remove the old plaintext + keychain entries.
 */
export async function renameProfile(deps: ProfileStoreDeps, oldName: string, newName: string): Promise<ProfileRenameResult> {
  const from = requireName(oldName, "profile rename <old> <new>");
  const to = requireName(newName, "profile rename <old> <new>");
  if (from === to) throw new ConfigError(`cannot rename a profile to itself ('${from}')`);
  const { config } = loadConfig(deps);
  if (config.profiles?.[to] || config.default_profile === to) {
    throw new ConfigError(`a profile named '${to}' already exists`, { extra: { profile: to } });
  }
  // Refuse if `to` already holds a CREDENTIAL (keychain / plaintext) even without a
  // config entry (reachable once `login --profile` lands in T-213): migrating `from`'s
  // credential onto it would SILENTLY CLOBBER `to`'s credential. The config check above
  // only sees config-visible profiles; this closes the credential store.
  const targetCred = await credentialPresence(deps, to);
  if (targetCred.present) {
    throw new ConfigError(`a profile named '${to}' already has a stored credential`, {
      hint: `delete '${to}' first (agkit profile delete --name ${to}) or choose another target name`,
      extra: { profile: to, credential_source: targetCred.source },
    });
  }
  // If the keychain backend is UNAVAILABLE we cannot confirm `to` is credential-free
  // (a hidden keychain secret would be silently adopted by the renamed profile — an
  // identity mismatch), so refuse rather than move a credential we cannot verify.
  if (targetCred.source === "unknown") {
    throw new ConfigError(`cannot rename onto '${to}': the OS keychain is unavailable, so it cannot be confirmed credential-free`, {
      hint: "retry when the keychain is accessible (or use AGKIT_TOKEN)",
      extra: { profile: to },
    });
  }

  const nextConfig: ConfigData = {
    ...config,
    default_profile: config.default_profile === from ? to : config.default_profile,
    profiles: renameKey(config.profiles, from, to),
    confirmed_api_urls: renameKey(config.confirmed_api_urls, from, to),
  };

  // Move both credential stores NON-DESTRUCTIVELY first (source retained), THEN save
  // config, THEN remove the old source entries — so no single failure ever strands the
  // secret away from the config that names it:
  //   1) COPY keychain + COPY plaintext onto `to` (`from` still fully intact).
  //   2) Save config durably — on failure, roll BOTH copies back so `from` is restored.
  //   3) Config now names `to` (and `to` holds the credential); remove the OLD entries.
  // Residual (documented, best-effort — cross-store transactionality is not achievable
  // with three independent stores + a possibly-flapping keychain): if the config save
  // AND its rollback both fail, or a post-config OLD-entry removal fails, a duplicate
  // credential may linger under `to` (rollback) or `from` (cleanup). The USABLE secret
  // is never lost, and neither residual is reachable until `login --profile` (T-213).
  const copiedKeychain = await copyKeychain(deps, from, to);
  let copiedInsecure = false;
  try {
    copiedInsecure = copyInsecureRecord(from, to, insecureDeps(deps));
  } catch (err) {
    if (copiedKeychain) await bestEffortDeleteKeychain(deps, to); // undo the keychain copy
    throw err;
  }
  let path: string;
  try {
    path = saveConfig(deps, nextConfig);
  } catch (err) {
    if (copiedInsecure) bestEffortRemoveInsecure(deps, to); // undo the plaintext copy
    if (copiedKeychain) await bestEffortDeleteKeychain(deps, to); // undo the keychain copy
    throw err;
  }
  // Config is durable and names `to`; the credential is reachable under `to`. Removing
  // the OLD source entries is pure cleanup — a failure here must NOT fail the rename
  // (the `to` secret is safe), so both removals are best-effort.
  if (copiedKeychain) await bestEffortDeleteKeychain(deps, from);
  if (copiedInsecure) bestEffortRemoveInsecure(deps, from);

  return { from, to, credential_migrated: copiedKeychain || copiedInsecure, config_path: path };
}

/** COPY the keychain credential `from`->`to` (get -> set), leaving `from` intact.
 * Returns whether a secret was copied. The caller has just confirmed the backend is
 * reachable (credentialPresence), so a KeyringUnavailableError here (a rare mid-op
 * outage) propagates and aborts the rename BEFORE anything destructive happens. */
async function copyKeychain(deps: ProfileStoreDeps, from: string, to: string): Promise<boolean> {
  const secret = await deps.keyring.get(KEYCHAIN_SERVICE, from);
  if (!secret) return false;
  await deps.keyring.set(KEYCHAIN_SERVICE, to, secret);
  return true;
}

/** Remove a keychain entry, tolerating ANY failure — this is ONLY ever a cleanup /
 * rollback step (never a primary path), so a failure here must neither fail an
 * already-durable rename nor MASK the primary error it is rolling back. A leftover
 * entry is the documented best-effort residual (the usable secret is never lost). */
async function bestEffortDeleteKeychain(deps: ProfileStoreDeps, profile: string): Promise<void> {
  try {
    await deps.keyring.delete(KEYCHAIN_SERVICE, profile);
  } catch {
    /* best-effort: a dangling entry no config references is harmless (see renameProfile). */
  }
}

/** Remove a plaintext record, tolerating ANY failure (best-effort cleanup / rollback of
 * a rename copy). Unlike `delete`, a leftover OLD-profile record here is a stale
 * duplicate that no config entry references — never the usable secret — so a cleanup
 * failure must not fail the rename. */
function bestEffortRemoveInsecure(deps: ProfileStoreDeps, profile: string): void {
  try {
    removeInsecureRecord(profile, insecureDeps(deps));
  } catch {
    /* best-effort: the reachable `to` credential is unaffected (see renameProfile). */
  }
}

// --- delete ------------------------------------------------------------------
export interface ProfileDeleteResult {
  readonly profile: string;
  readonly keychain_removed: boolean;
  /**
   * Was the keychain BACKEND reachable? `false` means the delete could not be
   * ATTEMPTED (backend unavailable), so `keychain_removed:false` is ambiguous and a
   * credential may remain — distinct from `available:true, removed:false` ("nothing
   * was there"). Config/plaintext cleanup still runs (never leave config behind); the
   * caller surfaces this so a possible orphan is never reported as a clean delete.
   */
  readonly keychain_backend_available: boolean;
  readonly insecure_removed: boolean;
  readonly config_path: string;
}

/**
 * Delete `name`: remove its keychain entry (acceptance — asserted via the injected
 * keyring), its plaintext record, its config defaults + confirmation ledger, and
 * reset the active pointer if it pointed here. NEVER a cross-profile fallback — the
 * keychain delete names EXACTLY `name`.
 */
export async function deleteProfile(deps: ProfileStoreDeps, name: string): Promise<ProfileDeleteResult> {
  const profile = requireName(name, "profile delete <name>");
  const { config } = loadConfig(deps);

  // Keychain first — the explicit acceptance. `delete` returns bool; a missing backend
  // is caught so the rest of the cleanup still runs (never leave config behind), but we
  // record that the removal could not be ATTEMPTED so the caller does not report a
  // possible orphan as a clean delete (honor-or-reject: honest about the degraded path).
  let keychainRemoved = false;
  let keychainBackendAvailable = true;
  try {
    keychainRemoved = await deps.keyring.delete(KEYCHAIN_SERVICE, profile);
  } catch (err) {
    if (!(err instanceof KeyringUnavailableError)) throw err;
    keychainBackendAvailable = false;
  }
  const insecureRemoved = removeInsecureRecord(profile, insecureDeps(deps));

  const profiles = { ...(config.profiles ?? {}) };
  delete profiles[profile];
  const confirmed = { ...(config.confirmed_api_urls ?? {}) };
  delete confirmed[profile];
  const nextDefault = config.default_profile === profile ? undefined : config.default_profile;

  const path = saveConfig(deps, {
    ...config,
    default_profile: nextDefault,
    profiles,
    confirmed_api_urls: confirmed,
  });
  return {
    profile,
    keychain_removed: keychainRemoved,
    keychain_backend_available: keychainBackendAvailable,
    insecure_removed: insecureRemoved,
    config_path: path,
  };
}

/** Validate a required profile-name argument (non-empty), else a teachable usage_error. */
function requireName(raw: string | undefined, usage: string): string {
  const name = raw?.trim();
  if (!name) throw new ConfigError(`a profile name is required: ${usage}`);
  return name;
}
