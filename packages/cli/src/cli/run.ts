// Shell bootstrap — what the `agkit` bin (src/cli.ts) hands off to after the
// Node-version gate. It assembles the Ctx (including the resolved output config,
// T-205), builds the registry-driven yargs shell (build-cli.ts), and parses.
//
// ALL output — success AND error — flows through the serializer chokepoint
// (src/core/output). yargs' own failure handling is disabled (`.fail(false)`) so
// every error is caught here and rendered as the single error document, honoring
// stream discipline and running through the SAME upstream redaction pass as
// success output.
//
// The ManagementClient is the REAL typed client (T-211 step 7), wired LAZILY: its
// leaf seams (fetch/sleep/random/uuid/now + the credential + the API-URL guard) are
// bound in `wire-client.ts` and resolved only on the FIRST `request()` — so a local
// command like `version` triggers no keychain access, no guard, and no network.
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
// The production fs leaf seams (extracted for the max-lines cap — see ./fs-seams).
import {
  createListDir,
  createReadTextFile,
  createReadTextFileFollowing,
  createWriteTextFile,
  createWriteTextFileFollowing,
  ensureRootForApply,
  verifyFollowedWrite,
} from "./fs-seams";
import type { CliRuntime, Ctx, ServiceCommandSeam } from "../commands/types";
import { NO_PROJECT } from "../commands/types";
import { realInstallFs } from "../core/housekeeping/node-fs";
import { spawnProbeChild, spawnRunChild, type ChildExecDeps, type ChildLike } from "../core/service/child-exec";
import { buildCli, type ShellDeps } from "./build-cli";
import { leadingFlagSwallowedCommand } from "./flag-ownership";
import { TOP_LEVEL_COMMAND_TOKENS } from "../commands/registry";
import {
  createShellManagementClient,
  createApiUrlGuardMemo,
  resolveEffectiveContext,
  resolveEffectiveProfile,
  type ClientLeafSeams,
} from "./wire-client";
import { createAuthCommandSeam } from "./wire-auth";
import { defaultRandomBytes, type RandomBytes } from "../core/auth/pkce";
import { openUrl as defaultOpenUrl } from "../core/auth/open-url";
import type { CreateLoopbackServer } from "../core/auth/loopback";
import type { LoginIoSeams } from "../core/auth";
import type { ResolvedContext } from "../core/config";
import { ensureChildNpmrc } from "./child-npmrc";
import { emitError, resolveOutputConfig, fallbackOutputConfig } from "../core/output";
import { displaySafe } from "../core/output/display";
import { classifyThrownError, commandPathFromArgv, CliLocalError } from "../core/errors";
import { parseClientFlags } from "../core/client/flags";
import { MAX_REQUEST_BYTES } from "../core/client/limits";
import {
  napiKeyringPort,
  resolveCredential,
  NO_CREDENTIAL,
  type CredentialDeps,
  type CredentialRecord,
  type CredentialSource,
  type ResolvedCredential,
  type ResolvedRecord,
} from "../core/auth";
import {
  buildHousekeepingDeps,
  emitUpdateBanner,
  isHousekeepingExempt,
  preCommandHousekeeping,
  skillSourceDir,
  type HousekeepingDeps,
} from "../core/housekeeping";

/**
 * Leaf seams + credential/context overrides the shell accepts for testing. Every field is
 * OPTIONAL and defaulted to the production value, so the production entry (`run(argv)`) wires
 * the real fetch/clock/entropy + the real credential resolver, while an integration test drives
 * the WHOLE stack through `run(argv)` by injecting only fetch/sleep/random/uuid + a hermetic
 * runtime. NOTHING here changes production behavior — it only names the seams tests may swap.
 */
