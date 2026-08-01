// Atomic, symlink-safe skill install (T-209, canonical L2-CLI-19, deliverable 3 /
// ISS-570). This is the RUNTIME re-copy that keeps `~/.claude/skills/agkit/` in sync
// with the running binary: on every eligible (non-dev, non-mcp) invocation it
// self-seeds the skill tree and re-syncs it when the binary version moves past the
// installed marker. It has REAL side effects, so — like src/core/auth/insecure-file.ts
// — it is written paranoid: ALL fs is injected (so tests drive it with zero real I/O),
// the source is resolved from `import.meta.url` (never cwd) and allowlist+lstat
// validated, a complete tree is STAGED then swapped in by rename (crash-window
// recovery on the next run), and concurrent installs are serialized by an
// O_EXCL lock with stale-steal. The design maps 1:1 to the codex-hardened brief:
//   C1  source anchored to the emitted entry, allowlist + regular-file (lstat) checked
//   C2  cross-process O_EXCL lock, stale-lock steal, re-check marker AFTER locking
//   M3  a co-located `.agkit-skill-version` manifest travels INSIDE the tree
//   M8  downgrade-reject (never overwrite a newer install)
// Nothing here writes to stdout; the caller (preCommandHousekeeping) swallows throws.
//
// T-224 (`agkit setup`, plan D1 + amendments D1v2–D1v6) extends the engine on three axes,
// WITHOUT relaxing a single file-level guard (every open inside the tree stays O_NOFOLLOW):
//   D1   the dest LEAF (`~/.claude/skills/agkit`) may be a SYMLINK — stow/chezmoi park the
//        real tree elsewhere. T-209 renamed such a link wholesale aside and installed a real
//        dir over it; we now RESOLVE it (bounded lexical readlink walk, live and dangling
//        alike) and run the SAME staged swap against the real target, with staging + backup
//        as SIBLINGS OF THAT TARGET (a skillsDir sibling would be EXDEV across mounts). The
//        link itself is preserved. The lock stays in `~/.claude/skills/` — the canonical
//        entry point every racer agrees on, whatever the link points at.
//   D1v3a ONE classifier (`classifyDest`) decides absent / current / stale-managed /
//        unmanaged, with exactly ONE marker read and ONE interpretation. "Managed" is an
//        ALLOWLIST-SHAPE predicate that a valid marker can never bypass: an unmanaged dest
//        (a user's own files parked at the path) is REFUSED, never replaced.
//   D1v2/v3b/v4b/v5/v6 a `.agkit-txn.json` transaction record in the locked dir names the
//        exact {staging, backup, dest, token} of an in-flight swap, so crash recovery
//        completes or rolls back THOSE paths instead of prefix-scanning a parent it does not
//        own. The record is a HINT, never an authority: it is schema-, shape-, and
//        CONTENT-validated before any mutation, and anything that fails surfaces
//        `txn-unverifiable` — everything retained, nothing touched, manual attention.
// The fs PORT and the two read-only predicates (`resolveInstallTarget` / `classifyDest`) live
// in the sibling `dest-classify.ts` and are re-exported below, so this file stays the install
// LIFECYCLE (lock, recover, sweep, stage, swap) and the classification rules stay one module
// every reader and writer shares. Suites: install.test.ts + install-txn.test.ts.
import { basename, dirname, isAbsolute, join } from "node:path";
import { displayCapped } from "../output/display";
import {
  classifyDest,
  describeUnexpected,
  CUSTODY_SENTINEL,
  isAllowlistShaped,
  isAncestorOrSelf,
  isPublicationApartFromSentinel,
  isShapedApartFromSentinel,
  isCompleteTree,
  resolveInstallTarget,
  SKILL_DIR_NAME,
  SKILL_FILE_ALLOWLIST,
  SKILL_VERSION_MANIFEST,
  skillDestPath,
  skillsDirPath,
  type FsHandle,
  type FsStat,
  type InstallFs,
  type UnexpectedEntries,
} from "./dest-classify";
import { IS_DEV } from "../../version";

// The port + the classification rules live in `dest-classify.ts` (one place, no dependency on
// the install lifecycle). They are re-exported HERE so every existing `from "./install"`
// import — node-fs.ts, core/mcp/registration.ts, selftest, the suites — stays byte-valid.
export {
  classifyDest,
  // T-224: `setup`'s check arm renders the same bounded, sanitized unexpected-entry sample the
  // installer's own refusal does — one renderer, so the two can never describe the tree differently.
  describeUnexpected,
  resolveInstallTarget,
  SKILL_DIR_NAME,
  SKILL_FILE_ALLOWLIST,
  SKILL_VERSION_MANIFEST,
  skillDestPath,
  skillsDirPath,
} from "./dest-classify";
export { CUSTODY_SENTINEL };
export type {
  DestClassification,
  DestResolution,
  FsHandle,
  FsStat,
  InstallFs,
  UnexpectedEntries,
} from "./dest-classify";

