// The REAL node:fs adapters behind the injected housekeeping ports (T-209, canonical
// L2-CLI-19). All the paranoia lives HERE so the orchestration (install.ts,
// update-check*.ts) stays pure over injected seams: every open uses O_NOFOLLOW (never
// follow a symlinked final component), lock creation is O_CREAT|O_EXCL, and the stamp
// write is an O_EXCL temp file + atomic rename at 0600 — mirroring
// src/core/auth/insecure-file.ts. This module is only ever wired in by
// buildHousekeepingDeps (production) and the detached helper entry; tests use fakes and
// never touch it.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { FsHandle, FsStat, InstallFs } from "./install";

/** O_NOFOLLOW is POSIX; 0 where absent (Windows) — harmless there. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** O_NONBLOCK on the READ opens so a planted FIFO/device can't block `openSync`
 * indefinitely and hang the CLI (codex chunk-B); a no-op for regular files. 0 if absent. */
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
/** Cap any single-file read (skill files are tiny; the stamp is a few hundred bytes). */
const MAX_READ_BYTES = 1024 * 1024;

/** Node fs errors carry `.code`; narrow without `any`. */
function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/** Read the whole of an already-open fd (bounded) as utf8. */
function readAllUtf8(fd: number, size: number): string {
  const cap = Math.min(size, MAX_READ_BYTES);
  const buf = Buffer.allocUnsafe(cap);
  let read = 0;
  while (read < cap) {
    const n = readSync(fd, buf, read, cap - read, read);
    if (n === 0) break;
    read += n;
  }
  return buf.subarray(0, read).toString("utf8");
}

/** Open + read a small file utf8 without following a symlinked final component. */
function readUtf8NoFollow(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = errCode(err);
    // Absent, or a symlink at the final component (ELOOP) -> treat as "not present".
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    return readAllUtf8(fd, Number(st.size));
  } finally {
    closeSync(fd);
  }
}

/** Write `data` to a NEW file (O_EXCL) at `mode`, following no symlink. */
function writeNewNoFollow(path: string, data: string, mode: number): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, mode);
  try {
    const buf = Buffer.from(data, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written, written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copy a REGULAR file src->dest at `mode`, following no symlink at either end. */
function copyFileNoFollow(src: string, dest: string, mode: number): void {
  const srcFd = openSync(src, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  let data: string;
  try {
    const st = fstatSync(srcFd);
    if (!st.isFile()) throw new Error(`refusing to copy ${src}: not a regular file`);
    if (Number(st.size) > MAX_READ_BYTES) throw new Error(`refusing to copy ${src}: too large`);
    data = readAllUtf8(srcFd, Number(st.size));
  } finally {
    closeSync(srcFd);
  }
  writeNewNoFollow(dest, data, mode);
}

/**
 * Read a symlink's target verbatim (T-224 D1: the leaf-follow walk in install.ts resolves
 * the dest link itself rather than clobbering it). This is the ONLY port op that observes a
 * link target, and it observes it WITHOUT following anything: `readlinkSync` never traverses.
 * Two "there is no link target here" shapes collapse to null — ENOENT (nothing at the path)
 * and EINVAL (there IS something, but it is not a symlink); anything else (EACCES, ELOOP on a
 * symlinked ANCESTOR, EIO) throws so a genuine fault is never mistaken for "not a link".
 */
function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path, "utf8");
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT" || code === "EINVAL") return null;
    throw err;
  }
}

/** `bigint: true` so `dev`/`ino` arrive EXACT: a 64-bit inode rounded through a JS number could
 *  make two distinct nodes share an id, and an id collision here means deleting a directory we
 *  did not create. `mtimeMs` is only ever compared at millisecond resolution, so it narrows back
 *  to a number safely. */
function toStat(s: import("node:fs").BigIntStats): FsStat {
  return {
    isFile: () => s.isFile(),
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
    mtimeMs: Number(s.mtimeMs),
    id: `${s.dev}:${s.ino}`,
  };
}

