// Cross-process refresh serialization + crash-recovery marker (T-211 step 6 — A40/A41/
// A42/A43). The token-refresh executor (refresh.ts) is the ONE writer of a rotating
// credential; the server does MANDATORY ATOMIC ROTATION (every refresh mints a NEW
// refresh_token and, past a ~60s proof-of-possession grace window, re-presenting the old
// one revokes the whole grant family). Two guards make that safe across concurrent
// `agkit` invocations AND across a crash:
//
//   • a state-dir LOCK (A40/A43) serializes read→refresh→store so two processes never
//     present the same refresh token in an uncoordinated way. The lock KEY derives from a
//     STABLE, NON-SECRET identity (canonical origin, profile, source, grant_id) — NEVER a
//     token, whose rotation would change the key mid-flight (A43). The lock file carries
//     owner {pid,nonce,acquired_at}, is created 0600 via O_EXCL, waits a BOUNDED time, and
//     reclaims a DEAD owner's lock (dead pid, or a lock held past a generous staleness
//     bound — pid recycling). Every REMOVAL of a lock instance one does not own is
//     serialized through a per-key reclamation BARRIER (codex step-6 fix round): a
//     compare-and-delete built from read-verify-unlink alone races a concurrent
//     release+recreate and can drop a live holder's lock, admitting two holders. The
//     barrier closes that: reclaimers hold it across verify→remove, releases take it
//     one-shot (or leave the lock to staleness), and an acquirer that wins createExclusive
//     while ANY barrier exists abstains — it self-removes its own instance and retries —
//     so a reclaimer can never be confused by a mid-window creation.
//   • a pending-refresh MARKER (A41/A42) records, BEFORE the first oauth.token send, the
//     IDENTITY of the presented refresh token (a non-secret SHA-256 digest, NEVER the
//     token) plus an absolute grace deadline. It is cleared ONLY after the rotated pair is
//     durably stored. On a later run finding a marker, the executor compares the CURRENT
//     stored refresh identity with the marker's: DIFFER ⇒ the rotation already landed
//     (crash between store and marker-clear) ⇒ recover; MATCH ⇒ genuinely uncertain
//     (crash before/during the send, or the deadline lapsed) ⇒ NEVER re-present the
//     possibly-rotated stale token ⇒ terminal re-auth.
//
// Every clock / entropy / fs touch is an INJECTED seam (RULES + the core/client no-Date.now
// / no-Math.random sweep): `now`, `sleep`, `nonce`, `isProcessAlive`, and a `LockFs` port.
// Production defaults (`nodeLockFs`, `defaultNonce`, `defaultIsProcessAlive`) live here and
// use node crypto's `randomBytes` (a CSPRNG that is NOT the swept `randomUUID`) + real fs.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** O_NOFOLLOW is POSIX; 0 where absent (Windows) — harmless. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The STABLE, NON-SECRET identity a lock/marker is scoped to (A43). Deliberately excludes
 * every token: an access/refresh token rotates, and a lock key that moved on rotation would
 * let a second process take a "different" lock for the same grant.
 */
export interface RefreshIdentity {
  /** The canonical, guard-approved management API origin (scheme://host[:port]). */
  readonly origin: string;
  /** The effective profile. */
  readonly profile: string;
  /** WHERE the credential lives (keychain / insecure_file / …) — same grant, different store ⇒ different lock. */
  readonly source: string;
  /** The OAuth grant id, or null when unknown (a token-only record). */
  readonly grantId: string | null;
}

/**
 * The stable lock/marker KEY: a SHA-256 hex of the non-secret identity tuple (A43). A crypto
 * digest (not a short non-crypto hash) so distinct grants never collide onto one lock. NUL
 * separators keep the fields unambiguous.
 */
export function deriveRefreshKey(id: RefreshIdentity): string {
  return createHash("sha256")
    .update(`${id.origin}\x00${id.profile}\x00${id.source}\x00${id.grantId ?? ""}`, "utf8")
    .digest("hex");
}

/** A non-secret SHA-256 identity for a refresh token — the marker stores THIS, never the token (A41). */
export function refreshTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The injectable fs seam for the lock + marker files. Production is `nodeLockFs()` over real
 * fs; tests inject an in-memory map to drive concurrency / crash / stale-owner scenarios that
 * are impossible to stage deterministically against a real single-threaded filesystem.
 */
