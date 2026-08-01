// T-222 step 7 (A8 / A9 / B7) — the production child-process glue for `agkit upgrade`, factored
// behind injected `spawn`/timer/kill seams so the security-critical behavior is UNIT-tested (no real
// npm): the READ-ONLY `probeChild` (bounded stdout capture) and the MUTATING `runChild` (redacting
// sink over the child's output, SANITIZED env at spawn, and a watchdog that terminates the WHOLE
// process tree — SIGTERM → grace → SIGKILL on Unix, `taskkill /T /F` on Windows). EVERY spawn here
// — probe, install, and the Windows killer — builds its env the ONE identical way: the allowlist
// PLUS the injected credential-free npm userconfig, so no child ever reads the user's `~/.npmrc`.
// run.ts binds the real `spawn`/`process.kill`/timers and that userconfig path.
import type { ProbeChildResult, RunChildOptions, RunChildResult } from "../../commands/command-seams";
import { createRedactingSink, sanitizeChildEnv } from "./child-io";

/** Cap the READ-ONLY probe's captured stdout (a hostile/mangled `npm prefix -g` cannot flood memory). */
export const PROBE_STDOUT_MAX_BYTES = 64 * 1024;
/** Grace between SIGTERM and SIGKILL when terminating a timed-out install tree (Unix). */
export const TREE_KILL_GRACE_MS = 2_000;
/**
 * Hard settlement window after the watchdog's tree kill. EVERY kill layer is best-effort (a group
 * signal is swallowed, `taskkill` can fail to launch), and a grandchild that escaped the group can
 * hold the inherited stdout/stderr pipes open so `close` NEVER arrives — so settlement must not
 * depend on it. Past this deadline the call resolves as an unconfirmed termination.
 */
export const TREE_KILL_SETTLE_MS = TREE_KILL_GRACE_MS + 3_000;

/** The minimal child-process surface these helpers touch (a fake drives every path in tests). */
export interface ChildLike {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: string): boolean;
}

export interface SpawnOptions {
  readonly stdio: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "ignore"];
  readonly env: NodeJS.ProcessEnv;
  readonly detached: boolean;
}
export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildLike;

/** Injected timer + process-group-kill seams (real: global timers + `process.kill(-pid, sig)`). */
export interface ChildExecDeps {
  readonly spawn: SpawnFn;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Signal a whole process GROUP (production: `process.kill(-pid, signal)`); throws are swallowed. */
  readonly killGroup: (pid: number, signal: string) => void;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Absolute path to a CREDENTIAL-FREE npm user config every child is pointed at. REQUIRED, not
   * optional: `HOME` is allowlisted (npm cannot resolve its cache/prefix without it), so with no
   * `npm_config_userconfig` override the child READS THE INVOKING USER'S `~/.npmrc` — commonly a
   * registry `_authToken` — and the allowlist's "the child receives no credential" guarantee is not
   * actually met. Mandatory so no caller can construct these deps and silently skip the override.
   * Built by the binder (cli/run.ts) because it is an fs concern; this module touches no fs.
   */
  readonly npmUserConfigPath: string;
}

/**
 * A8 READ-ONLY probe (`npm prefix -g`). Resolves (never rejects): a spawn error / non-zero exit /
 * watchdog timeout → `{ok:false}`. stdout is captured up to a hard cap and trimmed. Even this
 * read-only child spawns with a sanitized env (defense in depth — it needs no secret either).
 */
export function spawnProbeChild(
  deps: ChildExecDeps,
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs: number },
): Promise<ProbeChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    const parts: Buffer[] = [];
    let received = 0;
    const finish = (r: ProbeChildResult): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      resolve(r);
    };
    let child: ChildLike;
    try {
      child = deps.spawn(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: sanitizeChildEnv(deps.env, { npmUserConfigPath: deps.npmUserConfigPath }),
        detached: false,
      });
    } catch {
      // spawn threw synchronously (ENOENT etc.) — no timer to clear yet.
      resolve({ code: null, stdout: "", ok: false });
      return;
    }
    const timer = deps.setTimer(() => {
      // A watchdog on a READ-ONLY probe: kill the single child (no tree — it mutates nothing).
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      finish({ code: null, stdout: "", ok: false });
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      // The cap is a HARD bound on retained bytes, so a chunk is never taken whole on faith: only the
      // remaining budget is kept (one oversized read must not overshoot), and once spent we retain
      // nothing more. Decoding happens once, at close, over the capped bytes.
      const remaining = PROBE_STDOUT_MAX_BYTES - received;
      if (remaining <= 0) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      received += kept.length;
      parts.push(kept);
    });
    child.on("error", () => finish({ code: null, stdout: "", ok: false }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(parts).toString().trim(), ok: code === 0 }));
  });
}