export interface RunOverrides {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly uuid?: () => string;
  readonly now?: () => number;
  readonly resolveCredential?: () => Promise<ResolvedCredential>;
  readonly readRecord?: () => Promise<ResolvedRecord | null>;
  readonly storeRecord?: (record: CredentialRecord, source: CredentialSource) => Promise<void>;
  readonly runtime?: CliRuntime;
  readonly confirm?: (question: string) => Promise<boolean>;
  /** T-212: the typed-line reader for a D/PR confirm-string prompt (non-TTY → null). */
  readonly promptLine?: (question: string) => Promise<string | null>;
  readonly promptSecret?: (question: string) => Promise<string | null>;
  /** B0 (sub-wave B): a hermetic bounded file reader; production uses `createReadTextFile`. */
  readonly readTextFile?: (path: string, opts: { maxBytes: number }) => Promise<string>;
  /** T-221: a hermetic atomic writer; production uses `createWriteTextFile`. */
  readonly writeTextFile?: (path: string, text: string, opts?: { withinRoot?: string }) => void;
  /** T-221: a hermetic directory lister; production uses `createListDir`. */
  readonly listDir?: (path: string) => string[];
  // T-224 (`setup`): the symlink-FOLLOWING leaf seams. Production uses the `fs-seams.ts` bodies;
  // a test injects hermetic fakes exactly as it does for the T-221 pair above.
  readonly readTextFileFollowing?: ShellDeps["readTextFileFollowing"];
  readonly writeTextFileFollowing?: ShellDeps["writeTextFileFollowing"];
  readonly verifyFollowedWrite?: ShellDeps["verifyFollowedWrite"];
  readonly ensureRootForApply?: ShellDeps["ensureRootForApply"];
  /**
   * T-224: the shipped `skill/` source dir. Production anchors it to the emitted bundle
   * (`buildHousekeepingDeps`'s rule, single-sourced as `skillSourceDir()`); a test points it at a
   * fixture tree so `agkit setup`'s install leg runs against real files with no real HOME.
   */
  readonly skillSourceDir?: string;
  readonly warn?: (message: string) => void;
  readonly stateDir?: string;
  // T-213 login-flow leaf seams (the auth seam's OAuth-boundary I/O). Every one defaults to the
  // production value; a test injects a hermetic fetch/CSPRNG/browser-opener/loopback-server.
  readonly randomBytes?: RandomBytes;
  readonly openUrl?: (url: string) => void;
  readonly createServer?: CreateLoopbackServer;
  readonly platform?: NodeJS.Platform;
  /** Injected watchdog timers for the OAuth/loopback flows (X8). Default: the ambient globals. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

/** A real, bounded sleep (RULES: every wait is bounded — the caller's `--retries` caps the count). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the leaf clock / entropy / network seams — production defaults, overridable for tests. */
function resolveClientSeams(overrides: RunOverrides): ClientLeafSeams {
  return {
    fetch: overrides.fetch ?? globalThis.fetch,
    sleep: overrides.sleep ?? realSleep,
    random: overrides.random ?? Math.random,
    uuid: overrides.uuid ?? (() => randomUUID()),
    now: overrides.now ?? (() => Date.now()),
  };
}

/**
 * Minimal runtime context. The credential is `NO_CREDENTIAL` here — the shell resolves the REAL
 * one lazily, only for a command that consumes it (build-cli). The typed client is wired here but
 * LAZY: it resolves the base URL / credential / guard only on its first `request()` (wire-client),
 * so a local command like `version` never triggers keychain access, the guard, or the network.
 * `hintCell` is the channel a failed refresh's source-aware hint (A14) reaches the error renderer.
 */
export function createRunContext(
  argv: string[],
  shellDeps: ShellDeps,
  hintCell: { current: string | null },
  overrides: RunOverrides = {},
): Ctx {
  const runtime = shellDeps.runtime ?? defaultRuntime();
  const output = resolveOutputConfig({
    argv,
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  });
  // T-211: validate the global client-behavior flags (--retries / --idempotency-key)
  // from raw argv. A malformed value throws ConfigError (usage_error, exit 2) HERE —
  // before any command runs — and run.ts's createRunContext catch renders it teachably.
  const clientFlags = parseClientFlags(argv);
  const fenceMode = fenceModeFor(commandPathFromArgv(argv)[0]);
  // X7/F0: the FALLBACK effective-profile resolver (hand-built deps without the createShellDeps
  // snapshot) is pinned to ONE resolution per context — a per-call re-resolve could straddle a
  // concurrent config change and let the guard approve one profile while login stores under
  // another. Memoized-lazy (not eager) so a local command still reads no config; after the first
  // read every consumer sees the SAME captured value. Production always supplies the
  // createShellDeps snapshot, which carries this discipline already.
  let fallbackProfile: string | null = null;
  const effectiveProfile =
    shellDeps.effectiveProfile ?? (() => (fallbackProfile ??= resolveEffectiveProfile(runtime, argv)));
  const warn = shellDeps.warn;
  const confirm = shellDeps.confirm ?? createConfirm;
  // T-213 decision A: ONE memoized API-URL guard shared by the typed client, the refresh executor,
  // AND the login/logout auth seam — so a single invocation prompts AT MOST once across them.
  const enforceApiUrl = createApiUrlGuardMemo({ runtime, argv, effectiveProfile, confirm, warn });
  // T-212 S8 (PL-15): the replay cell — the wire client records each classified response's
  // Idempotency-Replayed fact into it (last write wins); the dispatcher surfaces the FINAL
  // response's replay as `meta.replayed: true` on the success envelope.
  const replayCell = { current: false };
  const client = createShellManagementClient({
    argv,
    clientFlags,
    runtime,
    fenceMode,
    // The SAME memoized effective-profile resolver command dispatch consumes (createShellDeps):
    // ctx.credential, the capability-cache fingerprint, and the wire bearer are ONE resolution.
    resolveCredential: shellDeps.resolveCredential,
    // The shared SNAPSHOT — wire-client pins the guard's profile to it and binds the refresh
    // record/lock seams from it, so no consumer re-reads config (TOCTOU-free by construction).
    effectiveProfile,
    confirm,
    warn,
    enforceApiUrl,
    hintCell,
    replayCell,
    seams: resolveClientSeams(overrides),
    readRecord: overrides.readRecord,
    storeRecord: overrides.storeRecord,
    stateDir: overrides.stateDir,
  });
  // T-213: the login/logout auth seam — credential WRITE/DELETE + OAuth-boundary I/O — sharing the
  // guard memo above. Attached to every Ctx (cheap to build); consumed by login/logout and — since
  // T-223 — by `account security`, which rides the SAME seam (its memoized `ensureApiUrl` + the
  // OAuth-boundary `loginIo`) to derive the dashboard origin from the AS metadata.
  const auth = createAuthCommandSeam({
    runtime,
    ensureApiUrl: enforceApiUrl,
    effectiveProfile,
    warn,
    loginIo: resolveLoginIo(overrides, runtime),
    // T-221: the shell OWNS the per-invocation credential memo (createShellDeps), so the reset
    // is threaded from there — the auth seam only exposes it. The explicit no-op fallback is the
    // REQUIRED-dep contract (codex k07): hand-built deps without a memo state that visibly.
    invalidateCredential: shellDeps.invalidateCredential ?? (() => {}),
  });
  // `project` starts at NO_PROJECT (builtin `null`) — the sibling of the NO_CREDENTIAL base.
  // The shell overwrites BOTH with the resolved value when it dispatches a remote command
  // (build-cli.runSpec); a local command (version/reference) keeps the base and reads neither.
  return {
    client,
    output,
    credential: NO_CREDENTIAL,
    clientFlags,
    project: NO_PROJECT,
    auth,
    replay: replayCell,
  };
}

/** Build the login-flow leaf seams — production defaults, overridable for hermetic tests. */
function resolveLoginIo(overrides: RunOverrides, runtime: CliRuntime): LoginIoSeams {
  return {
    fetch: overrides.fetch ?? globalThis.fetch,
    // X8: injected watchdog timers PROPAGATE — under injected timers the OAuth/loopback watchdogs
    // must never silently fall back to the ambient globals (LoginIoSeams defaults them when absent).
    timers: overrides.timers,
    sleep: overrides.sleep ?? realSleep,
    now: overrides.now ?? (() => Date.now()),
    randomBytes: overrides.randomBytes ?? defaultRandomBytes,
    openUrl: overrides.openUrl ?? ((url: string) => defaultOpenUrl(url)),
    createServer: overrides.createServer,
    platform: overrides.platform ?? process.platform,
    // Interactive progress (device prompt / browser fallback URL) → stderr, never stdout.
    stderr: runtime.stderr,
  };
}

/** The production runtime seam (process-backed). A test injects its own via `RunOverrides.runtime`. */
function defaultRuntime(): CliRuntime {
  return {
    env: process.env,
    homeDir: os.homedir(),
    cwd: process.cwd(),
    keyring: napiKeyringPort(),
    isTTY: Boolean(process.stdin.isTTY),
    stderr: stderrWarn,
    flags: {},
    // T-222 (step 5): consumed by the version/selftest diagnostics.
    nodeVersion: process.version,
  };
}

/**
 * Fence disposition by command head (A11/A31, extended by T-222 step 5): the skew-MEASURING
 * instruments — `status`, and the T-222 diagnostics `version`/`selftest` — get the REPORT
 * fence (skew is their DATA; a compat-window 2xx from a major-ahead server still yields the
 * advertised version, and the instrument can never be killed by the thing it measures).
 * Every other command — an empty path included — gets the terminal "throw" fence.
 */
export function fenceModeFor(head: string | undefined): "report" | "throw" {
  return head === "status" || head === "version" || head === "selftest" ? "report" : "throw";
}

/** The CredentialDeps for the memoized production resolver, derived from the runtime seam. */
function credentialDepsFromRuntime(runtime: CliRuntime, warn: (m: string) => void): CredentialDeps {
  return {
    env: runtime.env,
    homeDir: runtime.homeDir,
    keyring: runtime.keyring,
    isTTY: runtime.isTTY,
    spawn: spawn as unknown as CredentialDeps["spawn"],
    warn,
  };
}

/** Best-effort stderr writer for shell diagnostics (banner, helper slow-warning).
 * Non-throwing: the callback form swallows an async write error (e.g. EPIPE on a
 * closed stderr) so a broken stderr can never corrupt the single stdout document
 * or crash the process. (The serializer's own stdout/stderr writes share this
 * best-effort property; a fully EPIPE-proof stream layer is T-207's concern.) */
function stderrWarn(message: string): void {
  try {
    process.stderr.write(message, () => {
      /* swallow async write errors (EPIPE) — diagnostics are best-effort */
    });
  } catch {
    /* swallow a synchronous throw too */
  }
}

/**
 * Build the production shell seams: a MEMOIZED credential resolver over the runtime
 * (process.env, the OS home dir, the native keyring port, spawn) and the stderr banner
 * writer. Memoized so at most ONE resolution happens per process; lazy so `version` (which
 * never invokes it) triggers no keychain access. `overrides` lets an integration test inject a
 * hermetic runtime + a fixed credential resolver — production passes none.
 */
export function createShellDeps(overrides: RunOverrides = {}, argv: readonly string[] = []): ShellDeps {
  const runtime = overrides.runtime ?? defaultRuntime();
  const warn = overrides.warn ?? stderrWarn;
  const confirm = overrides.confirm ?? createConfirm;
  const promptLine = overrides.promptLine ?? createPromptLine;
  const promptSecret = overrides.promptSecret ?? createPromptSecret;
  let cached: Promise<ResolvedCredential> | null = null;
  // The resolver binds to the EFFECTIVE profile (flag > env > repo > config — resolved lazily,
  // inside the memo, so `version` still reads no config): overlaying AGKIT_PROFILE makes the
  // T-206 chain read/report the profile the invocation actually targets. This ONE instance
  // serves ctx.credential, the capability-cache fingerprint, AND the wire client's bearer —
  // a split would fingerprint the cache with a token the client never sent (A32) and let
  // whoami mix two profiles' credentials in one report.
  // ONE effective-CONTEXT SNAPSHOT per invocation (memoized, lazy): the credential resolver,
  // the wire client's record/lock seams, the guard's pinned profile, AND `ctx.project` (F0) all
  // read THIS one `resolveContext`. A second independent config read could straddle a concurrent
  // config change (TOCTOU) and split the bearer's profile / the project from the guard-approved
  // context. `effectiveProfile` projects `.profile.value`; `effectiveContext` exposes the whole
  // resolution (so profile + project cannot diverge). Lazy: `version` forces neither.
  let contextCell: ResolvedContext | null = null;
  const effectiveContext = (): ResolvedContext => (contextCell ??= resolveEffectiveContext(runtime, argv));
  const effectiveProfile = (): string => effectiveContext().profile.value;
  const resolve =
    overrides.resolveCredential ??
    (() =>
      (cached ??= (async () => {
        const deps = credentialDepsFromRuntime(runtime, warn);
        return resolveCredential({ ...deps, env: { ...runtime.env, AGKIT_PROFILE: effectiveProfile() } });
      })()));
  return {
    resolveCredential: resolve,
    warn,
    runtime,
    confirm,
    promptLine,
    promptSecret,
    readTextFile: overrides.readTextFile ?? createReadTextFile,
    // T-221: the fs OUTPUT + directory-marker seams (the `init` scaffold's only disk access).
    writeTextFile: overrides.writeTextFile ?? createWriteTextFile,
    listDir: overrides.listDir ?? createListDir,
    // T-224: the symlink-FOLLOWING quartet (`agkit setup`'s dotfiles-managed leaves).
    readTextFileFollowing: overrides.readTextFileFollowing ?? createReadTextFileFollowing,
    writeTextFileFollowing: overrides.writeTextFileFollowing ?? createWriteTextFileFollowing,
    verifyFollowedWrite: overrides.verifyFollowedWrite ?? verifyFollowedWrite,
    ensureRootForApply: overrides.ensureRootForApply ?? ensureRootForApply,
    // T-221: reset the memo above. A caller that injected its OWN `resolveCredential` never
    // populates `cached`, so the reset is a no-op there — correct, not silently wrong.
    invalidateCredential: () => {
      cached = null;
    },
    now: overrides.now ?? (() => Date.now()),
    effectiveProfile,
    effectiveContext,
    service: defaultServiceSeam(overrides),
  };
}

/**
 * The production service-plane I/O seam (T-222 S5): the real fs skill/MCP reader plus the
 * process facts the diagnostics read (`platform`, `now`, `randomUUID`). The clock/entropy/platform
 * honor the same `RunOverrides` the wire seams do, so an integration test drives `selftest`
 * end-to-end through `run(argv)` deterministically; production passes none. `installFs` is the
 * real fs reader — kept inert in tests by a hermetic runtime `homeDir`/`cwd`.
 */
function defaultServiceSeam(overrides: RunOverrides): ServiceCommandSeam {
  const platform = overrides.platform ?? process.platform;
  // MEMOIZED-LAZY, unlike the rest of this seam: building the child-exec deps ENSURES the child's
  // credential-free npmrc on disk (child-npmrc.ts), and that can REFUSE. It must therefore run only
  // when a child is actually about to be spawned — a local command like `version` builds this seam
  // too and must still touch no filesystem here. Forced once, both child seams share the instance.
  let childDeps: ChildExecDeps | null = null;
  const childExec = (): ChildExecDeps => (childDeps ??= realChildExecDeps(platform));
  return {
    installFs: realInstallFs(),
    platform,
    now: overrides.now ?? (() => Date.now()),
    randomUUID: overrides.uuid ?? (() => randomUUID()),
    // T-222 step 7 (upgrade): install-method detection + the mutating install child.
    argv1: process.argv[1],
    realpath: (path: string): string | null => {
      try {
        return realpathSync(path);
      } catch {
        return null; // a missing / unresolvable path can never prove a global install.
      }
    },
    probeChild: (cmd, args, opts) => spawnProbeChild(childExec(), cmd, args, opts),
    runChild: (cmd, args, opts) => spawnRunChild(childExec(), cmd, args, opts),
    // T-222 step 8 (dashboard): the AS-metadata GET + the browser launcher (honor the same
    // RunOverrides the login/wire seams do, so an integration test drives `dashboard` end-to-end
    // through `run(argv)` with a hermetic fetch + a spy opener). `approvedApiUrl` is injected
    // per-dispatch by build-cli (S6), never here.
    fetch: overrides.fetch ?? globalThis.fetch,
    openUrl: overrides.openUrl ?? ((url: string) => defaultOpenUrl(url)),
    // T-222 step 10c (api --input): read the body out-of-band from a file PATH or "-" (stdin), UTF-8,
    // bounded to MAX_REQUEST_BYTES (the --input byte cap == the request-body cap, single-sourced).
    readInput: (source: string) => readInputBounded(source, MAX_REQUEST_BYTES),
    // T-224 (setup): the two InstallDeps facts this seam did not already carry. The source dir is
    // the SAME anchored rule housekeeping uses (`skillSourceDir()`), overridable so a test can
    // point the install leg at a fixture tree without touching a real HOME.
    skillSourceDir: overrides.skillSourceDir ?? skillSourceDir(),
    pid: process.pid,
  };
}

/**
 * The production `api --input` reader (T-222 S8; 10c-ii codex fold): `"-"` reads stdin to end; else
 * reads the file at `source`. Both are bounded to `maxBytes` and decoded STRICTLY — invalid UTF-8 is
 * a static `usage_error`, never a silent U+FFFD substitution (honor-or-reject). The file path
 * delegates to the shared bounded single-fd reader `createReadTextFile`: an O_NONBLOCK open + fstat
 * rejects a FIFO / device / directory (a special file reports size 0, so a stat-size pre-check would
 * be bypassed), and the cap is enforced ON the read into `Buffer.alloc(cap+1)` — never trusting a
 * stat size a special or racing (grow-after-stat) file can lie about. The CONTENT never appears in
 * any error; only a `displaySafe`'d PATH may.
 */
export async function readInputBounded(source: string, maxBytes: number): Promise<string> {
  if (source === "-") return readStdinBounded(maxBytes);
  return createReadTextFile(source, { maxBytes });
}

/**
 * Read stdin to end, enforcing `maxBytes` WHILE consuming (a stream has no upfront size to check),
 * then decode STRICTLY — invalid UTF-8 is a static `usage_error`, never a silent U+FFFD substitution
 * (honor-or-reject, mirroring the file reader). No stdin CONTENT ever appears in an error.
 */
async function readStdinBounded(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      throw new CliLocalError("usage_error", {
        detail: "the --input stdin body exceeds the maximum request-body size",
        hint: "reduce the request body, or split it across multiple calls",
      });
    }
    chunks.push(buf);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new CliLocalError("usage_error", {
      detail: "the --input stdin body is not valid UTF-8",
      hint: "provide a UTF-8 encoded JSON document",
    });
  }
}