/** The cross-process install lock (O_EXCL) under `~/.claude/skills/`. */
export const INSTALL_LOCK_NAME = ".agkit-install.lock";
/** Leading-dot prefixes so a skills scanner ignores our transient dirs. */
export const STAGING_PREFIX = ".agkit-staging-";
export const BACKUP_PREFIX = ".agkit-bak-";
/** A stale lock atomically moved aside during a steal (swept next run). */
export const STALE_ASIDE_PREFIX = ".agkit-stalelock-";
/**
 * The crash-recovery transaction record (D1v2 major-8). It lives in the CANONICAL locked
 * dir (`~/.claude/skills/`) — NOT beside the resolved target — because that is the one
 * location every racer reaches without first trusting a link, and it is the dir the lock
 * already serializes. Its presence also DISABLES the unlocked fast path (D1v3c).
 */
export const TXN_RECORD_NAME = ".agkit-txn.json";

/** A held lock older than this (ms) is presumed abandoned and stolen. */
export const STALE_LOCK_MS = 60_000;

/** Hard byte cap on the transaction record we will even parse (untrusted disk bytes). */
const TXN_MAX_BYTES = 4096;
/** The token charset we mint (`<pid>-<ms>-<counter>`); a record naming anything else is forged. */
const TXN_TOKEN_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Everything installSkill needs — all injected (no `process`, no cwd, no real fs). */
export interface InstallDeps {
  /** The resolved `skill/` source dir (from import.meta.url; NO cwd fallback — C1). */
  readonly sourceDir: string;
  /** The OS home dir; skills install under `<homeDir>/.claude/skills/`. */
  readonly homeDir: string;
  /** The running binary VERSION — stamped into the manifest + compared for re-sync. */
  readonly version: string;
  /** The process pid (staging/backup name uniqueness). */
  readonly pid: number;
  /** ms clock (stale-lock detection + staging name uniqueness). */
  readonly now: () => number;
  readonly fs: InstallFs;
}

export type InstallStatus =
  | "installed" // staged a fresh tree and swapped it in
  | "current" // already up-to-date (fast path, before locking)
  | "current-after-lock" // another invocation installed while we held/awaited the lock
  | "locked" // could not acquire the lock; another install is in flight
  | "source-invalid" // resolved source failed allowlist / regular-file validation
  | "dest-unresolvable" // the dest leaf link loops / is unreadable / lands on a non-directory
  | "unmanaged-dest" // the dest tree is NOT ours (D1v3a) — refused, zero mutation
  | "txn-unverifiable"; // an interrupted install's record failed validation (D1v3b/v5/v6)

/** The paths a `"txn-unverifiable"` refusal RETAINS for manual attention (D1v3b). */
export interface TxnPaths {
  readonly record: string;
  /** Absent when the record itself failed schema/shape validation (no trustworthy paths). */
  readonly staging?: string;
  readonly backup?: string;
  readonly dest?: string;
}

export interface InstallResult {
  readonly status: InstallStatus;
  /** An honest, display-sanitized reason. Present ONLY on the refusal statuses. */
  readonly detail?: string;
  /** Present ONLY on `"unmanaged-dest"`. */
  readonly unexpected?: UnexpectedEntries;
  /** Present ONLY on `"txn-unverifiable"`. Raw paths (JSON `data` escapes them). */
  readonly txn?: TxnPaths;
  /**
   * Present ONLY on `"current"` / `"current-after-lock"`: the version the on-disk marker ACTUALLY
   * carries — equal to the running version, or NEWER under downgrade-reject (M8). A caller that
   * labels a current tree must label it with THIS, not with its own version.
   */
  readonly installedVersion?: string;
}

/** Monotonic in-process counter — disambiguates two staging dirs created in the same ms. */
let stagingCounter = 0;

/**
 * Install (or re-sync) the skill tree. Returns a status; NEVER throws for an ordinary
 * "already current" / "someone else is installing" outcome. A genuinely failed copy
 * throws (caught by the caller) and simply stays retryable on the next invocation — no
 * success is ever claimed before the complete tree is published (deliverable 4 / D4).
 */
