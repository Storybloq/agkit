// Production wiring of the auth-command seam (T-213 S7, decision A + B). This is the ONE place
// the `login`/`logout` credential WRITE/DELETE + the API-URL guard + the OAuth-boundary network
// I/O are bound to real seams — everything below stays pure over injected deps, so the whole login
// lifecycle is driven end-to-end in tests by swapping the leaves.
//
// PROFILE BINDING: every credential store/read binds to the EFFECTIVE profile via the same
// `AGKIT_PROFILE` overlay the refresh executor uses (credDepsFor) — a `--profile prod` login must
// never write the DEFAULT profile's keychain slot.
//
// GUARD SHARING (decision A): `ensureApiUrl` is the SAME memoized `enforceApiUrlGuard` the typed
// client shares (passed in from run.ts), so a single invocation prompts AT MOST once across the
// client + the auth seam.
import { spawn } from "node:child_process";
import type { AuthCommandSeam, ApprovedApiContext, ProfileClearResult, CliRuntime } from "../commands/types";
import {
  storeCredential,
  readStoredCredentialRecord,
  removeInsecureRecord,
  listInsecureProfiles,
  KEYCHAIN_SERVICE,
  KeyringUnavailableError,
  type CredentialDeps,
  type CredentialRecord,
  type CredentialSource,
  type StoreOptions,
  type InsecureFileDeps,
  type LoginIoSeams,
} from "../core/auth";
import { postForm, OAUTH_REVOCATION_PATH, AGKIT_CLI_CLIENT_ID, type OauthHttpDeps } from "../core/auth/oauth-http";
import { ensureProfileEntry, listProfiles as listConfigProfiles, type ProfileStoreDeps } from "../core/config";
import type { GuardOutcome } from "../core/config";

/** Everything the auth seam needs, all injected. */
export interface AuthSeamDeps {
  readonly runtime: CliRuntime;
  /** The SHARED memoized API-URL guard (== the typed client's) — at most one prompt per invocation. */
  readonly ensureApiUrl: () => Promise<GuardOutcome>;
  /** The effective profile the store/read operations bind to (the shell's shared snapshot). */
  readonly effectiveProfile: () => string;
  /** Best-effort stderr sink (never receives a token). */
  readonly warn: (message: string) => void;
  /** The login-flow I/O seams (fetch / timers / entropy / browser / server / stderr). */
  readonly loginIo: LoginIoSeams;
  /**
   * T-221: drop the shell's per-invocation credential memo (createShellDeps' `cached`). Supplied
   * by run.ts, which OWNS that memo. REQUIRED (codex k07): an alternate shell that memoizes
   * credentials must make its choice VISIBLE — passing an explicit `() => {}` is a type-checked
   * statement that it holds no memo, never a silent default that reproduces the post-login
   * stale-credential 401.
   */
  readonly invalidateCredential: () => void;
}

/** Build the auth-command seam. Pure over `deps`; production wires the real leaves in run.ts. */
export function createAuthCommandSeam(deps: AuthSeamDeps): AuthCommandSeam {
  const { runtime } = deps;

  // EFFECTIVE-PROFILE credential deps — the AGKIT_PROFILE overlay binds every store/read to the
  // guard-resolved profile (the refresh executor's credDepsFor discipline).
  const credDepsFor = (profile: string): CredentialDeps => ({
    env: { ...runtime.env, AGKIT_PROFILE: profile },
    homeDir: runtime.homeDir,
    keyring: runtime.keyring,
    isTTY: runtime.isTTY,
    spawn: spawn as unknown as CredentialDeps["spawn"],
    warn: deps.warn,
  });

  const profileStoreDeps = (): ProfileStoreDeps => ({
    env: runtime.env,
    homeDir: runtime.homeDir,
    keyring: runtime.keyring,
    cwd: runtime.cwd,
    flags: runtime.flags,
  });

  // Insecure-file deps (removal / enumeration): profile is passed explicitly, so no AGKIT_PROFILE
  // overlay is needed; isTTY is irrelevant to reads/removals (only writes gate on PL-14).
  const insecureFileDeps = (): InsecureFileDeps => ({
    homeDir: runtime.homeDir,
    env: runtime.env,
    isTTY: runtime.isTTY,
  });

  const oauthDeps: OauthHttpDeps = { fetch: deps.loginIo.fetch, timers: deps.loginIo.timers };

  return {
    async ensureApiUrl(): Promise<ApprovedApiContext> {
      const outcome = await deps.ensureApiUrl();
      return { apiUrl: outcome.apiUrl, profile: outcome.profile };
    },
    effectiveProfile: () => deps.effectiveProfile(),
    store(record: CredentialRecord, opts: StoreOptions): Promise<CredentialSource> {
      return storeCredential(record, opts, credDepsFor(deps.effectiveProfile()));
    },
    readStoredRecord(profile: string): Promise<CredentialRecord | null> {
      return readStoredCredentialRecord(credDepsFor(profile));
    },
    ensureProfileEntry(profile: string): void {
      ensureProfileEntry(profileStoreDeps(), profile);
    },
    async revoke(origin: string, token: string): Promise<boolean> {
      // RFC 7009: always-200 on the wire; a network/timeout failure is swallowed to `false`
      // (best-effort — the caller warns and proceeds). The token rides the form body only.
      const params = new URLSearchParams({
        token,
        token_type_hint: "refresh_token",
        client_id: AGKIT_CLI_CLIENT_ID,
      });
      try {
        const res = await postForm(oauthDeps, new URL(origin).origin, OAUTH_REVOCATION_PATH, params);
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
    async clear(profile: string): Promise<ProfileClearResult> {
      // Keychain delete FIRST (the explicit deliverable) — names EXACTLY `profile`. A missing
      // backend is caught so plaintext removal still runs, but recorded so the caller never reports
      // a possible orphan as a clean clear (honor-or-reject about the degraded path).
      let keychainRemoved = false;
      let keychainBackendAvailable = true;
      try {
        keychainRemoved = await runtime.keyring.delete(KEYCHAIN_SERVICE, profile);
      } catch (err) {
        if (!(err instanceof KeyringUnavailableError)) throw err;
        keychainBackendAvailable = false;
      }
      const insecureRemoved = removeInsecureRecord(profile, insecureFileDeps());
      return {
        profile,
        keychain_removed: keychainRemoved,
        keychain_backend_available: keychainBackendAvailable,
        insecure_removed: insecureRemoved,
      };
    },
    listProfiles(): string[] {
      const names = new Set<string>();
      for (const p of listConfigProfiles(profileStoreDeps()).profiles) names.add(p.name);
      for (const p of listInsecureProfiles(insecureFileDeps())) names.add(p);
      names.add(deps.effectiveProfile());
      return [...names];
    },
    invalidateCredential(): void {
      deps.invalidateCredential();
    },
    loginIo: deps.loginIo,
  };
}