/** The production InstallFs — every op wired to node:fs with the paranoid flags. */
export function realInstallFs(): InstallFs {
  return {
    lstat(path: string): FsStat | null {
      try {
        return toStat(lstatSync(path, { bigint: true }));
      } catch (err) {
        if (errCode(err) === "ENOENT") return null;
        throw err;
      }
    },
    mkdir(path: string, mode: number): void {
      mkdirSync(path, { recursive: true, mode });
    },
    mkdirExclusive(path: string, mode: number): void {
      // NON-recursive: EEXIST when anything (dir, file, symlink) occupies the path — the
      // custody proof the staging sweep requires. A missing parent throws ENOENT.
      mkdirSync(path, { mode });
    },
    openExclusive(path: string, mode: number): FsHandle {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, mode);
      try {
        // fstat on the DESCRIPTOR, not the path: the id belongs to the node we hold, and holding
        // it is what stops the kernel handing this inode to anyone else.
        const st = fstatSync(fd, { bigint: true });
        let open = true;
        return {
          id: `${st.dev}:${st.ino}`,
          close: () => {
            if (!open) return;
            open = false;
            closeSync(fd);
          },
        };
      } catch (err) {
        closeSync(fd);
        throw err;
      }
    },
    readdir(path: string): string[] {
      try {
        return readdirSync(path);
      } catch (err) {
        if (errCode(err) === "ENOENT") return [];
        throw err;
      }
    },
    rename(from: string, to: string): void {
      renameSync(from, to);
    },
    rmrf(path: string): void {
      rmSync(path, { recursive: true, force: true });
    },
    unlink(path: string): void {
      try {
        unlinkSync(path);
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
      }
    },
    readlink: readlinkOrNull,
    copyFile: copyFileNoFollow,
    writeNew: writeNewNoFollow,
    readUtf8: readUtf8NoFollow,
    tryCreateLock(path: string, mode: number): boolean {
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, mode);
        closeSync(fd);
        return true;
      } catch (err) {
        if (errCode(err) === "EEXIST") return false;
        throw err;
      }
    },
  };
}

/** Read the update-check stamp as utf8; null if absent (shared with the child). */
export function readStampText(path: string): string | null {
  return readUtf8NoFollow(path);
}

/**
 * Atomically write the update-check stamp: create the state dir, write an O_EXCL temp
 * file at 0600, then rename it over the stamp (atomic on the same fs; replaces a symlink
 * target itself). Cleans the temp on any failure so a partial write never lingers.
 */
let stampTmpCounter = 0;

export function writeStampAtomic(path: string, data: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // pid + ms + a process-local counter so even same-millisecond writes get a unique temp
  // (each call cleans up only the temp IT created on failure — codex chunk-B warning).
  const tmp = join(dir, `.update-check.${process.pid}.${Date.now()}.${stampTmpCounter++}.tmp`);
  try {
    writeNewNoFollow(tmp, data, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** The stamp I/O pair the detached helper entry wires in. */
export function realStampIo(): {
  readStampText: (path: string) => string | null;
  writeStampAtomic: (path: string, data: string) => void;
} {
  return { readStampText, writeStampAtomic };
}

/**
 * spawn the detached update-check helper: its own process group (`detached`), no
 * stdio, and `.unref()` so the PARENT can exit immediately without waiting on the
 * child. This is what makes the check TRULY non-blocking (an un-awaited in-process
 * fetch would keep the event loop alive and delay exit — codex C4).
 */
export function realSpawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  // A spawn that fails (helper path vanished, exec not runnable) emits an ASYNC 'error'
  // event; with NO listener that surfaces as an uncaught exception that could crash the
  // CLI after its real work. Housekeeping must never affect the command — swallow it
  // (codex chunk-B). The event fires post-`.unref()`, outside the caller's try/catch.
  child.on("error", () => {
    /* best-effort: a failed update-check spawn is silently ignored */
  });
  child.unref();
}