export function installSkill(deps: InstallDeps): InstallResult {
  const { fs } = deps;
  const skillsDir = skillsDirPath(deps.homeDir);
  // The LOGICAL dest: the path the user (and every racer) names. It may itself be a symlink;
  // `resolveInstallTarget` turns it into the REAL directory we stage against (D1).
  const link = join(skillsDir, SKILL_DIR_NAME);
  const lock = join(skillsDir, INSTALL_LOCK_NAME);
  const record = join(skillsDir, TXN_RECORD_NAME);

  fs.mkdir(skillsDir, DIR_MODE);

  // Fast path (no lock): the overwhelmingly common case is "already current". D1v3c makes it
  // conditional — a transaction record means some install was INTERRUPTED, and an interrupted
  // install's tree must be recovered UNDER the lock before any "current" verdict is believed.
  if (fs.lstat(record) === null) {
    const quick = resolveInstallTarget(fs, link);
    if (quick.ok) {
      const cls = classifyDest(fs, quick.path, deps.version);
      if (cls.status === "current") return { status: "current", installedVersion: cls.installedVersion };
    }
  }

  // C2: serialize the actual install. If we can't get the lock, another invocation is
  // installing — skip (it will publish the tree; we re-sync on a later invocation).
  if (!acquireLock(deps, skillsDir, lock)) return { status: "locked" };
  try {
    // D1v3c lifecycle, in order. (1) Recover the RECORDED transaction first: it is the only
    // authority on an interrupted swap, and it must run before the blind prefix sweep below
    // could delete a staging/backup the record still needs.
    const unverifiable = recoverTransaction(deps, link, record);
    if (unverifiable !== null) return unverifiable; // retain everything, touch NOTHING
    // (2) Legacy prefix sweep: pre-T-224 installs left transient dirs with no record.
    cleanTransientDirs(fs, skillsDir);
    // (3) Resolve the leaf, then classify — the SAME classifier the fast path just used.
    const resolved = resolveInstallTarget(fs, link);
    if (!resolved.ok) {
      return {
        status: "dest-unresolvable",
        detail: `refusing to install at ${displayCapped(link, 200)}: ${resolved.reason} (${displayCapped(resolved.path, 200)})`,
      };
    }
    const dest = resolved.path;
    const cls = classifyDest(fs, dest, deps.version);
    // (4) Re-check UNDER the lock (C2): a racer may have just installed our exact version.
    if (cls.status === "current") return { status: "current-after-lock", installedVersion: cls.installedVersion };
    // A tree that is not ours is NEVER replaced (D1v3a) — a valid marker cannot buy a pass.
    if (cls.status === "unmanaged") {
      return {
        status: "unmanaged-dest",
        detail: `refusing to replace ${displayCapped(dest, 200)}: it is not an agkit skill tree (${describeUnexpected(cls.unexpected)})`,
        unexpected: cls.unexpected,
      };
    }
    // C1, gating the ONLY step that reads the source: refuse a source that is not exactly
    // the allowlisted set of REGULAR files. Everything above — the fast path, recovery, the
    // refusals — needs NO source bytes, so a damaged bundled source can never strand a
    // recoverable installation: the recorded backup restores without it.
    if (!validateSource(fs, deps.sourceDir)) return { status: "source-invalid" };
    // (5) Choose token+paths, write the record, stage, swap, remove the record.
    stageAndSwap(deps, dest, record);
    return { status: "installed" };
  } finally {
    fs.unlink(lock);
  }
}

/** C1: every allowlisted name must exist in `sourceDir` as a NON-symlink REGULAR file. */
function validateSource(fs: InstallFs, sourceDir: string): boolean {
  const dir = fs.lstat(sourceDir);
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory()) return false;
  for (const name of SKILL_FILE_ALLOWLIST) {
    const st = fs.lstat(join(sourceDir, name));
    if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  }
  return true;
}

/** The freshness classification selftest check 7 reports (no re-sync, no mutation). */
export type SkillFreshnessStatus = "current" | "stale" | "absent" | "dev";

export interface SkillFreshness {
  readonly status: SkillFreshnessStatus;
  /** The installed manifest version, or null (absent / no marker / unparseable marker / dev). */
  readonly installed: string | null;
}

/**
 * A READ-ONLY freshness view of the installed skill tree (T-222 6a-ii, selftest check 7).
 * It consumes the SAME `resolveInstallTarget` + `classifyDest` pair the atomic installer
 * uses — so the diagnostic can never disagree with the installer (D1v3a crit-4) — and it
 * NEVER mutates disk.
 *   • `dev`     — a dev build (sync disabled; `IS_DEV`, or the injected `opts.isDev`).
 *   • `absent`  — nothing installed: no dest, a DANGLING leaf link, or a leaf we refuse to
 *                 resolve (a loop, or a link landing on a non-directory). Honest: nothing is
 *                 installed there, and `--check` reports drift rather than a usage error.
 *   • `current` — the installed tree is complete and at a version we must NOT overwrite
 *                 (equal, or NEWER per the M8 downgrade-reject) — INCLUDING through a
 *                 followed leaf symlink, which T-209 could never report as current (D1).
 *   • `stale`   — a dest directory exists but is older / incomplete / marker-less, OR it is
 *                 UNMANAGED (not ours). Both are "not converged"; the apply leg then either
 *                 re-syncs or refuses honestly.
 * `installed` carries the trimmed manifest version when present AND parseable (null otherwise).
 */
