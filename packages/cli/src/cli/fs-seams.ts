// The production fs LEAF SEAMS — the three functions the shell binds onto `CliRuntime` so that a
// command handler never touches `node:fs` itself. Extracted from run.ts to keep that file under the
// packages/cli max-lines cap (the `./command-seams` precedent); `run.ts` remains their ONLY wiring
// point, and `RunOverrides` remains the way a test swaps them for hermetic fakes.
//
//   createReadTextFile  — the bounded single-fd INPUT channel  (B0 shared-core, sub-wave B)
//   createWriteTextFile — the atomic 0644 OUTPUT channel        (T-221)
//   createListDir       — the advisory directory-name probe     (T-221)
//
// T-224 adds the SYMLINK-FOLLOWING siblings (`agkit setup`'s dotfiles-managed leaves) — see the
// banner above `resolveFollowTarget` for why they are separate exports and not a flag:
//   resolveFollowTarget          — the PURE leaf resolver + containment  (D-within-v3/v4)
//   ensureRootForApply           — apply-only root create + revalidate   (D-within-v4)
//   createReadTextFileFollowing  — the bounded follow-READ + identity    (D-read-follow[-v2])
//   createWriteTextFileFollowing — the identity-BOUND follow-WRITE       (D-new, D-bind/create-v4..v6)
//   verifyFollowedWrite          — the publication postcondition re-read (D-bind-v5)
//
// Every failure here is a STATIC `usage_error`: the displaySafe'd path (user argv, never secret)
// plus a class — never a raw errno and never file content.
import { open } from "node:fs/promises";
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CliLocalError } from "../core/errors";
import { displaySafe } from "../core/output/display";

/** O_NOFOLLOW is POSIX; 0 where absent (Windows) — harmless there (config-file.ts precedent). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * B0 shared-core (sub-wave B): the production BOUNDED, single-fd text-file reader (the first fs INPUT
 * channel — agent `sync --file`, media `--config-json @path`, T-221 `init`). ONE `open` → `fstat`
 * (reject a non-regular file) → a LOOPED read into a `maxBytes+1` buffer (one `read` may under-fill
 * even a regular file) until EOF or over-cap → `> maxBytes` ⇒ oversize `usage_error` → STRICT UTF-8
 * decode → `close()` in `finally`. No stat-then-read gap: the read is itself bounded, so a file that
 * grows/swaps between metadata and read can NEVER exceed the cap (the size check lives on the READ,
 * not the stat). Every error is STATIC — the displaySafe'd path (user argv, not secret) + a class,
 * NEVER file content.
 */
export async function createReadTextFile(path: string, opts: { maxBytes: number }): Promise<string> {
  // T-224: the body below moved into `readBoundedRegularFile` so the follow-READER (D-read-follow)
  // consumes the SAME bytes-and-bounds discipline over its RESOLVED path — ONE reader, never two
  // that drift. This entry point's contract is byte-unchanged, including every detail string: a
  // missing file is an ERROR here (the follow reader reports `{status:"absent"}` instead, because
  // absence is a legitimate, reportable state for the leaves `setup` reconciles).
  const read = await readBoundedRegularFile(path, opts.maxBytes, path);
  if (read === null) {
    throw new CliLocalError("usage_error", {
      detail: `${displaySafe(path)}: no such file, or it cannot be opened`,
    });
  }
  return read.text;
}

/** What one bounded read observed: the decoded text, the exact BYTES it decoded (the digest input —
 *  hashing the buffer, not a re-encode, keeps the identity honest), and the fd's inode identity. */
interface BoundedRead {
  readonly text: string;
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
}

/**
 * The shared bounded-read CORE — `createReadTextFile`'s original body, verbatim in discipline, with
 * two seams the follow-reader needs: `display` (errors name the LOGICAL path the user typed, never
 * the resolved one) and a `null` return for an ENOENT-class open (absence is an ERROR for one caller
 * and a STATE for the other, so the classification belongs to the caller, not here).
 */