/**
 * The production child-exec seams: the real `spawn`, ambient timers, a process-GROUP kill, and the
 * CLI-owned credential-free npm user config every child reads INSTEAD of the invoking user's
 * `~/.npmrc`. Call it LAZILY (see `defaultServiceSeam`): the npmrc ensure touches the filesystem and
 * may refuse, so it must run only when a child is actually about to be spawned.
 */
function realChildExecDeps(platform: NodeJS.Platform): ChildExecDeps {
  return {
    spawn: (cmd, args, opts) => spawn(cmd, args, opts) as unknown as ChildLike,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    killGroup: (pid, signal) => {
      try {
        process.kill(-pid, signal as NodeJS.Signals); // negative pid = the whole process group (Unix)
      } catch {
        /* best-effort — the tree may already be gone */
      }
    },
    platform,
    env: process.env,
    // The `{env, homeDir}` pair `defaultRuntime()` binds, so the child's npmrc lands in the CLI's
    // state dir under whatever AGKIT_CONFIG_DIR / XDG_CONFIG_HOME this invocation resolves.
    npmUserConfigPath: ensureChildNpmrc({ env: process.env, homeDir: os.homedir() }),
  };
}

/**
 * Interactive y/N confirm for the API-URL exfiltration guard (T-208). Prompt +
 * echo go to STDERR (stdout stays the single machine document). The guard only ever
 * calls this on an interactive TTY (it exits 2 non-interactively before reaching
 * here), but we belt-and-suspenders return `false` if stdin is not a TTY.
 */
function createConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * The injectable I/O seam for `createPromptLine` (F-F1) — tests drive EOF / SIGINT / error /
 * normal-line paths deterministically over PassThrough streams (never the real process.stdin),
 * and the injected `createInterface` lets a test hold the readline instance to emit SIGINT.
 */
export interface PromptLineIO {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly createInterface?: typeof createInterface;
}

function processPromptIO(): PromptLineIO {
  return { input: process.stdin, output: process.stderr, isTTY: Boolean(process.stdin.isTTY) };
}

/**
 * Interactive TYPED-line reader for a D/PR confirm-string prompt (T-212). Unlike
 * `createConfirm` (a y/N boolean), this returns the RAW line the operator typed so the ceremony
 * can compare it string-equal to the displayed `confirm_string` (plan kinds) or forward it to
 * the server (direct_confirm). Prompt + echo go to STDERR (stdout stays the single machine
 * document); a non-interactive stdin fail-closes to `null` (the decision table never reaches a
 * typed prompt non-interactively, but this can never hang).
 *
 * F-F1 (settle-once): the promise resolves EXACTLY once — `null` on close/EOF, SIGINT (^C), or
 * an input-stream error, the raw line on a normal answer — and every listener is removed on
 * settlement (a normal answer included), so no dangling handler outlives the prompt and no
 * late event can double-settle or crash.
 */