export function skillFreshness(
  fs: InstallFs,
  homeDir: string,
  version: string,
  opts?: { readonly isDev?: boolean },
): SkillFreshness {
  if (opts?.isDev ?? IS_DEV) return { status: "dev", installed: null };
  const resolved = resolveInstallTarget(fs, skillDestPath(homeDir));
  if (!resolved.ok) return { status: "absent", installed: null };
  const cls = classifyDest(fs, resolved.path, version);
  switch (cls.status) {
    case "absent":
      return { status: "absent", installed: null };
    case "current":
      return { status: "current", installed: cls.installedVersion };
    case "stale-managed":
      return { status: "stale", installed: cls.installedVersion };
    case "unmanaged":
      return { status: "stale", installed: null };
  }
}

/**
 * The freshness view `agkit setup` (and `setup --check`) consume (D2v2). An explicit
 * `agkit setup` is a PROVISIONING REQUEST, not a hot path, so it judges the REAL marker
 * bytes even on a dev build — `isDev: false` is pinned here rather than left to the caller,
 * so setup and `--check` can never disagree about what "installed" means. Selftest keeps the
 * DEFAULT behavior (`skillFreshness` with the build-time `IS_DEV`).
 *
 * Dev-build note, corrected against ground truth: plan D2 assumed a `0.0.0-dev` marker would
 * fail `isValidVersion` and force a re-stage every run. It does NOT — `version-util`'s
 * `coreParts` splits on `[-+]` and compares the NUMERIC CORE, so `0.0.0-dev` is a valid
 * `0.0.0` and equals a dev binary's own version. So `agkit setup` on a dev build installs
 * once and then honestly converges, instead of churning the tree on every invocation.
 */
export function setupSkillFreshness(fs: InstallFs, homeDir: string, version: string): SkillFreshness {
  return skillFreshness(fs, homeDir, version, { isDev: false });
}

/**
 * Acquire the O_EXCL lock, stealing it if the holder's file is stale (C2). The O_EXCL
 * `tryCreateLock` is the PRIMARY mutex; the steal is recovery for a CRASHED installer's
 * abandoned lock. The steal moves the stale lock aside by rename THEN O_EXCL-creates a
 * fresh one: the COMMON concurrent-steal is handled cleanly — two racers that both see
 * the same stale lock both try `rename(lock, aside)`, but only one succeeds and the loser
 * gets ENOENT and skips (strictly better than a plain unlink+create steal, where both
 * unlink then both create). The 60s threshold is >> a real install (6 tiny files, ms), so
 * a LIVE install's own lock is never stealable mid-flight.
 *
 * RESIDUAL (honest): rename replaces whatever is at `lock` NOW, so if a racer creates a
 * fresh lock in the microseconds between our `lstat` and our `rename`, we can steal that
 * fresh lock and both proceed. Node exposes no portable RENAME_NOREPLACE/renameat2 to
 * bind the steal to the observed inode, so this window is irreducible here — but it is
 * BENIGN: concurrent installers stage into UNIQUE dirs and publish byte-IDENTICAL trees,
 * so the worst case is redundant work + a backup dir swept on the next run, never a
 * corrupt or partial tree (see stageAndSwap). This is best-effort housekeeping — the
 * caller swallows throws and a racy run simply retries next invocation.
 */
function acquireLock(deps: InstallDeps, skillsDir: string, lock: string): boolean {
  const { fs } = deps;
  if (fs.tryCreateLock(lock, FILE_MODE)) return true;
  const st = fs.lstat(lock);
  // A fresh lock -> another live installer (skip). A symlink where the lock should be ->
  // refuse to touch (skip). Only a real, stale, non-symlink lock is stealable.
  if (!st || st.isSymbolicLink() || deps.now() - st.mtimeMs <= STALE_LOCK_MS) return false;
  const aside = join(skillsDir, `${STALE_ASIDE_PREFIX}${deps.pid}-${deps.now()}-${stagingCounter++}`);
  try {
    fs.rename(lock, aside); // atomic — exactly one racer moves this inode aside
  } catch {
    return false; // another racer already stole/replaced it — let them win
  }
  try {
    fs.rmrf(aside); // discard the stolen stale lock (else swept by cleanTransientDirs)
  } catch {
    /* leftover aside is swept on the next run */
  }
  return fs.tryCreateLock(lock, FILE_MODE); // single fresh-create attempt
}

/** Remove any leftover `.agkit-staging-*` / `.agkit-bak-*` / `.agkit-stalelock-*` (runs UNDER the lock). */
function cleanTransientDirs(fs: InstallFs, skillsDir: string): void {
  for (const name of fs.readdir(skillsDir)) {
    if (
      name.startsWith(STAGING_PREFIX) ||
      name.startsWith(BACKUP_PREFIX) ||
      name.startsWith(STALE_ASIDE_PREFIX)
    ) {
      fs.rmrf(join(skillsDir, name));
    }
  }
}