async function readBoundedRegularFile(
  path: string,
  cap: number,
  display: string,
): Promise<BoundedRead | null> {
  // `maxBytes` is a CLI-internal constant, but validate defensively — a bad cap must fail STATIC,
  // never `Buffer.alloc` a bogus/huge buffer or throw a raw RangeError past CLI classification.
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new CliLocalError("usage_error", {
      detail: `${displaySafe(display)}: cannot be read (invalid size limit)`,
    });
  }
  // O_NONBLOCK so opening a FIFO / device returns IMMEDIATELY (a plain `open(path,"r")` on a writer-less
  // FIFO BLOCKS forever, before the `isFile()` check below could reject it). Regular files ignore
  // O_NONBLOCK for reads, so nothing changes on the happy path.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (err) {
    // ENOENT ALONE means absent — a dangling symlink's destination opens ENOENT too, which is
    // exactly the "the file is not there yet" state. Every OTHER errno (EACCES, ELOOP, ENOTDIR,
    // EISDIR…) is a genuine failure and keeps the static error contract.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliLocalError("usage_error", {
      detail: `${displaySafe(display)}: no such file, or it cannot be opened`,
    });
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new CliLocalError("usage_error", { detail: `${displaySafe(display)}: not a regular file` });
    }
    const buf = Buffer.alloc(cap + 1);
    let offset = 0;
    while (offset <= cap) {
      const { bytesRead } = await fh.read(buf, offset, cap + 1 - offset, null);
      if (bytesRead === 0) break; // EOF
      offset += bytesRead;
    }
    if (offset > cap) {
      throw new CliLocalError("usage_error", {
        detail: `${displaySafe(display)}: exceeds the ${cap}-byte limit`,
      });
    }
    const bytes = buf.subarray(0, offset);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliLocalError("usage_error", { detail: `${displaySafe(display)}: is not valid UTF-8` });
    }
    return { text, bytes, dev: Number(st.dev), ino: Number(st.ino) };
  } catch (err) {
    // Preserve the specific static errors above; normalize ANY other failure (stat / read / a
    // Buffer.alloc RangeError) to the SAME static contract — a raw errno must never escape CLI
    // classification (fs error messages carry the path, but only user argv, never file content).
    if (err instanceof CliLocalError) throw err;
    throw new CliLocalError("usage_error", { detail: `${displaySafe(display)}: could not be read` });
  } finally {
    // A `close()` failure must NEVER override the primary error (or a successful read): swallow it —
    // the fd is discarded with the handler regardless.
    try {
      await fh.close();
    } catch {
      /* swallow — closing a to-be-discarded fd is best-effort */
    }
  }
}

/**
 * T-221: the production fs OUTPUT channel (the `createReadTextFile` sibling; the ONLY writer the
 * `init` scaffold has). Mirrors `core/config/config-file.ts`'s `atomicWrite0644` byte-for-byte in
 * DISCIPLINE: create the parent dir 0755 (recursive, so an absent `.agentkit/` is made once),
 * `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` a uniquely-named temp at 0644, LOOP the write (one
 * `writeSync` may under-fill), `fsync`, then `rename` — atomic on the same filesystem, and a
 * rename REPLACES a symlink at `file` with the regular file itself (never writes THROUGH it).
 * A failure unlinks the temp and rethrows as the STATIC `usage_error` naming only the path +
 * class (never the bytes being written — the artifact is non-secret, but the discipline is the
 * reader's: no file content in an error, ever).
 *
 * Config's own writer stays where it is: it is `saveConfig`-internal (it re-validates a
 * `ConfigData` and owns the 0700 config dir), whereas this one writes an arbitrary repo-relative
 * artifact into a 0755 project directory. Same technique, different custody — sharing one
 * function would have to take both dir modes and both validation postures as parameters.
 */
/**
 * Codex k07 (path traversal): `O_NOFOLLOW` guards only the temp's FINAL component — every parent
 * component of `mkdir`/`open`/`rename` still follows symlinks, so a hostile checkout shipping
 * `.agentkit` as a symlink would land `project.json` OUTSIDE the repository. This check runs
 * BEFORE the mkdir (so not even a directory is created outside): resolve the deepest EXISTING
 * ancestor of the target directory and require it to sit inside the resolved root.
 */
