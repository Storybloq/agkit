// Production wiring of the typed management client (T-211 step 7). This is the ONE place
// the leaf seams (fetch / sleep / random / uuid / now / credential / guard) are bound to
// the real `createManagementClient` composition — everything below `core/client` stays
// pure over injected deps and is `process`-free, so the whole retry × refresh × paginate ×
// fence stack is exercised end-to-end in tests by swapping ONLY these leaves.
//
// LAZY (deliverable: a local command like `version` must touch NOTHING): the returned
// `ManagementClient` resolves the base URL, the credential, and the API-URL guard on the
// FIRST `request()` call, memoized per process. A command that never issues a request pays
// nothing — no keychain read, no guard, no network.
//
// Guard discipline (A14): a SINGLE memoized `enforceApiUrlGuard` is shared between the
// client (which needs the approved base URL before its first send) and the refresh executor
// (which re-confirms before presenting the refresh token). Memoization guarantees the
// interactive confirm fires AT MOST ONCE per invocation across both consumers.
import { spawn } from "node:child_process";
import type { CliRuntime, ManagementClient } from "../commands/types";
import type { ClientFlags } from "../core/client/flags";
import { parseFlagTokens } from "../commands/vocab";
import { createManagementClient, type ResponseMetaSink } from "../core/client";
import { createTransport } from "../core/client/transport";
import { createVersionFence } from "../core/client/handshake";
import { createRefreshExecutor } from "../core/client/refresh";
import type { UuidFn } from "../core/client/idempotency";
import {
  discoverRepoProject,
  enforceApiUrlGuard,
  loadConfig,
  resolveContext,
  stateDirPath,
  type ContextFlags,
  type GuardDeps,
  type GuardOutcome,
  type ResolvedContext,
} from "../core/config";
import {
  readCredentialRecord,
  storeCredential,
  type CredentialDeps,
  type CredentialRecord,
  type CredentialSource,
  type ResolvedCredential,
  type ResolvedRecord,
} from "../core/auth";

/** The leaf clock / entropy / network seams the typed client needs (production defaults, test-injectable). */
export interface ClientLeafSeams {
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly uuid: UuidFn;
  readonly now: () => number;
}