/**
 * A8/A9/B7 MUTATING install child (`npm install -g`). Streams stdout+stderr through a bounded
 * REDACTING line sink (never raw bytes), spawns with a SANITIZED env, and on watchdog expiry
 * terminates the WHOLE process tree before resolving `{timedOut:true, code:null}`. Settlement is
 * ALWAYS bounded: a `close` resolves with the confirmed exit, and if none arrives within
 * `TREE_KILL_SETTLE_MS` of the watchdog the same timed-out result is resolved as an unconfirmed
 * termination — the caller awaits this bare, so it must never be able to hang.
 */
export function spawnRunChild(
  deps: ChildExecDeps,
  cmd: string,
  args: readonly string[],
  opts: RunChildOptions,
): Promise<RunChildResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let settleTimer: unknown;
    const sink = createRedactingSink(opts.onLine);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      if (settleTimer !== undefined) deps.clearTimer(settleTimer);
      sink.flush();
      resolve({ code: timedOut ? null : code, timedOut });
    };
    let child: ChildLike;
    try {
      child = deps.spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeChildEnv(deps.env, { npmUserConfigPath: deps.npmUserConfigPath }),
        // Unix: own process group so the watchdog can signal the whole tree (a negative pid).
        detached: deps.platform !== "win32",
      });
    } catch {
      resolve({ code: null, timedOut: false });
      return;
    }
    const timer = deps.setTimer(() => {
      timedOut = true;
      terminateTree(deps, child);
      // The tree kill is unverifiable from here, so the promise may not wait on `close` forever: bound
      // it. A real `close` inside the window still wins (it clears this timer); past it we report the
      // SAME timed-out outcome — an unconfirmed termination, never a hang.
      settleTimer = deps.setTimer(() => finish(null), TREE_KILL_SETTLE_MS);
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => sink.push(chunk.toString()));
    child.stderr?.on("data", (chunk) => sink.push(chunk.toString()));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Terminate a timed-out install child's WHOLE tree. Unix: SIGTERM the process group, then escalate
 * to SIGKILL after a grace window if it has not exited. Windows (no process groups): `taskkill /T /F`
 * via the same spawn seam. Every OS call is best-effort — a throw must never crash the watchdog —
 * and because a tree kill can silently miss, the child we DO own is always signalled directly too.
 */
function terminateTree(deps: ChildExecDeps, child: ChildLike): void {
  const pid = child.pid;
  if (pid === undefined) {
    // No pid ⇒ no group to signal and no `taskkill` target; the direct handle is all we hold.
    killDirect(child);
    return;
  }
  if (deps.platform === "win32") {
    try {
      // `taskkill` reads no npm config, so the userconfig override buys it nothing — it is passed
      // anyway so EVERY spawn in this module builds its env the one identical way. A call site that
      // sanitizes differently "because this one is harmless" is how the exception becomes the rule.
      const killer = deps.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: sanitizeChildEnv(deps.env, { npmUserConfigPath: deps.npmUserConfigPath }),
        detached: false,
      });
      // A failure to LAUNCH arrives asynchronously as an 'error' EVENT, outside any try/catch —
      // unhandled it takes the whole CLI down, so it must have a listener even though we ignore it.
      killer.on("error", () => {
        /* best-effort */
      });
    } catch {
      /* best-effort */
    }
    // `taskkill` can be missing or refused, so the direct handle is the fallback — but only after the
    // grace window: killing the parent first orphans the tree `taskkill /T` walks down from it.
    const escalate = deps.setTimer(() => killDirect(child), TREE_KILL_GRACE_MS);
    child.on("close", () => deps.clearTimer(escalate));
    return;
  }
  deps.killGroup(pid, "SIGTERM");
  const escalate = deps.setTimer(() => {
    deps.killGroup(pid, "SIGKILL");
    // Group signals are swallowed when the group is gone or was never joined (a re-parented child):
    // signalling the direct handle guarantees the escalation reaches the process we spawned.
    killDirect(child);
  }, TREE_KILL_GRACE_MS);
  // Stop the escalation the moment the child confirms exit (avoids signalling a reused pid).
  child.on("close", () => deps.clearTimer(escalate));
}

/** Signal the direct child handle. Best-effort — a throw must never escape into the watchdog. */
function killDirect(child: ChildLike): void {
  try {
    child.kill("SIGKILL");
  } catch {
    /* best-effort */
  }
}