/**
 * Build a COMPLETE tree in a uniquely-named staging dir (allowlisted regular files +
 * the manifest), then swap it into place with rename. If a dest exists it is first
 * renamed to a backup; a failure to move staging into place restores the backup so we
 * never leave dest missing. The old backup is best-effort removed (else recovered next run).
 *
 * T-224 D1: `dest` is the RESOLVED target, and staging + backup are its SIBLINGS — with a
 * followed leaf link the real tree can live on a different filesystem, where a skillsDir
 * sibling would make every rename EXDEV. Siblings of the target keep all three renames
 * same-filesystem and therefore atomic.
 *
 * T-224 D1v2/D1v3c: the transaction record is written BEFORE the first mutation and removed
 * LAST, so a crash at any point leaves a record naming the exact three paths. It is removed
 * only when NOTHING is left for recovery to finish: a surviving backup (the sole copy of the
 * old tree, or one we failed to delete) or a surviving staging dir keeps the record alive.
 */
function stageAndSwap(deps: InstallDeps, dest: string, recordPath: string): void {
  const { fs } = deps;
  const parent = dirname(dest);
  const token = `${deps.pid}-${deps.now()}-${stagingCounter++}`;
  const staging = join(parent, STAGING_PREFIX + token);
  const backup = join(parent, BACKUP_PREFIX + token);

  // O_EXCL + 0600 (writeNew): if a record is somehow already there we throw rather than
  // overwrite another install's transaction. Outside the try — there is nothing to undo yet.
  fs.writeNew(recordPath, JSON.stringify({ staging, backup, dest, token }) + "\n", FILE_MODE);

  let backupLive = false; // a backup exists that only recovery can now resolve
  // Custody is a claim about a NODE, not a path — and a path-read identity cannot survive an
  // unlink, because inode numbers are recycled. So custody is PINNED: a sentinel file we create
  // exclusively inside staging and hold OPEN. While the handle lives its inode cannot be reused,
  // so a matching lstat is proof, not a coincidence. Released before publication; a sweep with
  // no live proof RETAINS rather than deletes.
  const sentinelPath = join(staging, CUSTODY_SENTINEL);
  let custody: FsHandle | null = null;
  let everHeld = false; // did WE ever create this staging dir? (a squatter means we never did)
  /**
   * Rename staging into place and PROVE what landed is ours — the check the rename itself cannot
   * make, because rename resolves a PATH. The sentinel travels inside the directory, so after the
   * swap it sits at `dest/.agkit-custody`; if that node still carries our pinned id, the tree we
   * published is the tree we built. Verified on BOTH sides: before, so a substituted directory is
   * almost never published at all, and after, so that when it is (the one-syscall window rename
   * leaves open) we find out and the backup is never deleted on a tree we cannot vouch for.
   */
  const publish = (): void => {
    if (custody === null || fs.lstat(sentinelPath)?.id !== custody.id) {
      throw new Error("refusing to publish: the staged tree is no longer the one we built");
    }
    fs.rename(staging, dest);
    const landed = join(dest, CUSTODY_SENTINEL);
    if (fs.lstat(landed)?.id !== custody.id) {
      // Substituted inside the rename window. dest now holds a tree we cannot vouch for, so
      // NOTHING is deleted: the backup and the record both outlive us and recovery decides.
      throw new Error("published tree failed the custody check: dest is not the tree we staged");
    }
    fs.unlink(landed); // unlinked while still pinned, then the pin drops — never survives a publish
    custody.close();
    custody = null;
  };
  try {
    fs.mkdir(parent, DIR_MODE);
    // EXCLUSIVE creation (custody gate): a node already at the freshly-minted staging path —
    // a squatter, or a token collision with a crashed run — is never adopted and never later
    // deleted; the EEXIST throw refuses the install and leaves the node exactly as found.
    fs.mkdirExclusive(staging, DIR_MODE);
    custody = fs.openExclusive(sentinelPath, FILE_MODE);
    everHeld = true;
    for (const name of SKILL_FILE_ALLOWLIST) {
      fs.copyFile(join(deps.sourceDir, name), join(staging, name), FILE_MODE);
    }
    fs.writeNew(join(staging, SKILL_VERSION_MANIFEST), deps.version + "\n", FILE_MODE);

    const existing = fs.lstat(dest);
    if (existing) {
      fs.rename(dest, backup); // move the OLD tree aside — never traversed
      backupLive = true;
      try {
        publish();
      } catch (err) {
        // Swap failed: put the old tree back so dest is never left absent.
        try {
          fs.rename(backup, dest);
          backupLive = false;
        } catch {
          /* the backup is now the ONLY copy of the tree — the retained record restores it */
        }
        throw err;
      }
      try {
        fs.rmrf(backup); // success — the old tree is now dead weight
        backupLive = false;
      } catch {
        /* retained record: the next run's recovery removes it (S∄/D∃/B∃) */
      }
    } else {
      publish();
    }
  } finally {
    // If we threw before/after the swap, a partial staging dir may remain — clean it. On
    // success staging was renamed to dest, so the path is already gone and there is nothing
    // to sweep. Custody gates the sweep THREE ways (D1v5 parity with recovery), because the
    // record published this path before the directory existed and the window between creating
    // it and arriving here is a window a racer can use:
    //   (1) we still HOLD the custody handle — past `releaseCustody` we have no proof at all,
    //       so a swap that failed after publication began retains rather than guesses;
    //   (2) the sentinel at its path is still OUR pinned file — id equal to the handle's. This
    //       is the part a path-read id cannot do: the open handle makes the inode unrecyclable,
    //       so a racer who unlinked our directory cannot reproduce this match at any price; and
    //   (3) the directory's content still reads as ours — what remains on a filesystem that
    //       reports no usable inode, and what catches a racer writing INTO our staging dir.
    // Anything else is RETAINED with its record, for recovery to refuse over. Deleting a
    // directory we cannot prove we own is the one outcome this whole dance exists to prevent.
    let leftover = backupLive;
    if (custody !== null) {
      if (fs.lstat(sentinelPath)?.id !== custody.id || !isShapedApartFromSentinel(fs, staging)) {
        leftover = true;
      } else {
        try {
          fs.rmrf(staging);
        } catch {
          leftover = true; // staging survived — the record must outlive us so recovery sweeps it
        }
      }
      custody.close();
    } else if (everHeld && fs.lstat(staging) !== null) {
      // We created it and the handle is gone, which past `publish` means the swap SUCCEEDED —
      // so anything still answering to the staging name is not the directory we published.
      // Retain: recovery re-decides under the lock, by content. (`everHeld` matters: when a
      // SQUATTER took the path, `mkdirExclusive` threw and nothing here is ours at all, so the
      // record must still be dropped and the next run re-mints a fresh token and converges.)
      leftover = true;
    }
    if (!leftover) fs.unlink(recordPath);
  }
}