/** Everything the shell hands the client wiring. Leaf seams stay injectable; the rest is derived. */
export interface ShellClientDeps {
  /** Raw argv — the source of the `--profile` / `--project` context selectors the guard reads. */
  readonly argv: readonly string[];
  /** The validated global client-behavior flags (`--retries` / `--idempotency-key`). */
  readonly clientFlags: ClientFlags;
  /** The local-config/context runtime (env / homeDir / cwd / keyring / isTTY). */
  readonly runtime: CliRuntime;
  /**
   * Version-fence disposition (A11/A31): "throw" for every remote command (a major skew is
   * terminal); "report" ONLY for `status` — the instrument that MEASURES skew cannot be killed
   * by it, and a throw-mode fence would reject a 2xx compat-window discovery response before
   * status could read the advertised version out of its body.
   */
  readonly fenceMode: "throw" | "report";
  /**
   * The ONE memoized, EFFECTIVE-PROFILE-BOUND credential resolver (run.ts binds it over
   * `resolveEffectiveProfile`) — shared with command dispatch (`ctx.credential`, the capability
   * cache's credential fingerprint), so the token whoami reports, the token the cache
   * fingerprints, and the bearer this client sends are ONE resolution (A32).
   */
  readonly resolveCredential: () => Promise<ResolvedCredential>;
  /**
   * The MEMOIZED effective-profile snapshot (run.ts) — the SAME cell the credential resolver
   * read. The guard's `flags.profile` is PINNED to it (the flag layer wins the precedence, so
   * the guard's own config re-read cannot resolve a different profile even if the config file
   * changes mid-invocation), and the refresh record/lock seams bind from it. One snapshot,
   * every consumer — TOCTOU-free by construction.
   */
  readonly effectiveProfile: () => string;
  /** Interactive y/N confirm for the API-URL guard (only ever called on a TTY). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Best-effort stderr sink (guard warning + version-fence minor/unknown notice). MUST NOT throw. */
  readonly warn: (message: string) => void;
  /** Cell the failed-refresh SOURCE-AWARE hint (A14) is captured into; run.ts consults it on render. */
  readonly hintCell: { current: string | null };
  /**
   * The SHARED memoized API-URL guard (T-213 decision A). When present, the client uses THIS memo
   * instead of building its own — so the client, the refresh executor, AND the `login`/`logout`
   * auth seam all share ONE `enforceApiUrlGuard`, prompting at most once per invocation. run.ts
   * always supplies it; an omitting caller (existing tests) gets an internally-built memo (identical
   * behavior, just not shared with an auth seam that call never constructs).
   */
  readonly enforceApiUrl?: () => Promise<GuardOutcome>;
  /**
   * T-212 S8 (PL-15): cell the per-response `Idempotency-Replayed: true` fact is recorded into
   * (LAST write wins → the invocation's FINAL response). The dispatcher surfaces it as
   * `meta.replayed: true` on the success envelope. Optional — absent means no surfacing.
   */
  readonly replayCell?: { current: boolean };
  /** The leaf seams (production defaults live in run.ts). */
  readonly seams: ClientLeafSeams;
  /** Full-record read seam for the refresh executor (A1). Defaults to `readCredentialRecord` over the runtime. */
  readonly readRecord?: () => Promise<ResolvedRecord | null>;
  /** Rotated-record store seam for the refresh executor (A1). Defaults to `storeCredential` over the runtime. */
  readonly storeRecord?: (record: CredentialRecord, source: CredentialSource) => Promise<void>;
  /** State dir for the refresh lock/marker (A40-A43). Defaults to `stateDirPath` over the runtime. */
  readonly stateDir?: string;
  /**
   * T-227 R13a: the `X-AgentKit-Client` surface tag, threaded verbatim to the transport. Absent —
   * every CLI composition — the transport's own `cli/<VERSION>` default holds, byte-identical to
   * what the CLI has always sent. The MCP session supplies `mcp-local/<VERSION>` so the server's
   * PLAN_APPLIED audit rows can name the surface that issued a mutation.
   */
  readonly clientTag?: string;
}

/**
 * Compose the replay recorder with the version fence on the ONE `onResponseMeta` channel
 * (T-212 S8). The cell write happens FIRST — the fence may THROW (its throw-mode skew path
 * propagates through this sink by design), and the replay fact of the response that WAS
 * classified must survive it. A pure cell write cannot itself throw.
 */
function composeResponseMeta(
  replayCell: { current: boolean } | undefined,
  fence: ResponseMetaSink,
): ResponseMetaSink {
  if (replayCell === undefined) return fence;
  return async (meta) => {
    replayCell.current = meta.replayed;
    await fence(meta);
  };
}

/** The `--profile` / `--project` context selectors from raw argv (mirrors build-cli.extractContextFlags). */
function contextFlagsFromArgv(argv: readonly string[]): ContextFlags {
  const flags = parseFlagTokens([...argv]);
  const out: { profile?: string; project?: string } = {};
  const profile = flags["profile"];
  if (typeof profile === "string" && profile.length > 0) out.profile = profile;
  const project = flags["project"];
  if (typeof project === "string" && project.length > 0) out.project = project;
  return out;
}

/**
 * The EFFECTIVE profile — the full flag > env > repo > config precedence (T-208). This is the
 * SAME pure resolution the URL guard runs over the same inputs (same argv-derived flags, same
 * runtime env/homeDir/cwd, same loadConfig/discoverRepoProject), so the two computations cannot
 * diverge. It exists separately because `ctx.credential` (whoami's local report, the capability
 * cache's credential fingerprint) must bind to the effective profile WITHOUT invoking the guard —
 * the guard may PROMPT to confirm a non-default api_url, and a local credential read sends
 * nothing anywhere. One credential identity, guard-free.
 */
