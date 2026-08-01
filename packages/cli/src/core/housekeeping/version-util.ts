// Tiny, dependency-free version helpers shared by the skill-install downgrade policy
// and the update-check freshness/validation logic (T-209, canonical L2-CLI-19). These
// deliberately DO NOT depend on the state.ts `isNewer` (which is conservative about
// dev builds for the update NOTICE): install-time comparison must be a plain semver
// ordering (dev builds never reach install — they are housekeeping-exempt), and the
// update-check helper needs a strict "is this a real version string" gate on whatever
// the npm registry returns before it is trusted into the stamp.

/** Longest run of digits we accept in one numeric component — 9 digits stays a safe,
 * exact integer (real semver components are tiny). A longer run is treated as junk so a
 * hostile registry can never push a value that loses precision / reads as `Infinity`. */
const MAX_CORE_SEGMENT = /^\d{1,9}$/;

/**
 * The `MAJOR.MINOR.PATCH` (and any further numeric dot-separated) components, ignoring a
 * pre-release / build suffix. `"1.2.3"` -> `[1,2,3]`; `"1.2.3-rc.1"` -> `[1,2,3]`. A
 * core segment that is NOT a bounded run of digits invalidates the WHOLE version (-> `[]`),
 * NOT just the prefix before it: `"1.2.3.junk"` and `"1.2.3."` are junk, not `1.2.3` —
 * an untrusted registry response must never smuggle a bad tail past validation by
 * hiding behind a good prefix (codex chunk-A/C blocker).
 */
function coreParts(version: string): number[] {
  const core = version.split(/[-+]/, 1)[0] ?? "";
  const parts: number[] = [];
  for (const seg of core.split(".")) {
    if (!MAX_CORE_SEGMENT.test(seg)) return [];
    parts.push(Number.parseInt(seg, 10));
  }
  return parts;
}

/**
 * A minimal validity gate: a clean `MAJOR.MINOR.PATCH` (or longer) numeric core. Rejects
 * the empty string, `"latest"`, trailing junk like `"1.2.3.foo"`, oversized components,
 * and any non-version junk an untrusted registry response might carry. NOT a full semver
 * validator — just enough that we never write nonsense into the stamp or compare against
 * garbage. (`"0.0.0-dev"` parses to a valid `0.0.0` core; dev is housekeeping-exempt
 * upstream, so it never reaches install / update-check regardless.)
 */
export function isValidVersion(version: string): boolean {
  return coreParts(version).length >= 3;
}

/**
 * Compare two version strings by their numeric core: -1 if `a < b`, 0 if equal, 1 if
 * `a > b`. Missing trailing components read as 0 (`"1.2"` == `"1.2.0"`). Pre-release
 * suffixes are ignored (install compares release lines only). Callers gate inputs
 * through `isValidVersion` first.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = coreParts(a);
  const pb = coreParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Parse an ISO-8601 timestamp to epoch ms, or null if it is not a usable string. */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
