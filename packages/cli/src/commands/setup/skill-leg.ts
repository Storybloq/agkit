// T-224 leg 1 — the SKILL TREE (`~/.claude/skills/agkit`).
//
// The apply arm calls `installSkill` — the SAME engine, under the SAME O_EXCL lock, that
// housekeeping uses. `setup` is housekeeping-EXEMPT (D2) precisely so that there is still exactly
// ONE writer for this directory: two processes staging and renaming into the same tree is a real
// hazard, and the exemption removes the second one rather than adding coordination.
//
// The check arm never calls the installer at all. It reads through the SAME pair the installer
// classifies with (`resolveInstallTarget` → `classifyDest`, D1v3a/D1v5b), so "what --check says"
// and "what apply would do" cannot disagree: they are the same two functions over the same bytes.
// One extra read-only probe closes the remaining gap — a `.agkit-txn.json` record means an install
// was INTERRUPTED, and only a locked recovery can settle it, so `--check` reports drift rather
// than guessing (validating the record here would be a mutation decision made without the lock).
import { join } from "node:path";
import {
  classifyDest,
  describeUnexpected,
  installSkill,
  resolveInstallTarget,
  skillDestPath,
  skillsDirPath,
  TXN_RECORD_NAME,
  type InstallResult,
} from "../../core/housekeeping/install";
import { displayCapped } from "../../core/output/display";
import { leg, type SetupDeps, type SetupLeg } from "./legs";

const NAME = "skill";
/** Path renders are bounded + sanitized before they ride a detail string (D-detail-sanitize). */
const PATH_MAX = 200;

export function skillLeg(deps: SetupDeps): SetupLeg {
  return deps.check ? checkSkill(deps) : applySkill(deps);
}

/** READ-ONLY. Nothing here creates, locks, stages or renames anything. */
function checkSkill(deps: SetupDeps): SetupLeg {
  const { installFs: fs } = deps;
  const dest = skillDestPath(deps.homeDir);
  const path = displayCapped(dest, PATH_MAX);

  // An interrupted install outranks every other verdict: the tree may be mid-swap, and settling it
  // requires the lock. Honest answer — "not converged; an apply must recover it first".
  if (fs.lstat(join(skillsDirPath(deps.homeDir), TXN_RECORD_NAME)) !== null) {
    return leg(NAME, "would_change", `${path}: an interrupted install is pending recovery`, { path: dest });
  }

  const resolved = resolveInstallTarget(fs, dest);
  if (!resolved.ok) {
    return leg(NAME, "refused", `${path}: the install path cannot be resolved (${resolved.reason})`, {
      path: dest,
      reason: resolved.reason,
    });
  }
  const cls = classifyDest(fs, resolved.path, deps.version);
  switch (cls.status) {
    case "current":
      return leg(NAME, "current", `${path}: skill tree current (v${cls.installedVersion})`, {
        path: dest,
        installed_version: cls.installedVersion,
      });
    case "absent":
      return leg(NAME, "would_change", `${path}: the skill tree is not installed`, { path: dest });
    case "stale-managed":
      return leg(
        NAME,
        "would_change",
        `${path}: the skill tree is out of date (installed v${cls.installedVersion ?? "none"}, running v${deps.version})`,
        { path: dest, installed_version: cls.installedVersion },
      );
    case "unmanaged":
      return leg(NAME, "refused", `${path}: this is not an agkit skill tree — ${describeUnexpected(cls.unexpected)}`, {
        path: dest,
        unexpected: cls.unexpected,
      });
  }
}

/** APPLY. One `installSkill` call; every status it can return maps to an honest leg. */
function applySkill(deps: SetupDeps): SetupLeg {
  const dest = skillDestPath(deps.homeDir);
  const path = displayCapped(dest, PATH_MAX);
  let result: InstallResult;
  try {
    result = installSkill({
      sourceDir: deps.sourceDir,
      homeDir: deps.homeDir,
      version: deps.version,
      pid: deps.pid,
      now: deps.now,
      fs: deps.installFs,
    });
  } catch {
    // A genuinely failed copy throws (the engine's contract). Nothing was published — no success
    // is ever claimed before the complete tree is renamed into place — so this is retryable.
    return leg(NAME, "refused", `${path}: the skill tree could not be installed — re-run \`agkit setup\``, {
      path: dest,
    });
  }
  return mapInstall(result, dest, path, deps.version);
}

function mapInstall(result: InstallResult, dest: string, path: string, version: string): SetupLeg {
  const facts: Record<string, unknown> = { path: dest };
  switch (result.status) {
    case "installed":
      return leg(NAME, "done", `${path}: skill tree installed (v${version})`, facts);
    case "current":
    case "current-after-lock": {
      // The MARKER's version, not ours: under downgrade-reject (M8) a NEWER tree classifies
      // current for an older CLI, and labeling it with the running version would misreport the
      // disk — and disagree with the check arm, which reads the marker.
      const installed = result.installedVersion ?? version;
      return leg(NAME, "current", `${path}: skill tree current (v${installed})`, {
        ...facts,
        installed_version: installed,
      });
    }
    case "locked":
      // Another agkit invocation holds the install lock. Not a failure and not converged: the
      // honest report is "run it again", which is exactly what `manual` means here.
      return leg(NAME, "manual", `${path}: another agkit install is in flight`, {
        ...facts,
        command: "agkit setup",
      });
    case "source-invalid":
      return leg(NAME, "refused", `${path}: this build's bundled skill/ directory is incomplete or unreadable`, facts);
    case "unmanaged-dest":
      return leg(NAME, "refused", detailOf(result, path), { ...facts, unexpected: result.unexpected });
    case "dest-unresolvable":
      return leg(NAME, "refused", detailOf(result, path), facts);
    case "txn-unverifiable":
      // Everything is RETAINED — the record, the staging dir and the backup. We name the paths so
      // the operator can resolve it; we do not delete or restore anything on a guess.
      return leg(NAME, "refused", detailOf(result, path), { ...facts, txn: result.txn });
  }
}

/** The engine's own detail (already display-sanitized), or a bounded fallback. */
function detailOf(result: InstallResult, path: string): string {
  return result.detail ?? `${path}: the skill tree was not installed (${result.status})`;
}