export function resolveEffectiveContext(runtime: CliRuntime, argv: readonly string[]): ResolvedContext {
  const { config } = loadConfig({ env: runtime.env, homeDir: runtime.homeDir });
  const repo = discoverRepoProject(runtime.cwd)?.project ?? null;
  return resolveContext({ flags: contextFlagsFromArgv(argv), env: runtime.env, repo, config });
}

/**
 * The EFFECTIVE profile — thin over `resolveEffectiveContext` (F0), so the profile the
 * credential chain binds to and the project `ctx.project` carries come from ONE `resolveContext`
 * read over identical inputs and can never diverge. (Historically its own function; now a
 * projection of the full context so profile + project share a single snapshot.)
 */
export function resolveEffectiveProfile(runtime: CliRuntime, argv: readonly string[]): string {
  return resolveEffectiveContext(runtime, argv).profile.value;
}

/**
 * Build the production lazy `ManagementClient`. The credential + guard + base URL resolve on
 * the FIRST `request()` (memoized), so a local command never triggers them. The version fence
 * mode comes from the dispatching command (A11/A31): "throw" for every remote command, "report"
 * only for `status` — the skew instrument reads the advertised version out of the response
 * rather than dying on it.
 */
/**
 * Build a MEMOIZED API-URL guard over the shell seams (T-213 decision A). Exported so run.ts can
 * construct ONE memo and share it across the typed client, the refresh executor, AND the auth
 * seam — `enforceApiUrlGuard` may prompt, and memoizing the promise makes it fire at most once per
 * invocation. The profile is PINNED to the shared snapshot (the flag layer wins the guard's own
 * resolveContext), so a concurrent config change can never split ITS profile from the credential
 * chain's.
 */
export function createApiUrlGuardMemo(deps: {
  readonly runtime: CliRuntime;
  readonly argv: readonly string[];
  readonly effectiveProfile: () => string;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly warn: (message: string) => void;
}): () => Promise<GuardOutcome> {
  const { runtime } = deps;
  const contextFlags = contextFlagsFromArgv(deps.argv);
  let guardPromise: Promise<GuardOutcome> | null = null;
  return (): Promise<GuardOutcome> => {
    const guardDeps: GuardDeps = {
      env: runtime.env,
      homeDir: runtime.homeDir,
      cwd: runtime.cwd,
      flags: { ...contextFlags, profile: deps.effectiveProfile() },
      isTTY: runtime.isTTY,
      warn: deps.warn,
      confirm: deps.confirm,
    };
    return (guardPromise ??= enforceApiUrlGuard(guardDeps));
  };
}

