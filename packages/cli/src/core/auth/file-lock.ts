// The ISS-202 cross-process lock for the plaintext credentials document (T-213 S6, decision C +
// B-8; reclamation protocol re-ruled in the tranche-1 review round R1-R4). Before T-213 no CLI
// command wrote the insecure file, so its read-modify-write ran UNLOCKED; `login
// --insecure-storage` + `logout`/`--all-profiles` now make all three document RMWs (write /
// remove / copy) concurrently user-reachable, and two racing processes each reading the same
// document then atomically renaming would silently drop the earlier writer's profile.
//
// This is an O_CREAT|O_EXCL lock file (`~/.agentkit/.credentials.lock`, 0600) held across ONE RMW.
// It is deliberately SYNCHRONOUS — the RMW functions are sync and used by sync store/delete paths,
// so making them async would ripple through the whole chain. Acquisition is bounded (per-iteration
// deadline check + every sleep clamped to the remaining budget, R4); every path releases in
// `finally`. Every fs/clock/sleep/liveness touch is injected so the concurrency + reclamation +
// bounded-wait scenarios are deterministic.
//
// RECLAMATION PROTOCOL (R1 — fail closed, mutual exclusion over availability):
//   (a) parseable meta + DEAD owner pid  → reclaimable (the holder crashed; nothing is mid-RMW).
//   (b) parseable meta + LIVE owner pid  → NEVER reclaimable, regardless of age. Acquisition keeps
//       polling and exits via FileLockUnavailableError at the deadline. A recycled pid can make a
//       dead owner LOOK alive — that direction costs a bounded timeout (availability), never a
//       stolen lock under a live writer (mutual-exclusion loss).
//   (c) UNPARSEABLE content → reclaimable ONLY when the file's fs mtime is older than `staleMs`:
//       a just-created, not-yet-written lock instance is milliseconds old and must not be stolen
//       out of its create window; a genuinely corrupt abandonment ages past the bound and heals.
//   `acquired_at` in the meta is INFORMATIONAL ONLY (diagnostics) — the predicate never reads it.
//
// `removeIfContent` is a best-effort read-then-unlink, NOT atomic (POSIX has no compare-and-unlink).
// It is safe here as defense-in-depth because of (b): a parseable lock with a live owner is never
// removed by anyone else, so at release time our own instance is still ours to unlink; a crash
// between the read and the unlink leaves a dead-owner lock, which (a) makes reclaimable.
//
// CLOCK RESIDUAL: the default clock is `Date.now()` (wall time, not monotonic). A backward clock
// adjustment mid-acquisition extends the bounded wait by the adjustment (the deadline recedes);
// it never breaks mutual exclusion (the predicate is liveness + mtime-age, not deadline-driven).
import { closeSync, constants, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** O_NOFOLLOW is POSIX; 0 where absent (Windows) — harmless. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The lock file lives beside credentials.json in `~/.agentkit`. */
export const LOCK_FILENAME = ".credentials.lock";
/**
 * The CONFIG-scoped lock file (T-213 review X6): `ensureProfileEntry`'s config.json RMW holds the
 * SAME protocol under THIS name, beside config.json in the config dir — one protocol, two scopes.
 */
export const CONFIG_LOCK_FILENAME = ".config.lock";
/** Total bounded acquisition wait (interactive-tuned — an RMW is milliseconds). */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
/** Poll interval while contending (each sleep is additionally clamped to the remaining budget, R4). */
export const DEFAULT_LOCK_POLL_MS = 50;
/**
 * Age bound gating ONLY unparseable-file reclamation (R1(c)): an UNPARSEABLE lock file whose fs
 * mtime is older than this is presumed a corrupt abandonment and reclaimed. A PARSEABLE lock is
 * never age-reclaimed — its owner's liveness is the sole criterion (a live owner is never stolen).
 */
export const DEFAULT_LOCK_STALE_MS = 30_000;

/**
 * The injectable fs seam for the lock file. Production is `nodeFileLockFs()`; tests inject an
 * in-memory map to stage contention / dead-owner / unparseable-age races deterministically.
 */
export interface FileLockFs {
  /** Atomically create `path` with `content` at 0600, returning false if it already exists (O_EXCL). */
  createExclusive(path: string, content: string): boolean;
  /** File contents, or null when absent. */
  read(path: string): string | null;
  /** The file's mtime (epoch ms), or null when absent — gates unparseable-file reclamation (R1(c)). */
  mtimeMs(path: string): number | null;
  /**
   * Remove `path` ONLY if its current content === `expected`. Best-effort read-then-unlink — NOT
   * atomic (no compare-and-unlink exists on POSIX); see the header for why the R1 predicate makes
   * this safe as defense-in-depth (a live-owner lock is never removed by anyone else). A no-op
   * when the file is absent or the bytes differ.
   */
  removeIfContent(path: string, expected: string): void;
}

export interface FileLockDeps {
  readonly fs?: FileLockFs;
  readonly now?: () => number;
  /** SYNCHRONOUS bounded sleep (default: an Atomics.wait block). Injected for deterministic tests. */
  readonly sleep?: (ms: number) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly pid?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly staleMs?: number;
  /**
   * Lock FILE NAME inside `dir` (default `LOCK_FILENAME`). X6: parameterized so the config RMW
   * reuses THIS protocol under its own lock file (`withConfigFileLock`) — never a second protocol.
   */
  readonly lockFilename?: string;
}

/** Acquisition exceeded its bounded wait with a live owner still holding the lock. */
export class FileLockUnavailableError extends Error {
  override name = "FileLockUnavailableError";
  constructor(readonly path: string) {
    super(
      "could not acquire the credentials-file lock within the bounded wait — another agkit process " +
        "is writing credentials; retry in a moment",
    );
  }
}

interface LockMeta {
  readonly pid: number;
  /** Informational only (diagnostics) — the reclaim predicate never reads it (R1). */
  readonly acquired_at: number;
}
function parseMeta(raw: string): LockMeta | null {
  try {
    const j = JSON.parse(raw) as unknown;
    if (j === null || typeof j !== "object") return null;
    const pid = (j as Record<string, unknown>).pid;
    const acquired = (j as Record<string, unknown>).acquired_at;
    if (typeof pid !== "number" || typeof acquired !== "number") return null;
    return { pid, acquired_at: acquired };
  } catch {
    return null;
  }
}

/** A blocking synchronous sleep (Atomics.wait on a throwaway buffer — no busy spin). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `process.kill(pid, 0)` liveness probe (EPERM ⇒ alive-but-foreign; ESRCH ⇒ dead ⇒ reclaimable). */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EPERM";
  }
}

