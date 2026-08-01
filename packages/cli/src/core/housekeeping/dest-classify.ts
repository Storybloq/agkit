// The skill-tree PORT + the two read-only predicates every writer and every reader agrees on
// (T-224 D1 / D1v3a / D1v4a / D1v5b). Split out of install.ts so the classification rules live
// in ONE place with no dependency on the install lifecycle: `install.ts`, `skillFreshness`,
// the transaction-recovery gate, and `setup --check`'s drift report all import from here, and
// install.ts re-exports the whole surface so every existing `from "./install"` import stays
// byte-valid.
//
// Two functions carry the whole contract:
//   • `resolveInstallTarget` — where the tree ACTUALLY lives, once the dest leaf's symlink (if
//     any) has been walked. Purely lexical over lstat + readlink; never opens anything.
//   • `classifyDest` — absent / current / stale-managed / unmanaged, with EXACTLY ONE marker
//     read and ONE interpretation, so a freshness diagnostic can never disagree with what the
//     installer would actually do to the tree.
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { compareVersions, isValidVersion } from "./version-util";
import { displayCapped } from "../output/display";

/** The EXACT set of files a valid skill tree contains. Nothing else is copied. */
export const SKILL_FILE_ALLOWLIST = [
  "SKILL.md",
  "auth-bootstrap.md",
  "plan-apply.md",
  "init-flow.md",
  "json-recipes.md",
  "reference.md",
] as const;

/** The version manifest co-located INSIDE the installed tree (M3): bytes+version travel together. */
export const SKILL_VERSION_MANIFEST = ".agkit-skill-version";
/** The installed skill dir name under `~/.claude/skills/`. */
export const SKILL_DIR_NAME = "agkit";

/** Every name an agkit-managed tree may contain. Anything else makes the tree UNMANAGED. */
const MANAGED_NAMES: ReadonlySet<string> = new Set<string>([...SKILL_FILE_ALLOWLIST, SKILL_VERSION_MANIFEST]);

/** Symlink hops walked resolving the dest leaf before we refuse (cpm `resolveSymlinkTarget` parity). */
const MAX_SYMLINK_DEPTH = 40;
/** How many unexpected entry names ride a refusal (D-detail-sanitize-v2). */
const UNEXPECTED_SAMPLE_MAX = 5;
/** Per-name render bound inside a sanitized sample. */
const UNEXPECTED_NAME_MAX = 80;

/** Minimal stat surface (subset of fs.Stats) the install logic needs. */
export interface FsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mtimeMs: number;
  /**
   * The node's identity — device + inode. A PATH is not an identity: it can be unlinked and
   * re-created between any two calls, so "I created this directory" and "this directory is still
   * the one I created" are different claims, and this is what distinguishes them. The real port
   * reads both as 64-bit bigints, so no rounding can make two distinct LIVE nodes compare equal.
   *
   * WHAT IT DOES NOT PROVE. An inode number is unique only while the inode is ALLOCATED; once a
   * node is unlinked the kernel may hand the same number to the next one. So a matching id proves
   * "not a different LIVE node" — never "the same node across an unlink". Anything that must
   * survive that window reads the id off a HELD `FsHandle` instead, whose open descriptor makes
   * the inode unrecyclable for as long as it is held; a directory borrows that guarantee from a
   * sentinel file opened inside it, since only regular-file handles are portable.
   *
   * And where a filesystem supplies no real inode at all (some Windows/network volumes report 0)
   * this degenerates to a constant, so no custody decision rests on it alone: every caller pairs
   * it with a content check, which is exactly what remains there.
   */
  readonly id: string;
}

/**
 * An OPEN handle on a regular file this process created exclusively — held for one reason: while
 * it is open the kernel cannot recycle that inode. `FsStat.id` alone cannot survive an unlink
 * (see above); an id that is PINNED can, which is what turns "not a different live node" into
 * "provably the same file I created".
 *
 * A regular-file handle is the portable form of this. A directory handle is not — Node cannot
 * open a directory for reading on Windows — so custody of a DIRECTORY is proved indirectly, by a
 * sentinel file held open inside it.
 */
export interface FsHandle {
  /** Identity captured by `fstat` at open time, pinned for the handle's lifetime. */
  readonly id: string;
  /** Idempotent; releases the pin. */
  close(): void;
}

/**
 * The injected filesystem port. The REAL implementation (node-fs.ts) wires each op to
 * node:fs with O_NOFOLLOW / lstat / O_EXCL so the security properties hold; tests
 * supply an in-memory fake so the ORCHESTRATION (allowlist checks, downgrade policy,
 * lock/stale-steal, staging + swap, crash recovery) is exercised with no real disk.
 */
