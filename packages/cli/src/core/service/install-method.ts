// T-222 step 7 (§4.7 + A8) — EVIDENCE-BASED install-method detection for `agkit upgrade`. Pure and
// deps-injected (no `process`/`node:child_process`/`node:fs` here). The verdict decides whether the
// upgrade may MUTATE the install: ONLY `npm-global` runs `npm install -g`; every other verdict PRINTS
// the manual command and touches nothing (ticket FORBIDDEN 3). Detection itself is non-mutating —
// it may run a READ-ONLY `npm root -g` probe (A8), never the install child.
import type { ProbeChildResult } from "../../commands/command-seams";
import { PACKAGE_NAME } from "../housekeeping/update-check-child";

/** The four evidence classes. Only `npm-global` authorizes a mutating self-update. */
export type InstallMethod = "npm-global" | "npx" | "dev" | "unknown";

/** Bounded watchdog for the READ-ONLY `npm root -g` probe (A8: "bounded 10 s"). */
export const NPM_ROOT_PROBE_TIMEOUT_MS = 10_000;

/** Everything detection reads — all injected so the whole flow is unit-tested with no real exec/fs. */
export interface InstallMethodDeps {
  /** `process.argv[1]` (the invoked bin path), or undefined on a runtime that provides none. */
  readonly argv1: string | undefined;
  /** Resolve symlinks; null on any failure (a null realpath can never prove a global install). */
  readonly realpath: (path: string) => string | null;
  /** The READ-ONLY `npm root -g` probe (A8) — captures the global package root, never mutates. */
  readonly probeChild: (
    cmd: string,
    args: readonly string[],
    opts: { timeoutMs: number },
  ) => Promise<ProbeChildResult>;
  /** The build-time dev flag (`IS_DEV`) — a dev build is never a real published install. */
  readonly isDev: boolean;
  /** The OS platform — selects the npm binary name + the path separator for the under-prefix test. */
  readonly platform: NodeJS.Platform;
}

/** The npm binary name for this platform (Windows ships the `.cmd` shim on PATH). */
export function npmCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Classify how THIS binary was installed, from evidence only:
 *   1. `dev`        — the build carries the dev flag (`IS_DEV`); never a published install.
 *   2. `npx`        — the resolved bin path sits in an npx cache (`/_npx/` segment).
 *   3. `npm-global` — the resolved bin path is UNDER the resolved `<npm root -g>/<PACKAGE_NAME>`
 *      package directory.
 *   4. `unknown`    — anything else (Homebrew, a vendored copy, a null realpath, no root).
 * The proof deliberately narrows to THIS package's own directory, not the surrounding global tree:
 * sharing a tree with the global install is not evidence that npm owns the running binary. Where the
 * global tree is a shared FHS root, an Intel-Homebrew cellar path or any other unrelated install
 * under that same root would otherwise be read as npm-global — and `npm install -g` would then mutate
 * a DIFFERENT binary than the one executing, leaving the invoked one silently un-upgraded.
 * The `npm root -g` probe runs ONLY for the (not-dev, not-npx) case — dev/npx are proven without
 * it — so the read-only child is used minimally and the install child is never run here.
 */
export async function detectInstallMethod(deps: InstallMethodDeps): Promise<InstallMethod> {
  if (deps.isDev) return "dev";

  const real = deps.argv1 !== undefined ? deps.realpath(deps.argv1) : null;
  if (real === null) return "unknown"; // no resolvable bin path ⇒ we cannot prove a global install.

  // npx runs from a content-addressed cache dir; both separators covered (a win32 realpath is `\`).
  if (real.includes("/_npx/") || real.includes("\\_npx\\")) return "npx";

  // npm-global vs unknown: is the resolved bin inside the global install of THIS package?
  const probe = await deps.probeChild(npmCommand(deps.platform), ["root", "-g"], {
    timeoutMs: NPM_ROOT_PROBE_TIMEOUT_MS,
  });
  if (!probe.ok || probe.stdout.length === 0) return "unknown";
  const pkgDir = globalPackageDir(probe.stdout, deps.platform);
  if (pkgDir === null) return "unknown";
  // Resolve the package directory ITSELF (not just the root): a symlinked global tree must be
  // compared physical-path to physical-path, and a directory that does not exist — this package is
  // not installed globally at all — fails closed here rather than authorizing a mutation.
  const pkgDirReal = deps.realpath(pkgDir);
  if (pkgDirReal === null) return "unknown";

  return pathIsUnder(real, pkgDirReal, deps.platform) ? "npm-global" : "unknown";
}

/**
 * The directory a global `npm install -g` puts THIS package in: `<npm root -g>/<PACKAGE_NAME>`, with
 * the scoped name's `/` re-separated for the platform. `PACKAGE_NAME` is imported, never spelled a
 * second time, so a rename can never leave the detection pointing at a stale directory. Null when
 * the probed root is the filesystem root — such a "root" contains every absolute path, so it can
 * never single out this package and is zero evidence.
 */
export function globalPackageDir(globalRoot: string, platform: NodeJS.Platform): string | null {
  const sep = platform === "win32" ? "\\" : "/";
  const root = trimTrailingSep(globalRoot, sep);
  if (isFilesystemRoot(root, platform)) return null;
  return root + sep + PACKAGE_NAME.split("/").join(sep);
}

/**
 * Is `child` the same as, or nested under, `parent`? Segment-aware (a `parent` of `/usr/local`
 * must NOT match a sibling `/usr/local-x`): equal, or `child` starts with `parent + sep`. Both
 * inputs are already realpath-resolved by the caller, so this is a pure lexical containment test.
 * A `parent` that is the filesystem root is rejected outright: it contains EVERY absolute path, so
 * containment under it distinguishes nothing and must never stand in for proof.
 */
export function pathIsUnder(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const sep = platform === "win32" ? "\\" : "/";
  // Windows paths are case-insensitive; compare case-folded there (a POSIX fs is case-sensitive).
  const c = platform === "win32" ? child.toLowerCase() : child;
  const p = platform === "win32" ? parent.toLowerCase() : parent;
  const pTrim = trimTrailingSep(p, sep); // normalize a trailing separator on the prefix
  if (isFilesystemRoot(pTrim, platform)) return false;
  return c === pTrim || c.startsWith(pTrim + sep);
}

/** Drop ONE trailing separator so `<dir>/` and `<dir>` compare and join identically. */
function trimTrailingSep(path: string, sep: string): string {
  return path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** A trailing-separator-trimmed path that names a filesystem root: `/` (⇒ "") or a bare win32 drive. */
function isFilesystemRoot(trimmed: string, platform: NodeJS.Platform): boolean {
  return trimmed.length === 0 || (platform === "win32" && trimmed.endsWith(":"));
}
