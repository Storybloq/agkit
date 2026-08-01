// ISS-570 anti-staleness housekeeping — public surface + the production dep factory +
// the two guarded phases run.ts hooks (T-209, canonical L2-CLI-19, deliverable 3,
// codex M6/M7). The whole module is fully seam-injected (install.ts / update-check.ts
// / update-check-child.ts take injected fs/network/spawn/clock), so this file is the
// ONE place the real process/os/fs/child_process seams are wired in, and the ONE place
// run.ts calls.
//
// Self-seeding contract (D4): there is no `setup` command yet (L2-CLI-18). The RUNTIME
// re-copy IS the mechanism — the first eligible (non-dev, non-mcp) PRODUCTION
// invocation stages + publishes the skill tree, and a bumped binary version re-syncs it
// on the next interactive run (the ISS-570 acceptance). A failed copy stays retryable
// (the next invocation retries); no success is claimed before the tree is published.
// L2-CLI-18's `setup` will later reuse installSkill — it is NOT built here.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../version";
import { readUpdateStamp, updateStampPath, type UpdateInfo } from "../config/state";
import { installSkill, type InstallDeps } from "./install";
import { kickUpdateCheck, type UpdateKickDeps } from "./update-check";
import { realInstallFs, readStampText, realSpawnDetached } from "./node-fs";

export { isHousekeepingExempt, type ExemptOptions } from "./exempt";
export {
  installSkill,
  type InstallDeps,
  type InstallFs,
  type InstallResult,
  type InstallStatus,
  type FsStat,
} from "./install";
export { kickUpdateCheck, type UpdateKickDeps, type KickStatus } from "./update-check";
export { runUpdateCheckChild, type UpdateCheckChildDeps } from "./update-check-child";

/** The banner-phase seam (POST): read the completed stamp + emit to a TTY stderr. */
export interface BannerDeps {
  /** Whether STDERR is a TTY — the banner is emitted ONLY then (never in a pipe/--json). */
  readonly stderrIsTTY: boolean;
  /** Best-effort stderr sink (must not throw). */
  readonly warn: (message: string) => void;
  /** Read the update info (production: readUpdateStamp over the real config dir). */
  readonly readUpdateInfo: () => UpdateInfo;
}

/** The full dep set both phases consume. Built once (per run) by buildHousekeepingDeps. */
export interface HousekeepingDeps extends InstallDeps, UpdateKickDeps, BannerDeps {}

/**
 * PRE phase (before parse): install/re-sync the skill tree, then kick the detached
 * update check. Each sub-step is INDEPENDENTLY guarded — an install throw must not
 * skip the update-check kick, and NEITHER may escape (run.ts also wraps this call, so
 * a housekeeping fault can never change the command's exit code or touch stdout).
 */
export function preCommandHousekeeping(deps: HousekeepingDeps): void {
  try {
    installSkill(deps);
  } catch {
    /* best-effort: a failed copy stays retryable on the next invocation (D4) */
  }
  try {
    kickUpdateCheck(deps);
  } catch {
    /* best-effort: a broken spawn/stamp read never affects the command */
  }
}

/**
 * POST phase (after parse): the update banner. STDERR-only, TTY-only, AFTER the command
 * output. NEVER stdout, NEVER the `--json` document (the banner rides on stderr, which
 * is never part of the machine document — and it is suppressed entirely when stderr is
 * not a TTY, i.e. whenever output is piped/redirected). Fully guarded.
 */
export function emitUpdateBanner(deps: HousekeepingDeps): void {
  try {
    if (!deps.stderrIsTTY) return;
    const info: UpdateInfo = deps.readUpdateInfo();
    if (info.notice) deps.warn(info.notice);
  } catch {
    // A malformed/absent stamp, or a throwing sink, is simply "nothing to announce" —
    // the banner is best-effort and must never affect the command (run.ts also wraps).
  }
}

/**
 * The shipped `skill/` source dir, anchored to the EMITTED bundle location (dist/…): the skill
 * source ships beside dist as `<pkg>/skill/`. NO cwd fallback (C1).
 *
 * T-224: exported because `agkit setup` is a SECOND caller of `installSkill` (it is housekeeping-
 * exempt and owns its own install, D2) and the shell threads this onto the service seam for it.
 * One rule, one function — the two writers can never target different bytes.
 */
export function skillSourceDir(): string {
  return fileURLToPath(new URL("../skill/", import.meta.url));
}

/**
 * Build the production housekeeping deps from the real process/os/fs/child_process
 * seams. Source + helper paths are anchored to `import.meta.url` of the emitted bundle
 * (dist/): `../skill/` is the shipped skill dir, `./update-check.js` is the detached
 * helper entry — NO cwd fallback (C1). Every fs/network/spawn op is a real adapter.
 */
export function buildHousekeepingDeps(): HousekeepingDeps {
  const env = process.env;
  const homeDir = os.homedir();
  const dirDeps = { env, homeDir };
  const sourceDir = skillSourceDir();
  const helperPath = fileURLToPath(new URL("./update-check.js", import.meta.url));
  const fs = realInstallFs();
  const now = (): number => Date.now();
  return {
    // install (InstallDeps)
    sourceDir,
    homeDir,
    version: VERSION,
    pid: process.pid,
    now,
    fs,
    // update-check kick (UpdateKickDeps)
    env,
    stampPath: updateStampPath(dirDeps),
    execPath: process.execPath,
    helperPath,
    readStampText,
    spawnDetached: realSpawnDetached,
    // banner (BannerDeps)
    stderrIsTTY: Boolean(process.stderr.isTTY),
    warn: (message: string) => {
      try {
        process.stderr.write(message, () => {
          /* swallow async EPIPE — diagnostics are best-effort */
        });
      } catch {
        /* swallow a synchronous throw too */
      }
    },
    readUpdateInfo: () => readUpdateStamp(dirDeps, VERSION),
  };
}