export interface LockFs {
  /**
   * Atomically create `path` with `content` at 0600, failing (returning false) if it already
   * exists — the O_EXCL mutual-exclusion primitive. Creates parent dirs as needed.
   */
  createExclusive(path: string, content: string): boolean;
  /** File contents, or null when absent. */
  read(path: string): string | null;
  /** Remove `path`; a no-op when absent. */
  remove(path: string): void;
  /**
   * Atomically (temp + fsync + rename + parent-dir fsync) write `path` at 0600, replacing any
   * existing file (marker updates). The DIRECTORY fsync is load-bearing (A41): the marker must
   * survive a power loss BEFORE the oauth.token send it precedes, or a restarted process would
   * re-present an ambiguously-rotated token.
   */
  writeAtomic(path: string, content: string): void;
  /**
   * CONDITIONED remove: delete `path` ONLY if its current content parses as full lock metadata
   * whose owner nonce equals `nonce` (or, when `nonce` is null, only if the content does NOT
   * parse as lock metadata). Read-verify-unlink — NOT atomic by itself: callers removing an
   * instance they do not own MUST serialize through the reclamation barrier (see
   * `acquireRefreshLock` / `releaseRefreshLock`); removing one's OWN instance is safe anywhere
   * (no other party ever removes a live, fresh, non-observed instance). A no-op when the file
   * is absent or the content does not match.
   */
  removeIfMatch(path: string, nonce: string | null): void;
}

/** Lock-file owner metadata. `nonce` proves ownership across a reclamation; never a secret. */
interface LockMeta {
  readonly pid: number;
  readonly nonce: string;
  readonly acquired_at: number;
}

/** A held lock. `nonce` gates release so a reclaimer's lock is never unlinked by the evicted owner. */
export interface LockHandle {
  readonly path: string;
  readonly nonce: string;
}

/** The pending-refresh marker (A41): presented-token IDENTITY + absolute grace deadline (ms). */
export interface PendingMarker {
  /** SHA-256 digest of the refresh token presented on the in-flight attempt (NEVER the token). */
  readonly presented: string;
  /** Absolute deadline (ms) by which the whole attempt+replay must have completed inside the grace window. */
  readonly deadline: number;
}

/** Bounded lock-acquisition wait (RULES: bound every wait). A refresh + single replay is seconds. */
export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/** Poll interval while contending for the lock (injected sleep — no real wait in tests). */
export const LOCK_POLL_MS = 50;
/**
 * A live-pid lock older than this is presumed abandoned (crash + pid recycling) and reclaimed.
 * Comfortably larger than a worst-case refresh (two bounded oauth.token attempts inside the
 * ~60s grace window), so a legitimately in-progress holder is never stolen from.
 */
export const LOCK_STALE_MS = 90_000;
/**
 * A reclamation BARRIER older than this is presumed crashed and clearable. A barrier is held
 * only across a synchronous verify→remove (microseconds); 10s is orders of magnitude past any
 * legitimate tenure while still self-healing a crashed reclaimer quickly.
 */
export const BARRIER_STALE_MS = 10_000;

/** The per-key reclamation-barrier path (a sibling of the lock file). */
function barrierPathFor(lockPath: string): string {
  return `${lockPath}.barrier`;
}

/** Acquisition exceeded its bounded wait with a live owner holding the lock (A43 — clean terminal). */
export class LockUnavailableError extends Error {
  override name = "LockUnavailableError";
  constructor(readonly path: string) {
    super("could not acquire the credential-refresh lock within the bounded wait");
  }
}

/** Injected timing / entropy / liveness seams for lock acquisition. */
export interface AcquireDeps {
  readonly fs: LockFs;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nonce: () => string;
  /** Is `pid` a live process? Drives dead-owner reclamation (A43). */
  readonly isProcessAlive: (pid: number) => boolean;
}

function parseLockMeta(raw: string): LockMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { pid, nonce, acquired_at } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || typeof nonce !== "string" || typeof acquired_at !== "number") return null;
  return { pid, nonce, acquired_at };
}

/** Is this barrier instance legitimately HELD (parseable, live owner, inside its tenure bound)? */
function barrierHeld(deps: AcquireDeps, meta: LockMeta | null): boolean {
  return meta !== null && deps.isProcessAlive(meta.pid) && deps.now() - meta.acquired_at <= BARRIER_STALE_MS;
}

/**
 * Acquire the cross-process refresh lock (A40/A43). Bounded wait — the deadline is checked at
 * the top of EVERY iteration and every non-acquiring path yields through the injected `sleep`,
 * so even a pathologically recreated/corrupt lock cannot busy-spin past the bound. Reclaims a
 * lock whose owner is DEAD (dead pid) or whose file is unparseable or stale-past-`LOCK_STALE_MS`
 * (pid recycling); every reclamation is serialized through the per-key BARRIER and conditioned
 * on the EXACT instance observed, and an acquirer that wins `createExclusive` while any barrier
 * exists ABSTAINS (self-removes + retries) — the pairing that makes verify→remove safe. Throws
 * `LockUnavailableError` if a LIVE owner keeps holding it past the acquisition timeout — a clean
 * terminal, never a forced steal that could corrupt an in-flight rotation.
 */