export function createPromptLine(question: string, io: PromptLineIO = processPromptIO()): Promise<string | null> {
  if (!io.isTTY) return Promise.resolve(null);
  const makeInterface = io.createInterface ?? createInterface;
  return new Promise((resolve) => {
    const rl = makeInterface({ input: io.input, output: io.output as NodeJS.WritableStream });
    let settled = false;
    const settle = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      rl.removeListener("close", onClose);
      rl.removeListener("SIGINT", onSigint);
      rl.removeListener("error", onError);
      io.input.removeListener("error", onError);
      rl.close(); // idempotent; a settle from onClose closes an already-closing interface
      resolve(answer);
    };
    const onClose = (): void => settle(null); // EOF / stream closed without an answer
    const onSigint = (): void => settle(null); // ^C is a decline, never a hang or a crash
    const onError = (): void => settle(null); // an input error is a decline, never an unhandled throw
    rl.on("close", onClose);
    rl.on("SIGINT", onSigint);
    // Readline RE-EMITS input errors on the interface itself — an unlistened rl 'error' is an
    // unhandled-'error' crash, so BOTH emitters get the (settle-once) handler.
    rl.on("error", onError);
    io.input.on("error", onError);
    rl.question(question, (answer) => settle(answer));
  });
}

/**
 * The injectable I/O seam for `createPromptSecret` (T-217 / RR-10) — a RAW-MODE byte reader
 * (never readline: readline echoes). Tests drive every settlement path (prior-raw/prior-nonraw
 * restore, 0x03/0x04/EOF/error/setup-failure, late-event) over fakes, never the real stdin.
 */