export interface InstallFs {
  /** lstat WITHOUT following symlinks; null on ENOENT. Other fs errors throw. */
  lstat(path: string): FsStat | null;
  /** Recursive mkdir at `mode`. Idempotent (an existing dir is fine). */
  mkdir(path: string, mode: number): void;
  /**
   * Create a NEW directory at `mode` — O_EXCL semantics: throws (EEXIST) when ANY node
   * already occupies the path, so the caller PROVABLY created (and therefore owns) the dir.
   * Non-recursive; the parent must exist. The staging custody gate rests on this: only a
   * dir an invocation created exclusively may that invocation ever sweep.
   */
  mkdirExclusive(path: string, mode: number): void;
  /**
   * Create a NEW regular file at `mode` (O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW) and return it as an
   * OPEN handle. Throws EEXIST over any existing node. The handle's `id` is pinned for as long as
   * it is open — that pin is the whole point; see `FsHandle`.
   */
  openExclusive(path: string, mode: number): FsHandle;
  /** Directory entry names; [] on ENOENT. */
  readdir(path: string): string[];
  /** Atomic same-filesystem rename (moves a symlink as-is, never traversing it). */
  rename(from: string, to: string): void;
  /** Recursive force remove; an absent path is a no-op. */
  rmrf(path: string): void;
  /** Unlink a single path; an absent path is a no-op. */
  unlink(path: string): void;
  /**
   * A symlink's target VERBATIM (never traversed); null when the path is absent or is not
   * a symlink (T-224 D1). The only port op that observes a link target — resolution itself
   * is lexical and lives in `resolveInstallTarget`, so it is testable with zero real disk
   * and behaves IDENTICALLY for a live and a dangling link (`lstat` distinguishes each hop).
   */
  readlink(path: string): string | null;
  /** Copy a REGULAR file src->dest at `mode`, following NO symlink at either end. */
  copyFile(src: string, dest: string, mode: number): void;
  /** Create a NEW file (O_EXCL) with `data` at `mode`, following no symlink. */
  writeNew(path: string, data: string, mode: number): void;
  /** Read a small file as utf8; null if absent or a symlink (final component). */
  readUtf8(path: string): string | null;
  /** O_CREAT|O_EXCL|O_NOFOLLOW create; true if we created it, false if it already exists. */
  tryCreateLock(path: string, mode: number): boolean;
}

/** Bounded, display-sanitized facts about entries that made a tree unmanaged (D-detail-sanitize-v2). */
export interface UnexpectedEntries {
  /** ≤ 5 names, sorted, display-sanitized + width-capped. */
  readonly sample: readonly string[];
  /** How many unexpected entries there were in total. */
  readonly count: number;
  /** Whether `sample` omits some of them. */
  readonly truncated: boolean;
}

/** `<homeDir>/.claude/skills` — the canonical dir holding the lock, the record, and the leaf. */
export function skillsDirPath(homeDir: string): string {
  return join(homeDir, ".claude", "skills");
}

/** The LOGICAL installed-skill path (`~/.claude/skills/agkit`) — possibly a symlink (D1). */
export function skillDestPath(homeDir: string): string {
  return join(skillsDirPath(homeDir), SKILL_DIR_NAME);
}

/** The outcome of resolving the dest LEAF (D1). `path` is where the real tree lives / will live. */
export type DestResolution =
  | { readonly ok: true; readonly path: string; readonly viaSymlink: boolean }
  | {
      readonly ok: false;
      readonly reason: "symlink-depth-exceeded" | "unreadable-link" | "self-referential-link" | "not-a-directory";
      readonly path: string;
    };

/**
 * Resolve the dest leaf to the REAL directory the tree lives in (T-224 D1, cpm
 * `resolveSymlinkTarget` semantics). The walk is LEXICAL over `lstat` + `readlink`, so a
 * LIVE link and a DANGLING one take exactly the same path — the difference is only whether
 * the final `lstat` returns null (nothing there yet; we will create it AT the link's
 * destination, preserving the link). No hop is ever traversed by an `open`, so none of the
 * file-level O_NOFOLLOW guards inside the tree are weakened.
 *
 * Refusals (honor-or-reject — never silently install somewhere else):
 *   • more than MAX_SYMLINK_DEPTH hops (a loop, or an absurd chain);
 *   • a link whose target we cannot read (it raced away mid-walk);
 *   • a chain that OVERLAPS the leaf in either direction — an ANCESTOR target (`agkit -> .`,
 *     `agkit -> ..`) would have the staged swap rename the link's own parent aside, taking the
 *     lock with it; a target UNDER the link (`agkit -> agkit/child`) makes any further lstat
 *     traverse the link as its own ancestor, which the kernel answers with ELOOP;
 *   • a kernel ELOOP surfacing from any hop's lstat (a loop among the target's ANCESTORS that
 *     the lexical overlap check cannot see) — normalized, never allowed to escape as a crash;
 *   • a resolved target that EXISTS and is not a directory.
 */