/** The validated shape of `.agkit-txn.json`. EXACTLY these four members, all strings. */
interface TxnRecord {
  readonly staging: string;
  readonly backup: string;
  readonly dest: string;
  readonly token: string;
}

/**
 * Remove a custody sentinel stranded inside `dest` — but ONLY on proof that dest is a complete
 * publication of ours once that one name is set aside. The proof is the authority: it is what
 * makes the file ours to delete, and without it we touch nothing at all.
 *
 * Why this exists: publication holds the sentinel across the rename and drops it two syscalls
 * later, so a crash in that window strands it in dest. Every predicate downstream —
 * `classifyDest` above all — then reads our own file as an unexpected entry and calls the tree
 * unmanaged, permanently: no run could ever recover, over a file we wrote ourselves.
 *
 * Why it is not a blanket sweep (relay addendum4 D1, CRITICAL): the transaction record is a
 * HINT, never an authority, and an earlier draft unlinked by name from both recorded paths
 * before any of them had been validated. That both mutated pre-authority and — worse —
 * MANUFACTURED the allowlist shape the very next predicate tests, turning a directory that
 * would rightly have been refused as "not ours" into one the state table then deleted.
 */
function settleDestSentinel(fs: InstallFs, dest: string): void {
  const path = join(dest, CUSTODY_SENTINEL);
  const st = fs.lstat(path);
  if (st === null || st.isSymbolicLink() || !st.isFile()) return;
  if (!isPublicationApartFromSentinel(fs, dest)) return;
  fs.unlink(path);
}

/**
 * Complete or roll back an INTERRUPTED install (D1v2 major-8, as amended by D1v3b, D1v3c,
 * D1v4b, D1v5, D1v6). Runs UNDER the lock, BEFORE the legacy prefix sweep, and before any
 * classification of the dest.
 *
 * The record is a HINT, NEVER an authority. Anyone who can write `~/.claude/skills/` can
 * plant one, so it earns nothing until it survives, in order and BEFORE ANY MUTATION:
 *   1. a regular-file, O_NOFOLLOW, size-capped read;
 *   2. a strict schema (exactly {staging, backup, dest, token}, non-empty strings);
 *   3. a strict path SHAPE — staging/backup are `dirname(dest)` siblings carrying the exact
 *      prefixes plus the ONE shared token, dest wears the expected basename, no path is the
 *      root / homeDir / an ancestor of homeDir, and none is an ancestor of another;
 *   4. a re-resolution of the CURRENT leaf link that still lands on the recorded dest;
 *   5. an lstat type check on each recorded path (a directory, or absent — never a file or
 *      a symlink);
 *   6. a CONTENT check (D1v5): a present staging or backup must be ALLOWLIST-SHAPED before
 *      we would delete or restore it, and — in the one arm that deletes a backup — dest must
 *      be a COMPLETE publication (D1v6), because publish-rename is atomic and every genuine
 *      post-publish crash therefore leaves dest complete.
 * Staging is deliberately NOT required to be complete: a mid-stage crash legitimately leaves
 * a partial tree, and a partial staging dir must stay removable (calibration recorded in the
 * plan as a deliberate deviation from the reviewer's "complete tree with valid marker").
 *
 * ANY failure returns `txn-unverifiable`: all three paths AND the record are RETAINED,
 * nothing is touched, and the caller surfaces it (setup refuses the leg naming the record;
 * housekeeping soft-skips and retries next run). Returns null when there was nothing to
 * recover, or when recovery completed and the record was removed.
 */