export interface PromptSecretIO {
  readonly input: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
    readonly isRaw?: boolean;
    setRawMode(mode: boolean): unknown;
  };
  readonly output: NodeJS.WritableStream;
  readonly isTTY: boolean;
}

function processPromptSecretIO(): PromptSecretIO {
  const stdin = process.stdin as unknown as PromptSecretIO["input"];
  return { input: stdin, output: process.stderr, isTTY: Boolean(process.stdin.isTTY) };
}

/**
 * Interactive ECHO-OFF secret reader (T-217 R-D / RR-10). Unlike `createPromptLine` (readline —
 * it ECHOES, unusable for a secret) this reads STDIN in RAW MODE and echoes NOTHING; the resolved
 * string is the typed line. Prompt goes to STDERR (stdout stays the single machine document); a
 * non-interactive stdin fail-closes to `null` up front.
 *
 * RR-10 terminal hygiene — the promise settles EXACTLY once, and on EVERY settlement path
 * (success, EOF/`end`/`close`, Ctrl-C-as-0x03-byte, Ctrl-D-as-0x04, stream `error`, a SYNCHRONOUS
 * setup failure, and any late event after settlement) the raw-mode state is restored to what it
 * was BEFORE the prompt and ALL installed listeners are removed. In raw mode SIGINT is NOT
 * delivered — Ctrl-C arrives as the ETX byte 0x03, handled explicitly.
 */