export function resolveInstallTarget(fs: InstallFs, dest: string): DestResolution {
  let cur = dest;
  let hops = 0;
  let final: FsStat | null;
  for (;;) {
    const st = lstatNoLoop(fs, cur);
    if (st === "eloop") return { ok: false, reason: "self-referential-link", path: cur };
    if (st === null || !st.isSymbolicLink()) {
      final = st;
      break; // absent, or a real node — the walk ends
    }
    if (hops >= MAX_SYMLINK_DEPTH) return { ok: false, reason: "symlink-depth-exceeded", path: cur };
    hops++;
    const target = fs.readlink(cur);
    if (target === null) return { ok: false, reason: "unreadable-link", path: cur };
    cur = isAbsolute(target) ? join(target) : join(dirname(cur), target);
    // Overlap in EITHER direction refuses BEFORE the next lstat: the hop cap cannot catch a
    // target under the link, because that loop lives inside a single path resolution — the
    // very next lstat would throw ELOOP — not in the walk this cap bounds.
    if (isAncestorOrSelf(cur, dest) || isAncestorOrSelf(dest, cur)) {
      return { ok: false, reason: "self-referential-link", path: cur };
    }
  }
  if (final !== null && !final.isDirectory()) return { ok: false, reason: "not-a-directory", path: cur };
  return { ok: true, path: cur, viaSymlink: hops > 0 };
}

/** `lstat` with the kernel's ELOOP surfaced as a value, so the walk turns a symlink loop among
 *  a hop's ANCESTORS into a typed refusal instead of a crash. Only ELOOP is absorbed — every
 *  other error keeps the port's throw contract. */
function lstatNoLoop(fs: InstallFs, path: string): FsStat | null | "eloop" {
  try {
    return fs.lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return "eloop";
    throw err;
  }
}

/**
 * THE classifier (D1v3a + D1v4a + D1v5b). Every consumer — the unlocked fast path, the
 * under-lock re-check, `skillFreshness`, recovery's dest gate, and `setup --check`'s drift
 * report — goes through this ONE function, so freshness and replacement can never disagree
 * and the marker is read + interpreted EXACTLY once.
 *
 *   absent        — nothing at the (resolved) dest.
 *   unmanaged     — the dir holds something that is not ours. "Managed" is an ALLOWLIST-SHAPE
 *                   predicate: EVERY entry must be a REGULAR file named in
 *                   `SKILL_FILE_ALLOWLIST ∪ {SKILL_VERSION_MANIFEST}` (an empty dir qualifies
 *                   vacuously). A valid marker NEVER buys a pass — T-209 would have deleted a
 *                   user's own files parked at `~/.claude/skills/agkit`; we refuse instead.
 *   current       — a managed tree that is COMPLETE, carries a valid marker, and whose
 *                   installed version is >= ours. `>=` keeps T-209's downgrade-reject (M8):
 *                   an older CLI never overwrites a newer install (D1v4a).
 *   stale-managed — any other managed tree (older / incomplete / marker-less / marker junk).
 *
 * `installedVersion` only ever carries a value that passed `isValidVersion`, so untrusted
 * disk bytes can never leak out of here into a rendered diagnostic.
 */
export type DestClassification =
  | { readonly status: "absent" }
  | { readonly status: "current"; readonly installedVersion: string }
  | { readonly status: "stale-managed"; readonly installedVersion: string | null }
  | { readonly status: "unmanaged"; readonly unexpected: UnexpectedEntries };

export function classifyDest(fs: InstallFs, dest: string, runningVersion: string): DestClassification {
  const dst = fs.lstat(dest);
  if (dst === null) return { status: "absent" };
  // Callers resolve the leaf first, so a non-directory here is a defensive backstop only
  // (something squatting the resolved target). It is emphatically not ours to replace.
  if (dst.isSymbolicLink() || !dst.isDirectory()) {
    return { status: "unmanaged", unexpected: boundUnexpected([basename(dest)]) };
  }

  const unexpected = unexpectedEntries(fs, dest);
  if (unexpected.length > 0) return { status: "unmanaged", unexpected: boundUnexpected(unexpected) };

  // The ONE marker read. Anything that fails `isValidVersion` reads as "no marker" (null)
  // rather than leaking arbitrary file content into a caller's diagnostic output.
  const manifest = fs.readUtf8(join(dest, SKILL_VERSION_MANIFEST));
  const trimmed = manifest === null ? null : manifest.trim();
  const installedVersion = trimmed !== null && isValidVersion(trimmed) ? trimmed : null;
  if (installedVersion === null) return { status: "stale-managed", installedVersion: null };
  // A marker over a partial tree is LYING — completeness is required at every version.
  if (!isCompleteTree(fs, dest)) return { status: "stale-managed", installedVersion };
  if (compareVersions(installedVersion, runningVersion) < 0) {
    return { status: "stale-managed", installedVersion }; // older -> re-sync (ISS-570 acceptance)
  }
  return { status: "current", installedVersion }; // equal, or NEWER (downgrade-reject, M8)
}

