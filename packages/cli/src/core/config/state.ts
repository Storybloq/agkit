// State/cache dir helpers (T-208, deliverable 1 + 5). `<config-dir>/state/` holds
// NON-secret caches — today just the best-effort update-check stamp `status` reads.
// The stamp is WRITTEN by a future background update-check (a later ticket / T-211's
// client can populate it after a handshake); `status` only READS it best-effort, so
// an absent or malformed stamp is simply "no update known" (never an error).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirPath, type ConfigDirDeps } from "./dirs";

/** The update-check stamp file within the state dir. */
export function updateStampPath(deps: ConfigDirDeps): string {
  return join(stateDirPath(deps), "update-check.json");
}

/** What `readUpdateStamp` returns: the newer version (if any) + a ready-to-mirror notice. */
export interface UpdateInfo {
  readonly latest: string | null;
  readonly notice: string | null;
}

const NONE: UpdateInfo = { latest: null, notice: null };

/**
 * Best-effort: read the update-check stamp and, if it names a version NEWER than the
 * running `current`, return it + a human notice. Absent/malformed stamp, a dev
 * build, or an unparseable version -> `NONE`. NEVER throws (status must stay exit 0).
 */
export function readUpdateStamp(deps: ConfigDirDeps, current: string): UpdateInfo {
  let text: string;
  try {
    text = readFileSync(updateStampPath(deps), "utf8");
  } catch {
    return NONE; // absent (or unreadable) -> nothing known
  }
  let latest: unknown;
  try {
    latest = (JSON.parse(text) as { latest_version?: unknown }).latest_version;
  } catch {
    return NONE;
  }
  if (typeof latest !== "string" || latest.length === 0) return NONE;
  if (!isNewer(latest, current)) return NONE;
  return {
    latest,
    notice: `agkit: a newer version is available (${current} -> ${latest}). Update: npm install -g @storybloq/agkit@latest\n`,
  };
}

/** Parse the leading numeric components of a version string (e.g. "0.1.2" -> [0,1,2]). */
function numericParts(version: string): number[] {
  return version
    .split(/[.+-]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

/** Is `latest` strictly newer than `current`? Conservative: a dev/unparseable build -> false. */
function isNewer(latest: string, current: string): boolean {
  if (current.includes("dev")) return false; // never nag a local dev build
  const a = numericParts(latest);
  const b = numericParts(current);
  if (a.length === 0 || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