export function createPromptSecret(
  question: string,
  io: PromptSecretIO = processPromptSecretIO(),
): Promise<string | null> {
  if (!io.isTTY) return Promise.resolve(null);
  const { input, output } = io;
  // Capture the prior raw-mode state BEFORE any change (RR-10) — restored on every settlement path.
  const priorRaw = input.isRaw === true;
  return new Promise((resolve) => {
    const bytes: number[] = [];
    let settled = false;

    const onData = (chunk: unknown): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (const b of buf) {
        if (b === 0x03 || b === 0x04) {
          // Ctrl-C (ETX) / Ctrl-D (EOT): a decline. Raw mode delivers no SIGINT — handle the byte.
          settle(null);
          return;
        }
        if (b === 0x0d || b === 0x0a) {
          // Enter: a single visual "\n" ack to stderr (never the typed bytes), then settle.
          try {
            output.write("\n");
          } catch {
            /* best-effort ack */
          }
          settle(Buffer.from(bytes).toString("utf8"));
          return;
        }
        if (b === 0x7f || b === 0x08) {
          // DEL / Backspace: correctable typing, still zero echo.
          bytes.pop();
          continue;
        }
        bytes.push(b);
      }
    };
    const onEnd = (): void => settle(null); // EOF / stream closed without an answer
    const onClose = (): void => settle(null);
    const onError = (): void => settle(null); // an input error is a decline, never an unhandled throw

    function settle(answer: string | null): void {
      if (settled) return; // late events after settlement are no-ops (belt: latch; suspenders: below)
      settled = true;
      // Restore raw mode to the prior state — best-effort but ALWAYS attempted, on EVERY path.
      try {
        input.setRawMode(priorRaw);
      } catch {
        /* restore is best-effort — never let it throw out of settlement */
      }
      input.removeListener("data", onData as (...a: unknown[]) => void);
      input.removeListener("end", onEnd as (...a: unknown[]) => void);
      input.removeListener("close", onClose as (...a: unknown[]) => void);
      input.removeListener("error", onError as (...a: unknown[]) => void);
      resolve(answer);
    }

    // Guarded setup: a SYNCHRONOUS setRawMode failure must never leak a raw terminal or throw.
    try {
      input.setRawMode(true);
      input.on("data", onData as (...a: unknown[]) => void);
      input.on("end", onEnd as (...a: unknown[]) => void);
      input.on("close", onClose as (...a: unknown[]) => void);
      input.on("error", onError as (...a: unknown[]) => void);
      output.write(question);
    } catch {
      settle(null);
    }
  });
}

/**
 * Map a lone `--version` / `-v` to the `version` command so version output always
 * flows through the ONE registry command (single source), not yargs' built-in.
 */
export function normalizeVersionAlias(argv: string[]): string[] {
  const first = argv[0];
  if ((first === "--version" || first === "-v") && argv.length === 1) return ["version"];
  return argv;
}

/**
 * ISS-226 — the diagnostic yargs cannot give. `--json` is registered `type: "string"` (it doubles
 * as `--json a,b` field selection), so `agkit --json apply plan_ABC123` really does parse as
 * `json="apply"`, and yargs then reports `Unknown command: plan_ABC123` — naming the token the user
 * got RIGHT and never mentioning the one that vanished. Same for `--jq`, `--template`, `--profile`,
 * `--project`, `--retries`, `--idempotency-key`. Arity cannot fix this: the parse is correct, the
 * ORDER is wrong. So on the failure path ONLY (a successful dispatch is never second-guessed — a
 * profile legitimately named `version` must keep working), re-describe the failure in terms of what
 * actually happened. Returns null when this is not that mistake, and the original error stands.
 *
 * The eaten token is safe to echo: `leadingFlagSwallowedCommand` fires only when it is a token from
 * our own shipped head set, never an arbitrary argv value (the F-D2 mis-pasted-secret case).
 */