/** Entry names that make `dir` unmanaged: an unknown name, or an allowlisted name that is
 *  not a REGULAR non-symlink file (a directory or symlink wearing an allowlisted name). */
function unexpectedEntries(fs: InstallFs, dir: string): string[] {
  const bad: string[] = [];
  for (const name of fs.readdir(dir)) {
    if (!MANAGED_NAMES.has(name)) {
      bad.push(name);
      continue;
    }
    const st = fs.lstat(join(dir, name));
    if (!st || st.isSymbolicLink() || !st.isFile()) bad.push(name);
  }
  return bad;
}

/**
 * The one extra name a directory of ours legitimately carries mid-transaction: the custody
 * sentinel its creator holds open. It lives inside STAGING, and because it travels with the
 * directory it is briefly inside `dest` too — publication removes it two syscalls after the
 * rename, and a crash in that window strands it there.
 *
 * `classifyDest` does NOT tolerate it: a `dest` carrying this name is unmanaged, exactly as it
 * was before, and stays that way until recovery has PROVEN the tree is a publication of ours
 * and removed the sentinel itself. Tolerance lives only in the predicate below, and only where
 * the caller already holds the authority to act on what it finds.
 */
export const CUSTODY_SENTINEL = ".agkit-custody";

/**
 * `isAllowlistShaped`, with the custody sentinel set aside — the shape test for a directory
 * caught mid-transaction. Note what it does NOT do: it never removes the sentinel and never
 * confers ownership, so a caller must still have its own proof (a held handle, or a completed
 * publication) before it deletes anything on the strength of this answer.
 */
export function isShapedApartFromSentinel(fs: InstallFs, dir: string): boolean {
  for (const name of unexpectedEntries(fs, dir)) {
    if (name !== CUSTODY_SENTINEL) return false;
    // Tolerating a NAME is not tolerating whatever happens to wear it (relay addendum5 E1).
    // `openExclusive` creates a REGULAR FILE; a directory or a symlink here is a stranger's,
    // and every arm that acts on this answer does so with `rmrf`, which would take a whole
    // subtree with it. Set aside only the exact thing we create.
    const st = fs.lstat(join(dir, name));
    if (st === null || st.isSymbolicLink() || !st.isFile()) return false;
  }
  return true;
}

/**
 * Everything `classifyDest` demands of a managed tree, minus the one name it cannot yet see
 * past: no OTHER unexpected entry, every allowlist file present as a regular file, and a marker
 * that actually parses. This is the PROOF that a dir carrying a stray sentinel is a publication
 * of ours — the authority recovery needs before it may remove that sentinel. It lives here, with
 * `classifyDest`, so the two can never drift into disagreeing about what a managed tree is.
 */
export function isPublicationApartFromSentinel(fs: InstallFs, dir: string): boolean {
  if (!isShapedApartFromSentinel(fs, dir) || !isCompleteTree(fs, dir)) return false;
  const marker = fs.readUtf8(join(dir, SKILL_VERSION_MANIFEST));
  return marker !== null && isValidVersion(marker.trim());
}

/** The allowlist-SHAPE predicate on its own: is every entry of `dir` one of ours? */
export function isAllowlistShaped(fs: InstallFs, dir: string): boolean {
  return unexpectedEntries(fs, dir).length === 0;
}

/** Is every allowlisted file present as a REGULAR non-symlink file? (completeness only.) */
export function isCompleteTree(fs: InstallFs, dir: string): boolean {
  for (const name of SKILL_FILE_ALLOWLIST) {
    const st = fs.lstat(join(dir, name));
    if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  }
  return true;
}

/** Sort, cap, and display-sanitize unexpected entry names (D-detail-sanitize / -v2): the
 *  names are attacker-plantable disk bytes that ride a rendered refusal. */
function boundUnexpected(names: readonly string[]): UnexpectedEntries {
  const sorted = [...names].sort();
  return {
    sample: sorted.slice(0, UNEXPECTED_SAMPLE_MAX).map((name) => displayCapped(name, UNEXPECTED_NAME_MAX)),
    count: sorted.length,
    truncated: sorted.length > UNEXPECTED_SAMPLE_MAX,
  };
}

/** Render the bounded sample for a human-facing detail string. */
export function describeUnexpected(u: UnexpectedEntries): string {
  const more = u.truncated ? `, …and ${u.count - u.sample.length} more` : "";
  return `unexpected entries: ${u.sample.join(", ")}${more}`;
}

/** Is `a` equal to `b`, or a proper ancestor directory of it? Segment-aware (no prefix trap). */
export function isAncestorOrSelf(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}