export async function acquireRefreshLock(deps: AcquireDeps, path: string, pid: number): Promise<LockHandle> {
  const nonce = deps.nonce();
  const barrier = barrierPathFor(path);
  const deadline = deps.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    if (deps.now() >= deadline) throw new LockUnavailableError(path);

    const meta: LockMeta = { pid, nonce, acquired_at: deps.now() };
    if (deps.fs.createExclusive(path, JSON.stringify(meta))) {
      // Double-check the reclamation barrier: our lock may have been created inside a
      // reclaimer's verify window, and that reclaimer is entitled to treat any mid-window
      // creation as abstaining. HOLD only when no barrier exists.
      const braw = deps.fs.read(barrier);
      if (braw === null) return { path, nonce };
      const bmeta = parseLockMeta(braw);
      // A crashed/corrupt barrier would otherwise wedge every future acquirer — clear it
      // (conditioned on the instance we saw), but still abstain this round (conservative).
      if (!barrierHeld(deps, bmeta)) deps.fs.removeIfMatch(barrier, bmeta?.nonce ?? null);
      deps.fs.removeIfMatch(path, nonce); // self-remove our own instance — safe unserialised
      await deps.sleep(LOCK_POLL_MS);
      continue;
    }

    // Someone holds it. Reclaim only a DEAD / unparseable / stale-past-bound owner.
    const raw = deps.fs.read(path);
    if (raw === null) {
      // Vanished (released) between create and read. Still YIELD — every non-acquiring path
      // sleeps, so a pathological create-fails/read-null alternation stays bounded polling.
      await deps.sleep(LOCK_POLL_MS);
      continue;
    }
    const existing = parseLockMeta(raw);
    const reclaimable =
      existing === null ||
      !deps.isProcessAlive(existing.pid) ||
      deps.now() - existing.acquired_at > LOCK_STALE_MS;
    if (reclaimable) {
      // Serialize the steal through the BARRIER, conditioned on the EXACT instance observed:
      // an unconditional remove is a check-then-act race — a concurrent release+recreate
      // between our read and our unlink would make us delete a DIFFERENT owner's live lock,
      // admitting two holders. Under the barrier no other remover runs, and any lock created
      // mid-window abstains (the double-check above), so verify→remove is exact.
      const braw = deps.fs.read(barrier);
      const bmeta = braw === null ? null : parseLockMeta(braw);
      if (braw !== null && barrierHeld(deps, bmeta)) {
        await deps.sleep(LOCK_POLL_MS); // another reclaimer is mid-steal — wait it out
        continue;
      }
      if (braw !== null) deps.fs.removeIfMatch(barrier, bmeta?.nonce ?? null); // stale/corrupt barrier
      if (!deps.fs.createExclusive(barrier, JSON.stringify({ pid, nonce, acquired_at: deps.now() }))) {
        await deps.sleep(LOCK_POLL_MS); // lost the barrier race — the winner reclaims
        continue;
      }
      try {
        deps.fs.removeIfMatch(path, existing?.nonce ?? null);
      } finally {
        deps.fs.removeIfMatch(barrier, nonce);
      }
      await deps.sleep(LOCK_POLL_MS); // yield — keeps a perpetually-reclaimable lock bounded
      continue;
    }
    await deps.sleep(LOCK_POLL_MS);
  }
}

/**
 * Is `handle` STILL the on-disk owner? The last-line defense (codex step-6 confirmation round):
 * every file-based lock protocol without OS advisory locks retains a vanishing-probability
 * window in which a reclamation race deletes a live holder's lock — the barrier shrinks it
 * recursively but cannot close it (compare-and-unlink does not exist on POSIX). Rather than
 * hand-roll further layers, the EXECUTOR re-verifies ownership at the point of actual hazard —
 * immediately before presenting the refresh token — and aborts without sending if the lock was
 * lost. This converts "two holders both present" into "the dispossessed holder aborts", bounding
 * the residual to the microseconds between this check and the send, where both contenders'
 * markers carry the IDENTICAL presented-token digest and the server's 60s proof-of-possession
 * grace makes near-simultaneous double-presentation converge.
 */
export function verifyLockOwnership(fs: LockFs, handle: LockHandle): boolean {
  const raw = fs.read(handle.path);
  if (raw === null) return false;
  return parseLockMeta(raw)?.nonce === handle.nonce;
}