function recoverTransaction(deps: InstallDeps, link: string, recordPath: string): InstallResult | null {
  const { fs } = deps;
  const recSt = fs.lstat(recordPath);
  if (recSt === null) return null; // no interrupted install
  if (recSt.isSymbolicLink() || !recSt.isFile()) {
    return unverifiable(recordPath, "the transaction record is not a regular file");
  }

  const text = fs.readUtf8(recordPath);
  if (text === null) return unverifiable(recordPath, "the transaction record is unreadable");
  if (Buffer.byteLength(text, "utf8") > TXN_MAX_BYTES) {
    return unverifiable(recordPath, "the transaction record is oversized");
  }

  const rec = parseTxnRecord(text);
  if (rec === null) return unverifiable(recordPath, "the transaction record failed schema validation");
  if (!txnPathsWellFormed(rec, deps.homeDir)) {
    return unverifiable(recordPath, "the transaction record's paths failed validation", rec);
  }

  // The link may have been re-pointed since the crash (a dotfiles manager retarget, or a
  // hostile edit). A record whose dest is no longer where the leaf lands describes a tree we
  // have no business touching.
  const resolved = resolveInstallTarget(fs, link);
  if (!resolved.ok || resolved.path !== rec.dest) {
    return unverifiable(recordPath, "the skill dest no longer resolves to the recorded path", rec);
  }

  const stagingSt = fs.lstat(rec.staging);
  const backupSt = fs.lstat(rec.backup);
  const destSt = fs.lstat(rec.dest);
  if (!isDirOrAbsent(stagingSt)) return unverifiable(recordPath, "the recorded staging path is not a directory", rec);
  if (!isDirOrAbsent(backupSt)) return unverifiable(recordPath, "the recorded backup path is not a directory", rec);
  if (!isDirOrAbsent(destSt)) return unverifiable(recordPath, "the recorded dest path is not a directory", rec);

  const hasStaging = stagingSt !== null;
  const hasDest = destSt !== null;
  const hasBackup = backupSt !== null;

  // D1v5 — prove ownership BY CONTENT before any arm may delete or restore these.
  // Staging is judged with the sentinel SET ASIDE rather than swept: every arm that acts on
  // staging removes the whole directory anyway, so tolerating the name costs nothing and buys
  // the thing that matters — recovery never mutates a path before it has the authority to.
  // (Backup is NOT tolerant: a dest carrying a sentinel classifies as unmanaged, so setup
  // refuses long before such a tree could ever be renamed aside into a backup.)
  if (hasStaging && !isShapedApartFromSentinel(fs, rec.staging)) {
    return unverifiable(recordPath, "the recorded staging dir holds entries that are not ours", rec);
  }
  if (hasBackup && !isAllowlistShaped(fs, rec.backup)) {
    return unverifiable(recordPath, "the recorded backup dir holds entries that are not ours", rec);
  }

  // The state table (D1v3c + D1v4b) — exhaustive over all 8 (staging, dest, backup) shapes.
  if (hasStaging && hasDest && hasBackup) {
    // Genuinely inconsistent: no single crash window produces all three at once.
    return unverifiable(recordPath, "staging, dest and backup are ALL present", rec);
  }

  // ONLY here may a stranded sentinel be settled — every validation above has passed and no
  // `unverifiable` return remains ahead of us, so `txn-unverifiable`'s promise (everything
  // retained, NOTHING touched) still means what it says. The state must also be consistent
  // with a completed publication: dest present and staging GONE, which is what publication
  // leaves. A sentinel in dest while staging still stands describes no crash window we can
  // produce, so it earns nothing (relay addendum5 E1). This runs before the arms below and
  // before `classifyDest` at install time, either of which would otherwise read our own file
  // as an unexpected entry and call the tree unmanaged, permanently.
  if (hasDest && !hasStaging) settleDestSentinel(fs, rec.dest);

  if (hasStaging && hasDest) {
    fs.rmrf(rec.staging); // crashed BEFORE the swap — dest was never disturbed
  } else if (hasStaging && hasBackup) {
    fs.rename(rec.backup, rec.dest); // crashed BETWEEN the two renames — roll back
    fs.rmrf(rec.staging);
  } else if (hasDest && hasBackup) {
    // Crashed AFTER the publish rename, before the backup was removed. Deleting a backup is
    // the one irreversible act here, so dest must prove the publication actually COMPLETED
    // (D1v6). `current` already implies complete+valid-marker; an OLDER complete tree is
    // equally valid evidence — an old CLI may be recovering a newer CLI's publication, and
    // downgrade policy is classifyDest's job at install time, not recovery's. Anything else
    // (partial tree, junk marker, unmanaged, absent) keeps BOTH.
    const cls = classifyDest(fs, rec.dest, deps.version);
    const completePublication =
      cls.status === "current" ||
      (cls.status === "stale-managed" && cls.installedVersion !== null && isCompleteTree(fs, rec.dest));
    if (!completePublication) {
      return unverifiable(recordPath, "the recorded dest is not a complete publication", rec);
    }
    fs.rmrf(rec.backup);
  } else if (hasBackup) {
    fs.rename(rec.backup, rec.dest); // crashed mid-swap with staging already gone — roll back
  } else if (hasStaging) {
    fs.rmrf(rec.staging); // originally-ABSENT dest, crashed before the publish rename
  }
  // hasDest && !hasStaging && !hasBackup → SETTLED (D1v4b): the publish completed and the
  // backup was already removed, or we crashed after writing the record but before staging
  // with an originally-present dest. Either way dest is authoritative — touch it NOT AT ALL
  // and let classifyDest decide below whether an install still needs to run.
  // nothing present at all → there is simply nothing to undo.

  fs.unlink(recordPath);
  return null;
}