function leadingFlagUsageError(argv: readonly string[]): CliLocalError | null {
  const swallow = leadingFlagSwallowedCommand(argv, (t) => TOP_LEVEL_COMMAND_TOKENS.has(t));
  if (swallow === null) return null;
  return new CliLocalError("usage_error", {
    detail: `--${displaySafe(swallow.flag)} takes a value, so it consumed the command word '${displaySafe(swallow.token)}' and no command was left to run — put global flags AFTER the command path, or use the --${swallow.flag}=<value> form`,
    hint: `agkit ${displaySafe(swallow.token)} … --${swallow.flag}`,
  });
}

/** Build + run the CLI. Every result/error flows through the serializer chokepoint.
 * ALL failure classification is delegated to the T-207 taxonomy dispatcher
 * (`classifyThrownError`), which folds T-205's `unknown_field`, T-206's three
 * credential codes, wire problems, and the generic usage fallback into one teachable
 * `{envelope, exitCode}` — exit codes are always within {1,2,3}. */
export async function run(argv: string[], overrides: RunOverrides = {}): Promise<void> {
  const normalized = normalizeVersionAlias(argv);
  const isTTY = Boolean(process.stdout.isTTY);
  // The command path (tokens before the first flag) lets the dispatcher concretize
  // hints, e.g. `agkit version --json version` for an unknown-field error.
  const commandPath = commandPathFromArgv(normalized);

  // ISS-570 housekeeping — PHASE 1 (pre-parse). TOTALLY guarded: building the deps AND
  // running the phase are inside one try/catch, so a housekeeping throw can NEVER reach
  // the command error path, change the exit code, or touch stdout. Exempt (dev build /
  // `mcp` command path) => skipped entirely (FORBIDDEN: housekeeping on dev / mcp serve).
  // The same deps are reused for PHASE 2 (the post-parse banner).
  let housekeeping: HousekeepingDeps | null = null;
  try {
    if (!isHousekeepingExempt(normalized)) {
      housekeeping = buildHousekeepingDeps();
      preCommandHousekeeping(housekeeping);
    }
  } catch {
    /* housekeeping is best-effort — never affects the command */
    housekeeping = null;
  }

  // The shell seams (memoized credential resolver + runtime + confirm + warn) are built ONCE and
  // shared between the client wiring (createRunContext) and the command runner (buildCli). The
  // hint cell carries a failed refresh's source-aware terminal hint (A14) to the error renderer.
  const shellDeps = createShellDeps(overrides, normalized);
  const hintCell: { current: string | null } = { current: null };

  // Output config is resolved first: a malformed output flag (e.g. `--jq` with no
  // expression) makes this throw BEFORE a config exists. The catch path honors the
  // raw-argv `--json` pre-sniff (deliverable 6) so a parse failure still emits the
  // JSON error envelope instead of TTY prose.
  let ctx: Ctx;
  try {
    ctx = createRunContext(normalized, shellDeps, hintCell, overrides);
  } catch (err) {
    const { envelope, exitCode } = classifyThrownError(err, { commandPath });
    await emitError(fallbackOutputConfig(isTTY, normalized), envelope, exitCode);
    return;
  }

  const cli = buildCli(normalized, ctx, shellDeps);
  cli.fail(false); // we own ALL failure rendering (async, through the chokepoint).
  try {
    await cli.parseAsync();
  } catch (err) {
    // A14: a failed refresh emitted a SOURCE-AWARE terminal hint via `hintCell`; it OVERRIDES the
    // default "agkit login" the 401 `refresh_auth` disposition attaches (hint metadata only — no
    // error code is threaded). The dispatcher applies it only on a refresh_auth wire disposition.
    // ISS-226: a leading value-taking global flag that ate the command word is re-described first
    // (see `leadingFlagUsageError`) — same exit code, a message that names the real mistake.
    const { envelope, exitCode } = classifyThrownError(leadingFlagUsageError(normalized) ?? err, {
      commandPath,
      refreshHint: hintCell.current ?? undefined,
    });
    await emitError(ctx.output, envelope, exitCode);
  }

  // ISS-570 housekeeping — PHASE 2 (post-parse, after the command output on success OR a
  // handled error). Guarded: the TTY-only stderr update banner can never change the exit
  // code or touch stdout / the --json document.
  if (housekeeping) {
    try {
      emitUpdateBanner(housekeeping);
    } catch {
      /* best-effort */
    }
  }
}