/**
 * Release a held lock. Nonce-verified AND barrier-serialized: the release takes the reclamation
 * barrier ONE-SHOT so its verify→remove cannot race a reclaimer's (the same two-holder hazard,
 * from the other side). If the barrier is busy/present, the lock is LEFT in place — it is
 * dead-pid/stale-reclaimable, which is strictly safer than a racy unlink. Best-effort; never
 * throws (a release failure must not fail the command).
 */
export function releaseRefreshLock(fs: LockFs, handle: LockHandle, now: () => number, pid: number): void {
  try {
    const barrier = barrierPathFor(handle.path);
    if (!fs.createExclusive(barrier, JSON.stringify({ pid, nonce: handle.nonce, acquired_at: now() }))) {
      return; // a reclaimer holds the barrier — leave the lock to staleness reclamation
    }
    try {
      fs.removeIfMatch(handle.path, handle.nonce);
    } finally {
      fs.removeIfMatch(barrier, handle.nonce);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * The three-way marker verdict (A41/A42 — codex step-6 fix round). `corrupt` is DISTINCT from
 * `absent`: an existing-but-unreadable marker may be hiding a pending rotation, so the executor
 * must fail CLOSED on it (terminal re-auth, marker left) — collapsing it into `absent` would
 * re-present a possibly-rotated token and risk family revocation.
 */
export type MarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly marker: PendingMarker }
  | { readonly kind: "corrupt" };

/** `presented` must be exactly a SHA-256 hex digest — anything else is corruption, not identity. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Read the pending-refresh marker at `path` (absent | valid | corrupt — never a silent null). */
export function readMarker(fs: LockFs, path: string): MarkerRead {
  const raw = fs.read(path);
  if (raw === null) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "corrupt" };
  const { presented, deadline } = parsed as Record<string, unknown>;
  if (typeof presented !== "string" || !SHA256_HEX.test(presented)) return { kind: "corrupt" };
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return { kind: "corrupt" };
  return { kind: "valid", marker: { presented, deadline } };
}

/** Atomically persist the pending marker (A41 — written BEFORE the first send, cleared after store). */
export function writeMarker(fs: LockFs, path: string, marker: PendingMarker): void {
  fs.writeAtomic(path, JSON.stringify(marker));
}

/** Clear the pending marker (A41 — only after the rotated pair is durably stored). */
export function clearMarker(fs: LockFs, path: string): void {
  fs.remove(path);
}

// ── production seam implementations ────────────────────────────────────────────────────────

/** CSPRNG lock nonce (16 bytes hex). `randomBytes`, deliberately NOT the swept `randomUUID`. */
export function defaultNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Liveness probe for stale-lock reclamation (A43). `process.kill(pid, 0)` sends no signal — it
 * only checks existence/permission: no throw or EPERM ⇒ the pid is live (EPERM = alive but owned
 * by another user); ESRCH ⇒ dead ⇒ reclaimable.
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EPERM";
  }
}

/** Production `LockFs` over real fs: O_EXCL|O_NOFOLLOW 0600 create, atomic 0600 temp+rename writes. */
export function nodeLockFs(): LockFs {
  return {
    createExclusive(path, content) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      let fd: number;
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EEXIST") return false;
        throw err;
      }
      try {
        writeAll(fd, content);
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
    remove(path) {
      try {
        unlinkSync(path);
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
        throw err;
      }
    },
    writeAtomic(path, content) {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Temp is pid- + entropy-scoped so a concurrent writer never clobbers ours mid-rename.
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
      try {
        writeAll(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(tmp, path);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* best-effort cleanup */
        }
        throw err;
      }
      // Durability (A41): the RENAME itself must survive a power loss before the oauth.token
      // send this marker precedes — fsync the parent directory. POSIX-only: Windows cannot
      // open/fsync a directory (and its rename durability semantics differ); there the write
      // remains atomic-but-not-power-loss-durable, the pre-fix behavior.
      if (process.platform !== "win32") {
        const dfd = openSync(dir, constants.O_RDONLY);
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      }
    },
    removeIfMatch(path, nonce) {
      // Read-verify-unlink. NOT atomic by itself — the LockFs contract requires foreign-instance
      // removals to run under the reclamation barrier (acquire/release above), which excludes
      // every other remover while any mid-window creator abstains. Own-instance removals are
      // safe anywhere: no other party removes a live, fresh, non-observed instance.
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
        throw err;
      }
      const meta = parseLockMeta(raw);
      const matches = nonce === null ? meta === null : meta?.nonce === nonce;
      if (!matches) return;
      try {
        unlinkSync(path);
      } catch (err) {
        if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") return;
        throw err;
      }
    },
  };
}

function writeAll(fd: number, content: string): void {
  const buf = Buffer.from(content, "utf8");
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written, written);
  }
}