/** A recorded path must be a directory or absent — a file or symlink there is not our doing. */
function isDirOrAbsent(st: FsStat | null): boolean {
  return st === null || (!st.isSymbolicLink() && st.isDirectory());
}

/** Strict schema gate: EXACTLY the four members, every one a non-empty string. */
function parseTxnRecord(text: string): TxnRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const fields = ["staging", "backup", "dest", "token"] as const;
  if (Object.keys(obj).length !== fields.length) return null; // no extra members
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) return null;
    const value = obj[field];
    if (typeof value !== "string" || value.length === 0) return null;
  }
  return {
    staging: obj.staging as string,
    backup: obj.backup as string,
    dest: obj.dest as string,
    token: obj.token as string,
  };
}

/**
 * The path-SHAPE gate (D1v3b). Everything a forged record could aim at is rejected here,
 * before a single lstat decides an arm: non-absolute or non-canonical paths (`..`, `.`,
 * trailing separators), a token we would never mint, staging/backup that are not
 * `dirname(dest)` siblings carrying our exact prefixes + the ONE shared token, a dest whose
 * basename is not the skill dir, the filesystem root, homeDir or any ancestor of it, and any
 * pair where one path contains another.
 */
function txnPathsWellFormed(rec: TxnRecord, homeDir: string): boolean {
  const { staging, backup, dest, token } = rec;
  if (!TXN_TOKEN_SHAPE.test(token)) return false;
  for (const path of [staging, backup, dest]) {
    // Absolute AND canonical: `join(dirname, basename)` normalises away `.`/`..`/`//` and a
    // trailing separator, so a path that survives round-tripping carries no traversal.
    if (!isAbsolute(path) || path !== join(dirname(path), basename(path))) return false;
    if (dirname(path) === path) return false; // never the filesystem root
    if (isAncestorOrSelf(path, homeDir)) return false; // never homeDir or one of its ancestors
  }
  if (basename(dest) !== SKILL_DIR_NAME) return false;
  if (basename(staging) !== STAGING_PREFIX + token) return false;
  if (basename(backup) !== BACKUP_PREFIX + token) return false;
  const parent = dirname(dest);
  if (dirname(staging) !== parent || dirname(backup) !== parent) return false;
  // Implied by the shapes above; asserted anyway so the containment invariant is explicit.
  for (const [a, b] of [
    [staging, dest],
    [backup, dest],
    [staging, backup],
  ] as const) {
    if (isAncestorOrSelf(a, b) || isAncestorOrSelf(b, a)) return false;
  }
  return true;
}

/** The `txn-unverifiable` refusal: RETAIN everything (record included), touch nothing. */
function unverifiable(record: string, why: string, rec?: TxnRecord): InstallResult {
  const paths: TxnPaths =
    rec === undefined
      ? { record }
      : { record, staging: rec.staging, backup: rec.backup, dest: rec.dest };
  return {
    status: "txn-unverifiable",
    detail: `${why} (${displayCapped(record, 200)}): nothing was touched — resolve it manually`,
    txn: paths,
  };
}
