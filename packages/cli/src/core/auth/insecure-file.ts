// The explicit-opt-in PLAINTEXT credential file (T-206, deliverable 3 + PL-14):
// `~/.agentkit/credentials.json`, profile-keyed JSON of E.4 records, mode 0600.
// This exists ONLY as the sanctioned, LOUD alternative to a missing keychain — it
// is never a silent fallback. Every read verifies 0600 (deliverable 4); every
// write re-checks the CI double-opt-in (PL-14, writes-only).
//
// Security (review-hardening — this is the plaintext path, so it is paranoid):
//   READ  — open with O_RDONLY|O_NOFOLLOW, then fstat THAT fd; reject non-regular,
//           not-owned-by-us (uid mismatch), or group/other-accessible files.
//   WRITE — read-modify-write preserving OTHER profiles; commit via an
//           O_CREAT|O_EXCL|O_NOFOLLOW 0600 temp file + atomic rename (0600 from
//           creation, never a umask-widened window, never following a symlink).
//
// Residual (documented, deliberate): O_NOFOLLOW only guards the FINAL path
// component and Node's stdlib has NO openat()/renameat()/fchmodat(), so the PARENT
// `~/.agentkit` is re-resolved by pathname on each op — a fully atomic dir-fd-relative
// implementation would need a native addon (out of scope for T-206). The reachable
// READ path closes the meaningful attack with the uid-ownership check: a cross-user
// attacker cannot forge a victim-owned 0600 file (no chown), and swapping a parent
// under `$HOME` already requires home-dir write access = pre-existing full compromise
// (they could replace ~/.bashrc / ~/.ssh directly). The three document RMWs (write / remove /
// copy) are serialized cross-process by the ISS-202 lock (file-lock.ts), now that T-213's
// login/logout make them concurrently user-reachable.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { InsecureFilePermissionsError, MalformedCredentialError } from "./errors";
import { requiresDoubleOptIn, insecureDoubleOptInSatisfied } from "./env";
import { InsecureStorageRefusedError } from "./errors";
import { parseDocument, type CredentialDocument, type CredentialRecord } from "./record";
import { withInsecureFileLock, type FileLockDeps } from "./file-lock";

/** Cap the file size read before parse (an attacker cannot force a huge allocation). */
const MAX_FILE_BYTES = 1024 * 1024;
/** O_NOFOLLOW is present on POSIX; 0 on platforms lacking it (Windows) — harmless. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface InsecureFileDeps {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
  /**
   * Optional overrides for the ISS-202 cross-process document lock (T-213). Defaults to the
   * production node-fs lock; tests inject an in-memory lock fs + clock to stage contention.
   * Consumed by the three document RMWs (write / remove / copy); reads never lock (atomic rename).
   */
  readonly lock?: FileLockDeps;
}

/** `~/.agentkit`. */
export function insecureDir(homeDir: string): string {
  return join(homeDir, ".agentkit");
}
/** `~/.agentkit/credentials.json`. */
export function insecureCredentialsPath(homeDir: string): string {
  return join(insecureDir(homeDir), "credentials.json");
}

/** Node fs errors carry a `.code`; narrow without `any`. */
function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/**
 * Guard the PARENT `~/.agentkit` directory: the file open uses O_NOFOLLOW, but a
 * symlinked PARENT would still redirect the whole path. `lstat` it (no follow) and
 * reject a symlink / non-directory before touching the file. A missing dir is fine
 * (the credential is simply absent).
 */
function assertRealDir(homeDir: string): void {
  const dir = insecureDir(homeDir);
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return; // absent -> nothing to guard
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new InsecureFilePermissionsError(
      `refusing to use ${dir}: it is a symlink (the credentials directory must be a real 0700 directory)`,
      dir,
      "symlink-dir",
    );
  }
  if (!st.isDirectory()) {
    throw new InsecureFilePermissionsError(`refusing to use ${dir}: not a directory`, dir, "not-dir");
  }
}

/**
 * Read + validate the WHOLE profile document, enforcing 0600 on the fd we read.
 * Returns null when the file is simply absent. Throws InsecureFilePermissionsError
 * for a widened / non-regular / symlinked file, and MalformedCredentialError for
 * bad contents (never echoing the bytes).
 */