/** Production `FileLockFs` over real fs (O_CREAT|O_EXCL|O_NOFOLLOW 0600 create; conditioned remove). */
export function nodeFileLockFs(): FileLockFs {
  return {
    createExclusive(path, content) {
      let fd: number;
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST") return false;
        throw err;
      }
      try {
        const buf = Buffer.from(content, "utf8");
        let written = 0;
        while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written, written);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    },
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return null;
        throw err;
      }
    },
    mtimeMs(path) {
      try {
        return statSync(path).mtimeMs;
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return null;
        throw err;
      }
    },
    removeIfContent(path, expected) {
      // Best-effort read-then-unlink (NOT atomic — see the FileLockFs doc). Safe as
      // defense-in-depth under R1: no other process ever removes a live-owner lock, so our own
      // release cannot be unlinking a replacement.
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
        throw err;
      }
      if (raw !== expected) return;
      try {
        unlinkSync(path);
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
        throw err;
      }
    },
  };
}

/**
 * Run `fn` while holding the credentials-file lock in `dir`. Bounded acquisition (per-iteration
 * deadline check + remaining-budget-clamped sleeps, R4) with the R1 reclaim predicate: DEAD-owner
 * locks are reclaimed; LIVE-owner locks are NEVER stolen (throws `FileLockUnavailableError` at the
 * deadline); unparseable locks are reclaimed only past the mtime age bound. The lock is released
 * in `finally` on every path (success or throw). `fn`'s return value is propagated.
 */
export function withInsecureFileLock<T>(dir: string, fn: () => T, deps: FileLockDeps = {}): T {
  const fs = deps.fs ?? nodeFileLockFs();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const pid = deps.pid ?? process.pid;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const staleMs = deps.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const lockPath = join(dir, deps.lockFilename ?? LOCK_FILENAME);
  const deadline = now() + timeoutMs;

  let held: string | null = null;
  for (;;) {
    if (now() >= deadline) throw new FileLockUnavailableError(lockPath);
    const meta = JSON.stringify({ pid, acquired_at: now() }); // acquired_at: informational only
    if (fs.createExclusive(lockPath, meta)) {
      held = meta;
      break;
    }
    // Someone holds it. R1 reclaim predicate — removal is conditioned on the bytes we observed,
    // but removeIfContent is best-effort read-then-unlink (NOT atomic — see header): the check
    // NARROWS the window in which a concurrent release+recreate could be misdeleted; it cannot
    // close it. The predicate:
    //   parseable + dead pid   → reclaim;
    //   parseable + live pid   → NEVER (poll to the deadline — fail closed);
    //   unparseable            → reclaim only when the FILE is older than staleMs (mtime).
    const raw = fs.read(lockPath);
    if (raw !== null) {
      const existing = parseMeta(raw);
      if (existing !== null) {
        if (!isProcessAlive(existing.pid)) fs.removeIfContent(lockPath, raw);
      } else {
        const mtime = fs.mtimeMs(lockPath);
        if (mtime !== null && now() - mtime > staleMs) fs.removeIfContent(lockPath, raw);
      }
    }
    // R4: clamp the sleep to the remaining budget — acquisition never overshoots timeoutMs.
    sleep(Math.max(0, Math.min(pollMs, deadline - now())));
  }

  try {
    return fn();
  } finally {
    fs.removeIfContent(lockPath, held);
  }
}

/**
 * Run `fn` while holding the CONFIG-scoped lock in `dir` (T-213 review X6) — a thin wrapper that
 * reuses the EXACT credentials-lock protocol (`withInsecureFileLock`: O_CREAT|O_EXCL create, R1
 * reclaim predicate, R4 bounded acquisition, finally-release) under `CONFIG_LOCK_FILENAME`.
 * Serializes `ensureProfileEntry`'s config.json load-modify-save so two concurrent logins for
 * different profiles can never clobber each other's entry (which would strand a stored keychain
 * credential with no listable profile). NOT a second lock protocol — the same primitive, scoped.
 */
export function withConfigFileLock<T>(dir: string, fn: () => T, deps: FileLockDeps = {}): T {
  return withInsecureFileLock(dir, fn, { ...deps, lockFilename: CONFIG_LOCK_FILENAME });
}