export function createShellManagementClient(deps: ShellClientDeps): ManagementClient {
  const { runtime, seams } = deps;

  // The SINGLE memoized guard — shared with the refresh executor (and, when run.ts supplies it,
  // the auth seam). `enforceApiUrlGuard` may prompt; memoizing makes it fire at most once.
  const enforceGuardMemo =
    deps.enforceApiUrl ??
    createApiUrlGuardMemo({
      runtime,
      argv: deps.argv,
      effectiveProfile: deps.effectiveProfile,
      confirm: deps.confirm,
      warn: deps.warn,
    });

  // EFFECTIVE-PROFILE credential deps (codex step-7 round): every credential read/store — the
  // client's bearer AND the refresh executor's record read + rotated re-store — binds to the
  // GUARD-RESOLVED profile (the full flag > env > repo > config precedence), overlaid onto the
  // `AGKIT_PROFILE` env the chain reads. Unbound, `--profile prod` would present the DEFAULT
  // profile's token to the prod profile's server (a cross-profile credential leak), and the
  // refresh lock — keyed on the guard profile (A43) — would not serialize with the record it
  // actually mutates. `spawn` feeds only the credential-helper source, which has no refresh
  // path anyway (A14).
  const credDepsFor = (profile: string): CredentialDeps => ({
    env: { ...runtime.env, AGKIT_PROFILE: profile },
    homeDir: runtime.homeDir,
    keyring: runtime.keyring,
    isTTY: runtime.isTTY,
    spawn: spawn as unknown as CredentialDeps["spawn"],
    warn: deps.warn,
  });

  // Lazy construction: resolve the guard-approved base URL + the profile-bound credential ONCE,
  // memoized. The refresh executor is built HERE too, so its record read/store seams close over
  // the same guard-resolved profile as the bearer. The client's own `enforceGuard` seam
  // re-invokes the memoized guard before its first send (a no-op after this build) so the
  // "guard before send" invariant holds without a second prompt.
  let clientPromise: Promise<ManagementClient> | null = null;
  const build = async (): Promise<ManagementClient> => {
    const approved = await enforceGuardMemo();
    // Bound from the SNAPSHOT (== approved.profile — the guard's profile is pinned to the same
    // cell), so record read, rotated store, and the lock key share one profile identity.
    const profileDeps = credDepsFor(deps.effectiveProfile());
    // The SHARED effective-profile resolver — the same instance command dispatch consumes, so
    // ctx.credential and this bearer are one resolution. (approved.profile equals the resolver's
    // bound profile: both come from the identical pure resolveContext over identical inputs.)
    const credential = await deps.resolveCredential();
    const readRecord = deps.readRecord ?? (() => readCredentialRecord(profileDeps));
    const storeRecord =
      deps.storeRecord ??
      (async (record: CredentialRecord, source: CredentialSource) => {
        // Re-store to the SAME source the record came from (A1). Only keychain / insecure_file
        // sources reach here — env/helper bearers have no refresh path (the executor skips them).
        await storeCredential(record, { insecureStorage: source === "insecure_file" }, profileDeps);
      });
    const stateDir = deps.stateDir ?? stateDirPath({ env: runtime.env, homeDir: runtime.homeDir });

    const refreshAuth = createRefreshExecutor({
      fetch: seams.fetch,
      now: seams.now,
      sleep: seams.sleep,
      readRecord,
      storeRecord,
      // The refresh executor shares the ONE memoized guard (A14) and adapts its outcome to the
      // ApprovedContext it needs (profile + apiUrl) — no second guard pass, no second prompt.
      enforceGuard: async () => {
        const outcome = await enforceGuardMemo();
        return { profile: outcome.profile, apiUrl: outcome.apiUrl };
      },
      stateDir,
      reportHint: (hint) => {
        deps.hintCell.current = hint;
      },
    });

    return createManagementClient({
      baseUrl: approved.apiUrl,
      token: credential.token ?? "",
      // T-227 R13a: the surface tag rides to the transport verbatim; `undefined` (every CLI
      // composition) falls through to the transport's own `cli/<VERSION>` default.
      transport: createTransport({ fetch: seams.fetch, clientTag: deps.clientTag }),
      enforceGuard: async () => {
        await enforceGuardMemo();
      },
      sleep: seams.sleep,
      // `Math.random` is injected HERE, at the shell edge — never inside core/client (A6/risk #3).
      random: seams.random,
      uuid: seams.uuid,
      refreshAuth,
      retries: deps.clientFlags.retries,
      idempotencyKeyOverride: deps.clientFlags.idempotencyKey,
      // The version fence rides `onResponseMeta` — "throw" for every remote command, "report"
      // only for `status` (A11/A31; run.ts selects by command path). The capability-advertisement
      // cache is written on the SEPARATE pre-flight `discovery.get` path (build-cli.
      // capabilityGateDeps → writeCapabilityCache), not here — a generic response carries no
      // capability advertisement. T-212 S8: the replay cell records BEFORE the fence (a fence
      // throw must not lose the replay fact of the response that was classified).
      onResponseMeta: composeResponseMeta(
        deps.replayCell,
        createVersionFence({ mode: deps.fenceMode, warn: deps.warn }),
      ),
    });
  };

  return {
    request(op) {
      clientPromise ??= build();
      return clientPromise.then((client) => client.request(op));
    },
    // T-222 step 10b: the raw door rides the SAME lazily-built, memoized client (one guard/credential
    // resolution shared with `request`); the version fence rides automatically (every send passes
    // `onResponseMeta`). `client.raw!` is always present on the production composition.
    raw(spec) {
      clientPromise ??= build();
      return clientPromise.then((client) => client.raw!(spec));
    },
  };
}