function assertDirInsideRoot(dir: string, root: string, artifactPath: string): void {
  const outside = (): never => {
    throw new CliLocalError("usage_error", {
      detail: `${displaySafe(artifactPath)}: refusing to write through a path that resolves outside the repository`,
    });
  };
  // Codex k16a: LEXICAL containment FIRST. A nonexistent middle component followed by `..`
  // (e.g. `<root>/ghost/../../outside/x`) slips past the deepest-EXISTING-ancestor probe below
  // (existsSync fails AT the missing component, so the walk lands on an in-root ancestor) while
  // `mkdirSync(..., {recursive:true})` lexically normalizes the same path and creates OUTSIDE
  // the root. Reject the normalized relation before any symlink reasoning.
  const resolvedDir = resolve(dir);
  const rel = relative(resolve(root), resolvedDir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) outside();
  // Then the SYMLINK check: the deepest existing ancestor of the (resolved) target directory
  // must realpath inside the resolved root.
  let probe = resolvedDir;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  const realRoot = realpathSync(root);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) outside();
}

export function createWriteTextFile(path: string, text: string, opts?: { withinRoot?: string }): void {
  const dir = dirname(path);
  // Codex k16a: UUID entropy (never pid+ms — two same-process writes in one millisecond would
  // collide, and O_EXCL would fail one of them). A UUID collision is cryptographically negligible,
  // so no retry loop; O_EXCL stays as the hard backstop.
  const tmp = join(dir, `.agkit.${process.pid}.${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    if (opts?.withinRoot !== undefined) assertDirInsideRoot(dir, opts.withinRoot, path);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW, 0o644);
    tempCreated = true;
    try {
      const buf = Buffer.from(text, "utf8");
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    // Codex k16a: unlink ONLY a temp THIS invocation created — an unconditional unlink after a
    // failed O_EXCL would delete a concurrent writer's live temp and fail BOTH writes.
    if (tempCreated) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (err instanceof CliLocalError) throw err;
    throw new CliLocalError("usage_error", { detail: `${displaySafe(path)}: could not be written` });
  }
}

/**
 * T-221: the production bounded directory listing — entry NAMES only, no contents, no recursion.
 * ADVISORY by contract: a missing / unreadable / non-directory path yields `[]` so a marker probe
 * can never fail the run (the caller then simply detects no markers).
 */
export function createListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// T-224 — the SYMLINK-FOLLOWING leaf seams (`agkit setup`).
//
// `createWriteTextFile` above deliberately REPLACES a symlink at the final path (that is what
// `rename` does): an `init` scaffold writing `project.json` must land a regular file inside the
// repository. `setup` needs the OPPOSITE at three dotfiles-managed leaves — the project's
// `AGENTS.md`, `~/.claude.json`, `~/.codex/config.toml` — where a stow/chezmoi link IS the user's
// deliberate indirection: clobbering it would silently detach their managed file (D-new).
//
// Writing THROUGH a link is only safe with three disciplines the plain writer does not carry, which
// is why these are separate exports rather than an `opts.follow` flag on a seam whose whole
// documented contract is "never writes through it":
//   1. CONTAINMENT (D-within-v3/v4) — the RESOLVED target must stay inside a caller-named root, so
//      a hostile `AGENTS.md -> ~/.bashrc` gets refused, not appended to.
//   2. IDENTITY BINDING (D-bind-v4/v5) — a write publishes only over the exact bytes a prior
//      follow-READ observed; a dotfile manager that retargets the link, or any other writer that
//      edits the file, in between is DETECTED and refused rather than overwritten blind.
//   3. NO-REPLACE CREATION (D-create-v5/v6) — the fresh-create arm publishes with `link()`, which
//      fails EEXIST instead of silently replacing a file that appeared after the absence check.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** D-new/D-within-v3: the hop cap for the LEXICAL link walk (a DANGLING chain has no `realpath` to
 *  lean on, so we walk it ourselves). 40 mirrors the installer's own walk and the usual kernel
 *  `SYMLOOP_MAX`; a longer chain — or a cycle, which `realpath` rejects as ELOOP and the walk then
 *  re-enters — is REFUSED, never followed forever. */
const FOLLOW_DEPTH_CAP = 40;

/** The default cap for the follow-writer's own re-reads. Callers SHOULD pass the same `maxBytes`
 *  their follow-READ used, so a target that grew past the caller's bound refuses honestly ("changed
 *  since it was read") instead of being digested under a different bound. */
const DEFAULT_FOLLOW_MAX_BYTES = 1024 * 1024;

/** The identity a follow-READ observed. `digest` (sha256 hex of the exact bytes read) is the
 *  PORTABLE authority: Windows reports 0 / unstable values for `dev` and `ino`, so those are
 *  ADVISORY — they can only tighten the pre-publish check, never carry it alone (D-bind-v5). */
export interface FollowIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
}

/** D-read-follow-v2: a DISCRIMINATED result, because absence is a legitimate state at every leaf
 *  `setup` reconciles — `--check` reports it as drift (exit 1), apply takes the fresh-create arm.
 *  `resolvedPath` is always where a read found (or a write would land) the real bytes: for a
 *  dangling link, the walk's final destination. Unreadable / non-regular / oversized /
 *  outside-the-root are REFUSALS (thrown), never a quiet `absent`. */
export type FollowReadResult =
  | {
      readonly status: "present";
      readonly text: string;
      readonly resolvedPath: string;
      readonly identity: FollowIdentity;
    }
  | { readonly status: "absent"; readonly resolvedPath: string };

/** What a follow-WRITE is permitted to publish over: exactly the `{resolvedPath, identity}` a prior
 *  follow-READ returned, or `{resolvedPath, identity: null}` for the fresh-create arm. */
export interface FollowExpectation {
  readonly resolvedPath: string;
  readonly identity: FollowIdentity | null;
}

/** D-create-v6: `link()` is the COMMIT POINT — once it succeeds the publication is committed, so a
 *  failed best-effort `unlink(tmp)` must NOT fail the operation. It rides back as a warning naming
 *  the exact leftover temp, so the caller can tell the user precisely what to remove by hand. */
export interface FollowWriteResult {
  readonly resolvedPath: string;
  readonly cleanupWarning?: string;
}

/** The postcondition verdict (D-bind-v5): bytes over claims — a successful write is not evidence. */
export type FollowVerification =
  | { readonly ok: true; readonly resolvedPath: string; readonly identity: FollowIdentity }
  | { readonly ok: false; readonly resolvedPath: string; readonly detail: string };

/** Every refusal in this section keeps the file's contract: STATIC `usage_error`, the displaySafe'd
 *  LOGICAL path (user argv / a caller-owned config path, never secret) + a class. Never an errno,
 *  never file content. */
function refuseFollow(display: string, what: string): never {
  throw new CliLocalError("usage_error", { detail: `${displaySafe(display)}: ${what}` });
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lexical containment, the `assertDirInsideRoot` relation above: `child` is inside `root` when the
 *  relative path neither IS `..`, nor starts with `..<sep>`, nor is absolute (different drive). */
function isUnder(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * D-within-v3: containment for a path that may not exist YET (a fresh `~/.codex/config.toml`, an
 * `AGENTS.md` about to be created). Resolve the DEEPEST EXISTING ancestor through `realpath` — so a
 * symlinked ancestor is unmasked and cannot smuggle the target out of the root — then re-attach the
 * remaining components LEXICALLY. The input is always an already-`resolve()`d path, so the suffix
 * carries no `..` of its own; the only way out of the root is a genuine escape, which `isUnder`
 * then rejects. A hop that becomes a symlink AFTER this check cannot be caught here — the staging
 * open is O_NOFOLLOW beside the resolved parent, which is what bounds that window.
 */
function realizeOverDeepestExisting(p: string): string {
  const abs = resolve(p);
  const suffix: string[] = [];
  let probe = abs;
  let hops = 0;
  // `existsSync` FOLLOWS links, so a DANGLING component reads as not-existing — but it may still
  // BE a symlink whose target is simply not there yet (a stow-managed fresh `~/.codex ->
  // ~/dotfiles/.codex`). Treating it as a plain missing name would realize to the LEXICAL link
  // path, and the apply-side mkdir would then land ON the link and fail instead of provisioning
  // the intended target (codex relay finding, payload 5). So: when the missing component is a
  // dangling link, follow the chain lexically (same depth cap) and continue realization from its
  // intended destination — containment then judges the DESTINATION, which is the honest question.
  while (!existsSync(probe)) {
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(probe);
    } catch {
      st = null; // genuinely absent
    }
    if (st !== null && st.isSymbolicLink()) {
      if (++hops > FOLLOW_DEPTH_CAP) {
        refuseFollow(p, `symlink chain is deeper than ${FOLLOW_DEPTH_CAP} links`);
      }
      probe = walkLinkChain(probe, p);
      continue;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    suffix.unshift(basename(probe));
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    realProbe = probe; // unreadable ancestor — keep the lexical form; containment still decides
  }
  return suffix.length === 0 ? realProbe : join(realProbe, ...suffix);
}

/**
 * The LEXICAL link walk, used when `realpath` cannot answer: a DANGLING chain (the everyday dotfiles
 * case — the manager stages the link before the file) or a cycle. Each hop `readlink`s and re-anchors
 * a RELATIVE target against the LINK's own directory, exactly as the kernel would. The walk stops at
 * the first destination that is not a symlink — existing or not — because that is where a read finds
 * bytes (or nothing) and where a write would land.
 */
function walkLinkChain(start: string, display: string): string {
  let current = start;
  for (let hop = 0; hop < FOLLOW_DEPTH_CAP; hop++) {
    let link: string;
    try {
      link = readlinkSync(current);
    } catch {
      return current; // raced into a non-symlink, or unreadable — THIS component is the landing spot
    }
    const next = isAbsolute(link) ? resolve(link) : resolve(dirname(current), link);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch {
      return next; // the chain's destination does not exist — a dangling link's landing spot
    }
    if (!isLink) return next;
    current = next;
  }
  refuseFollow(display, `symlink chain is deeper than ${FOLLOW_DEPTH_CAP} links`);
}

/** Resolve the LEAF only: a real file/dir is itself; a live link is the kernel's `realpath` (which
 *  also unmasks symlinked ancestors); a dangling/cyclic link is the depth-capped lexical walk; an
 *  absent leaf is itself (a write lands exactly there). */
function resolveLeafTarget(path: string, display: string): string {
  const abs = resolve(path);
  let isLink: boolean;
  try {
    isLink = lstatSync(abs).isSymbolicLink();
  } catch {
    return abs; // absent leaf
  }
  if (!isLink) return abs;
  try {
    return realpathSync(abs);
  } catch {
    return walkLinkChain(abs, display);
  }
}

/**
 * D-within-v4: the PURE resolver. It NEVER creates anything — no directory, no file, no temp — so
 * `setup --check` can consume it alone and report an absent root as drift rather than provisioning
 * it behind the user's back. Returns the path where a read/write on `path` would land, with the
 * leaf link followed and containment inside `within` proven.
 *
 * Containment violation ⇒ typed refusal (thrown). That is deliberate and matches D5v2: a resolved
 * target outside the caller's root is a REFUSAL with an honest message, never a silent skip.
 */
export function resolveFollowTarget(path: string, opts: { within: string }): string {
  const target = resolveLeafTarget(path, path);
  const realTarget = realizeOverDeepestExisting(target);
  const realWithin = realizeOverDeepestExisting(opts.within);
  if (!isUnder(realTarget, realWithin)) {
    refuseFollow(path, `refusing to follow a link that resolves outside ${displaySafe(opts.within)}`);
  }
  return realTarget;
}

/**
 * D-within-v4: the APPLY-ONLY root provisioner — the ONE function in this section that creates
 * anything, and the reason `resolveFollowTarget` can stay pure. Check-and-dry-run paths must NEVER
 * call it. Order: prove containment LEXICALLY-OVER-DEEPEST-EXISTING *before* the mkdir (so not even
 * a directory is created outside home), `mkdir -p`, then RE-`realpath` and RE-validate over the real
 * bytes — the first check is a prediction, the second is evidence.
 *
 * 0700: the roots this provisions are user config directories under `$HOME` (`~/.codex`), not repo
 * artifacts; `mkdir` only applies the mode to directories it CREATES, so an existing root keeps its
 * own permissions.
 */
export function ensureRootForApply(root: string, opts: { homeDir: string }): string {
  const home = realizeOverDeepestExisting(opts.homeDir);
  const wanted = realizeOverDeepestExisting(root);
  if (!isUnder(wanted, home)) {
    refuseFollow(root, `refusing to create a directory outside ${displaySafe(opts.homeDir)}`);
  }
  try {
    mkdirSync(wanted, { recursive: true, mode: 0o700 });
  } catch {
    refuseFollow(root, "could not be created");
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(wanted);
  } catch {
    refuseFollow(root, "could not be resolved after it was created");
  }
  if (!isUnder(realRoot, home)) {
    refuseFollow(root, `refusing to create a directory outside ${displaySafe(opts.homeDir)}`);
  }
  return realRoot;
}

/**
 * D-read-follow / D-read-follow-v2: the bounded follow-READ. Same leaf resolution and containment as
 * the writer — that symmetry is the point: a dotfiles-symlinked `~/.claude.json` / `config.toml` /
 * `AGENTS.md` is read THROUGH, never misread as empty and then "reconciled" by clobbering it. One
 * regular-file descriptor read (O_NONBLOCK open, `fstat` isFile gate, byte cap) over the RESOLVED
 * path; errors name the LOGICAL path the user knows.
 *
 * The returned `{resolvedPath, identity}` is the binding token the writer demands back (D-bind-v4/v5).
 */
export async function createReadTextFileFollowing(
  path: string,
  opts: { within: string; maxBytes: number },
): Promise<FollowReadResult> {
  const resolvedPath = resolveFollowTarget(path, { within: opts.within });
  const read = await readBoundedRegularFile(resolvedPath, opts.maxBytes, path);
  if (read === null) return { status: "absent", resolvedPath };
  return {
    status: "present",
    text: read.text,
    resolvedPath,
    identity: { dev: read.dev, ino: read.ino, digest: sha256Hex(read.bytes) },
  };
}

/** The one detail every "someone else moved under us" refusal shares — stated as a fact about the
 *  file, with the guarantee (nothing was written) attached, because that is what the operator needs. */
const CHANGED = "changed since it was read — nothing was written";

/**
 * D-new + D-bind-v4/v5 + D-create-v5/v6: the identity-BOUND follow-WRITE.
 *
 * `expected` is the `{resolvedPath, identity}` a prior `createReadTextFileFollowing` returned, or
 * `{resolvedPath, identity: null}` for the fresh-create arm. Two arms, one refusal posture — any
 * evidence that the target is not the file we read ⇒ typed refusal, ZERO bytes written, temp cleaned.
 *
 * OVERWRITE ARM: stage a temp BESIDE the resolved target (same filesystem ⇒ the publish `rename` is
 * atomic and cannot EXDEV), fsync, then — immediately before publication — RE-RESOLVE the logical
 * link AND RE-READ the current target through the same read primitive, requiring resolved path
 * unchanged ∧ digest unchanged ∧ (when both sides report nonzero dev/ino) inode unchanged. Publish
 * by renaming over the RESOLVED TARGET, so the user's link is preserved — the exact opposite of
 * `createWriteTextFile` above, which replaces the link itself.
 *
 * FRESH-CREATE ARM: publish with `link(tmp, dest)`, which fails EEXIST rather than replacing a file
 * that appeared after the absence check. A plain `rename` would silently destroy it.
 *
 * This does NOT create directories: an absent parent is refused, because provisioning a root is
 * `ensureRootForApply`'s job (D-within-v4) and it carries the home-containment revalidation that an
 * implicit `mkdir -p` here would bypass.
 */
export async function createWriteTextFileFollowing(
  path: string,
  text: string,
  opts: { within: string; expected: FollowExpectation; maxBytes?: number },
): Promise<FollowWriteResult> {
  const within = opts.within;
  const expected = opts.expected;
  const cap = opts.maxBytes ?? DEFAULT_FOLLOW_MAX_BYTES;

  // RE-RESOLVE the LOGICAL path now — never trust the resolution captured at read time.
  const resolvedPath = resolveFollowTarget(path, { within });
  if (resolvedPath !== expected.resolvedPath) refuseFollow(path, CHANGED);

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) refuseFollow(path, "the parent directory does not exist");

  // UUID entropy, never pid+ms (codex k16a, `createWriteTextFile` above): two same-process writes in
  // one millisecond would collide and O_EXCL would fail one of them.
  const tmp = join(dir, `.agkit.${process.pid}.${randomUUID()}.tmp`);
  let tempCreated = false;
  let published = false;
  let cleanupWarning: string | undefined;
  try {
    if (expected.identity === null) {
      // Fresh-create arm: an early, honest refusal if the file already arrived. This is NOT the
      // safety property — `link()` below is (this check has a window; `link()` does not).
      const before = await createReadTextFileFollowing(path, { within, maxBytes: cap });
      if (before.resolvedPath !== expected.resolvedPath) refuseFollow(path, CHANGED);
      if (before.status === "present") {
        refuseFollow(path, "appeared concurrently since it was read — refusing to replace it");
      }
    }

    const fd = openSync(
      tmp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW,
      0o644,
    );
    tempCreated = true;
    try {
      const buf = Buffer.from(text, "utf8");
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (expected.identity === null) {
      try {
        linkSync(tmp, resolvedPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          refuseFollow(path, "appeared concurrently since it was read — refusing to replace it");
        }
        if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EXDEV" || code === "EOPNOTSUPP") {
          // FAIL CLOSED. A `rename` fallback here would publish — and would silently replace a file
          // that appeared meanwhile, which is precisely the race `link` exists to close. The caller
          // reports a manual snippet instead.
          refuseFollow(path, `could not be created safely (hard links are unavailable here: ${code})`);
        }
        refuseFollow(path, "could not be written");
      }
      // ── COMMIT POINT (D-create-v6). Publication is done. Everything below is cleanup, and a
      // cleanup failure must NOT fail the operation or trigger a retry: report it, name the exact
      // leftover, and never delete anything other than that one temp.
      published = true;
      try {
        unlinkSync(tmp);
      } catch {
        cleanupWarning = `left a temporary file behind: ${displaySafe(tmp)} — remove it by hand`;
      }
    } else {
      // Pre-publish bind check (D-bind-v5): re-resolve AND re-read, in that order.
      const again = resolveFollowTarget(path, { within });
      if (again !== expected.resolvedPath) refuseFollow(path, CHANGED);
      const current = await createReadTextFileFollowing(path, { within, maxBytes: cap });
      if (current.status !== "present" || current.resolvedPath !== expected.resolvedPath) {
        refuseFollow(path, CHANGED);
      }
      if (current.identity.digest !== expected.identity.digest) refuseFollow(path, CHANGED);
      // dev/ino are ADVISORY: Windows may report 0 / unstable values, so they only tighten the check
      // when BOTH sides report something real. The digest above already carried it.
      const identified =
        expected.identity.dev !== 0 &&
        expected.identity.ino !== 0 &&
        current.identity.dev !== 0 &&
        current.identity.ino !== 0;
      if (
        identified &&
        (current.identity.dev !== expected.identity.dev || current.identity.ino !== expected.identity.ino)
      ) {
        refuseFollow(path, CHANGED);
      }
      // HONEST LIMIT: the residual window between this check and the rename below is INHERENT
      // without mandatory file locking — another writer can still land in it. What the bind check
      // buys is shrinking the exposure from read-to-publish (a whole command's worth of work) down
      // to check-to-rename (two syscalls). We do not claim atomicity we do not have.
      renameSync(tmp, resolvedPath);
      published = true;
    }
  } catch (err) {
    // Unlink ONLY a temp THIS invocation created and did NOT publish (codex k16a): an unconditional
    // unlink after a failed O_EXCL would delete a concurrent writer's live temp and fail both.
    if (tempCreated && !published) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (err instanceof CliLocalError) throw err;
    throw new CliLocalError("usage_error", { detail: `${displaySafe(path)}: could not be written` });
  }
  return cleanupWarning === undefined ? { resolvedPath } : { resolvedPath, cleanupWarning };
}

/**
 * D-bind-v5 postcondition: bytes over claims. A returned `FollowWriteResult` is a claim; this
 * re-resolves the logical path and re-reads it through the SAME read primitive, then compares the
 * digest against what we intended to publish. Non-exceptional mismatches (absent, different bytes)
 * come back as `{ok:false, detail}` because a failed postcondition is a leg-level FACT for the
 * caller to report, not a crash; a containment refusal still throws, like everywhere else here.
 */
export async function verifyFollowedWrite(
  path: string,
  expectedText: string,
  opts: { within: string; maxBytes?: number },
): Promise<FollowVerification> {
  const cap = opts.maxBytes ?? DEFAULT_FOLLOW_MAX_BYTES;
  const after = await createReadTextFileFollowing(path, { within: opts.within, maxBytes: cap });
  if (after.status === "absent") {
    return { ok: false, resolvedPath: after.resolvedPath, detail: "is missing after the write" };
  }
  if (after.identity.digest !== sha256Hex(Buffer.from(expectedText, "utf8"))) {
    return { ok: false, resolvedPath: after.resolvedPath, detail: "does not match what was published" };
  }
  return { ok: true, resolvedPath: after.resolvedPath, identity: after.identity };
}