function readDocument(homeDir: string): CredentialDocument | null {
  assertRealDir(homeDir); // reject a symlinked parent before touching the file
  const file = insecureCredentialsPath(homeDir);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return null; // simply not present
    if (code === "ELOOP") {
      throw new InsecureFilePermissionsError(
        `refusing to read ${file}: it is a symlink (credentials must be a real 0600 file)`,
        file,
        "symlink",
      );
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new InsecureFilePermissionsError(
        `refusing to read ${file}: not a regular file`,
        file,
        "not-regular",
      );
    }
    // Ownership check on the fd we actually hold. Node has no openat(), and
    // O_NOFOLLOW only guards the FINAL path component — a PARENT `~/.agentkit`
    // swapped for a symlink between assertRealDir() and openSync() would still
    // redirect the open. That residual TOCTOU is closed here: a file served from an
    // attacker-controlled directory is owned by the ATTACKER, not us, so a uid
    // mismatch is rejected. (No-op where getuid is unavailable, e.g. Windows.)
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw new InsecureFilePermissionsError(
        `refusing to read ${file}: it is owned by uid ${st.uid}, not the current user (uid ${uid})`,
        file,
        `uid:${st.uid}`,
      );
    }
    const mode = st.mode & 0o777;
    // Confidentiality invariant: NO group/other permission bit (owner-only). 0600 is
    // the canonical mode we write; a stricter owner-only mode (e.g. 0400) also passes,
    // anything group/other-accessible is rejected teachably.
    if ((mode & 0o077) !== 0) {
      throw new InsecureFilePermissionsError(
        `insecure credentials file ${file} has group/other-accessible mode 0${mode.toString(8).padStart(3, "0")} ` +
          `(credentials must be owner-only, 0600). Fix with: chmod 600 ${file}`,
        file,
        `0${mode.toString(8).padStart(3, "0")}`,
      );
    }
    if (st.size > MAX_FILE_BYTES) {
      throw new MalformedCredentialError("credentials file is too large");
    }
    const size = Number(st.size);
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return parseDocument(buf.subarray(0, read).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/**
 * The record for `profile` from the insecure file, or null if the file / profile
 * is absent. 0600 is verified on THIS read (deliverable 4 — every read).
 */
export function readInsecureRecord(profile: string, deps: InsecureFileDeps): CredentialRecord | null {
  const doc = readDocument(deps.homeDir);
  if (!doc) return null;
  // Own-property lookup so a profile name like `__proto__` / `constructor` cannot
  // resolve an inherited property instead of a real record.
  return Object.hasOwn(doc, profile) ? (doc[profile] ?? null) : null;
}

/**
 * The profile names that have a plaintext record in the insecure file (T-213 B-24). Used by
 * `logout --all-profiles` so a plaintext-only login (a profile that lives ONLY in the 0600 file,
 * never in config) is still reached. An absent/empty file → []. A read failure (a widened /
 * malformed file) PROPAGATES — enumeration must not silently under-report and leave a plaintext
 * credential un-cleared. UN-gated by PL-14 (a read, not a write).
 */
export function listInsecureProfiles(deps: InsecureFileDeps): string[] {
  const doc = readDocument(deps.homeDir);
  if (!doc) return [];
  return Object.keys(doc).filter((key) => Object.hasOwn(doc, key));
}

/**
 * Remove `profile`'s record from the insecure file (T-208: `profile delete` must
 * never orphan a plaintext credential once the keychain entry is gone). Returns
 * true if a record was removed. UN-gated by PL-14 on purpose: removal only REDUCES
 * plaintext exposure, so it is never blocked (the double-opt-in gate is about
 * CREATING plaintext, not deleting it). If removing the last profile empties the
 * document, the file is deleted entirely. Absent file/profile -> false (no-op).
 */
export function removeInsecureRecord(profile: string, deps: InsecureFileDeps): boolean {
  // Fast-path work check (unlocked, atomic read): an absent file/profile is a no-op — and returning
  // here avoids CREATING the dir (hence the lock file) for a nothing-to-do removal.
  const preview = readDocument(deps.homeDir);
  if (!preview || !Object.hasOwn(preview, profile)) return false;
  const dir = insecureDir(deps.homeDir);
  const file = insecureCredentialsPath(deps.homeDir);
  // ISS-202 (T-213): the read-modify-write is serialized cross-process so a concurrent
  // login/write cannot lose this rewrite (and vice-versa). Re-read UNDER the lock.
  return withInsecureFileLock(
    dir,
    () => {
      const existing = readDocument(deps.homeDir);
      if (!existing || !Object.hasOwn(existing, profile)) return false;
      const doc: CredentialDocument = Object.create(null) as CredentialDocument;
      for (const key of Object.keys(existing)) {
        if (key !== profile && Object.hasOwn(existing, key)) doc[key] = existing[key] as CredentialRecord;
      }
      if (Object.keys(doc).length === 0) {
        try {
          unlinkSync(file);
        } catch (err) {
          // An already-absent file is fine (ENOENT), but a REAL failure (EPERM/EACCES/EIO)
          // would leave the plaintext credential on disk while we return `true` — a silent
          // leak. Only ENOENT is swallowed; every other error must propagate so the caller
          // never treats an unremoved credential as removed.
          if (errCode(err) !== "ENOENT") throw err;
        }
        return true;
      }
      atomicWrite0600(dir, file, JSON.stringify(doc, null, 2) + "\n");
      return true;
    },
    deps.lock,
  );
}

/**
 * COPY `fromProfile`'s record onto `toProfile` in the insecure file, leaving the
 * source RECORD intact (T-208: `profile rename` migrates the plaintext credential
 * alongside the keychain — as a copy-then-remove so a mid-rename failure never strands
 * the secret away from the config that names it; the caller removes the old record only
 * AFTER config is durably saved). Returns true if a record was copied. UN-gated by
 * PL-14: it duplicates an already-existing plaintext record between keys — it does NOT
 * newly opt into plaintext storage — so the create-time double-opt-in does not apply.
 * A self-copy (from === to) and an absent source are no-ops (false).
 */
export function copyInsecureRecord(fromProfile: string, toProfile: string, deps: InsecureFileDeps): boolean {
  // Self-guard: a from === to copy is a no-op — and returning false keeps the caller's
  // copy-then-remove symmetric (it will not then delete the record it "copied").
  if (fromProfile === toProfile) return false;
  // Fast-path work check (unlocked): an absent source is a no-op without creating the dir/lock.
  const preview = readDocument(deps.homeDir);
  if (!preview || !Object.hasOwn(preview, fromProfile)) return false;
  const dir = insecureDir(deps.homeDir);
  // ISS-202 (T-213): serialize the read-modify-write; re-read UNDER the lock.
  return withInsecureFileLock(
    dir,
    () => {
      const existing = readDocument(deps.homeDir);
      if (!existing || !Object.hasOwn(existing, fromProfile)) return false;
      const doc: CredentialDocument = Object.create(null) as CredentialDocument;
      for (const key of Object.keys(existing)) {
        if (Object.hasOwn(existing, key)) doc[key] = existing[key] as CredentialRecord;
      }
      doc[toProfile] = doc[fromProfile] as CredentialRecord; // COPY — source retained
      atomicWrite0600(dir, insecureCredentialsPath(deps.homeDir), JSON.stringify(doc, null, 2) + "\n");
      return true;
    },
    deps.lock,
  );
}

/** Create + write `file` atomically at mode 0600 (never following a symlink). */
function atomicWrite0600(dir: string, file: string, text: string): void {
  const tmp = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
  let fd: number;
  // O_EXCL => fail if it already exists (no clobber); O_NOFOLLOW => never a symlink;
  // mode 0o600 => 0600 from CREATION (no umask-widened window).
  fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
  try {
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
    // Belt-and-suspenders on platforms where the create mode is umask-masked. This is
    // deliberately best-effort: the temp was ALREADY created 0600 by O_CREAT's mode
    // arg, so a chmod failure leaves it 0600 and we proceed to rename — it does NOT
    // trip the cleanup below (there is nothing unsafe to clean up).
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort */
    }
    renameSync(tmp, file); // atomic on the same filesystem; replaces a symlink target itself
  } catch (err) {
    // A write / fsync / rename failure must not leave behind a 0600 temp file that
    // still holds credential bytes — unlink it. On success the file was renamed away,
    // so there is nothing here to clean up.
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Store `record` under `profile` in the insecure file. PL-14: the CI double-opt-in
 * is re-checked HERE, on EVERY write. Existing profiles are PRESERVED
 * (read-modify-write); a pre-existing widened file is refused before overwrite.
 */
export function writeInsecureRecord(profile: string, record: CredentialRecord, deps: InsecureFileDeps): void {
  // PL-14 (writes-only, re-checked each write).
  if (requiresDoubleOptIn(deps.env, deps.isTTY) && !insecureDoubleOptInSatisfied(deps.env)) {
    throw new InsecureStorageRefusedError(
      "refusing to write plaintext credentials: under CI / non-interactive, --insecure-storage also " +
        "requires AGKIT_ALLOW_INSECURE_STORAGE=1 (double opt-in). Prefer AGKIT_TOKEN or a keychain login.",
    );
  }

  const dir = insecureDir(deps.homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealDir(deps.homeDir); // reject a symlinked/non-directory parent post-mkdir
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }

  // Read-modify-write: preserve every OTHER profile; a widened existing file throws.
  // The merged document has a NULL prototype so a `__proto__` profile key is stored
  // as an ordinary own property, never mutating a prototype.
  //
  // ISS-202 (T-213, RESOLVED): `login --insecure-storage` + `logout`/`--all-profiles` make
  // this RMW (and remove/copy above) concurrently user-reachable, so the read-merge-write is
  // held under an O_CREAT|O_EXCL lock (file-lock.ts: bounded acquisition, dead/stale reclamation,
  // 0600, finally-release). Two racing writers to different profiles now both persist. The
  // document is RE-READ under the lock.
  withInsecureFileLock(
    dir,
    () => {
      const existing = readDocument(deps.homeDir);
      const doc: CredentialDocument = Object.create(null) as CredentialDocument;
      if (existing) {
        for (const key of Object.keys(existing)) {
          if (Object.hasOwn(existing, key)) doc[key] = existing[key] as CredentialRecord;
        }
      }
      doc[profile] = record;
      atomicWrite0600(dir, insecureCredentialsPath(deps.homeDir), JSON.stringify(doc, null, 2) + "\n");
    },
    deps.lock,
  );
}
