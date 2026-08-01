// T-222 step 7 (B7 cascade) — the CLI-OWNED, credential-free npm user config the self-update child
// is pointed at, and the fs work that guarantees it exists. `sanitizeChildEnv` (core/service) builds
// the npm child's environment from a strict allowlist, but `HOME` is ON that allowlist — npm cannot
// resolve its cache/prefix without it — so unless `npm_config_userconfig` names somewhere else the
// `npm install -g` child READS THE INVOKING USER'S `~/.npmrc`, which commonly holds a registry
// `_authToken`. Pointing npm at an empty file WE own is what actually makes the allowlist's "the
// child receives no credential" guarantee true.
//
// This lives in `src/cli/` (beside the other real-I/O binders, wire-client / wire-auth) rather than
// in `core/**`, which stays free of direct fs/process access — the pure sanitizer takes the path as
// an option precisely because building it is an fs concern.
import { join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stateDirPath, type ConfigDirDeps } from "../core/config";
import { CliLocalError } from "../core/errors";

/**
 * The file name of the CLI-owned npm user config. It lives in the CLI's own state dir (the same dir
 * the update-check stamp and the capability cache use), NOT beside the user's own `.npmrc`, and is
 * deliberately named so it can never be mistaken for one.
 */
export const CHILD_NPMRC_FILENAME = "child-npmrc";

/**
 * The ONLY bytes this file may hold: a static, credential-free ini comment. It doubles as the
 * OWNERSHIP MARKER — a file at that path whose content is neither this nor empty belongs to someone
 * else and is never written over. Static by construction (no path, no env, nothing derived).
 */
export const CHILD_NPMRC_CONTENT = "; agkit-owned: deliberately empty so the npm child reads no credentials\n";

/**
 * Ensure the credential-free npm user config exists and return its ABSOLUTE path (the value
 * `sanitizeChildEnv` sets as `npm_config_userconfig` for EVERY child it spawns).
 *
 * IDEMPOTENT by construction: the create is `wx` (`O_CREAT|O_EXCL`), so it either creates the file
 * or fails — it can never truncate, which makes a repeat run and a concurrent run equally safe. An
 * EXISTING path is VERIFIED, never overwritten (`isOwnedChildNpmrc`).
 *
 * FAIL-CLOSED on every fs fault (read-only filesystem, EACCES, an occupied path). The only other
 * option is to spawn with no override, which silently hands the child exactly the `~/.npmrc`
 * credential this cascade exists to withhold — so the real choice is between a refused self-update
 * and a possibly-leaked registry token. A refusal is recoverable (the `upgrade` handler's hint
 * carries the manual npm command, and a filesystem that cannot take this file could not have
 * completed a global install anyway); a token exposed to a package's install lifecycle is not.
 * Refuse.
 */
export function ensureChildNpmrc(dirs: ConfigDirDeps): string {
  const dir = stateDirPath(dirs);
  const path = join(dir, CHILD_NPMRC_FILENAME);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, CHILD_NPMRC_CONTENT, { mode: 0o600, flag: "wx" });
    return path;
  } catch (err) {
    // EEXIST is the ordinary second-run case — everything else (EROFS, EACCES, ENOSPC…) is a genuine
    // inability to prepare the file, and there is no safe way to continue without it.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw childNpmrcRefusal();
  }
  if (!isOwnedChildNpmrc(path)) throw childNpmrcRefusal();
  return path;
}

/**
 * Is the path OUR credential-free npmrc (or an empty file)? `lstat`, not `stat`: a SYMLINK planted
 * at our path is not our file whatever it resolves to, and a directory / FIFO is not one either.
 * The 0600 mode is asserted at CREATE only and deliberately NOT re-checked here — Node SYNTHESIZES
 * mode bits on Windows, so gating the verify on them would refuse every Windows upgrade. Any fault
 * (unreadable, vanished between the create attempt and here) answers "not ours" — unprovable is a no.
 */
export function isOwnedChildNpmrc(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    const existing = readFileSync(path, "utf8");
    return existing === "" || existing === CHILD_NPMRC_CONTENT;
  } catch {
    return false;
  }
}

/**
 * The ONE refusal for a child npmrc we cannot prepare. STATIC and value-free: no path, no errno,
 * nothing read out of the environment — the CONDITION is surfaced, never its inputs. `usage_error`
 * is the closed set's catch-all for a determinate local-environment fault (terminal, exit 2).
 */
function childNpmrcRefusal(): CliLocalError {
  return new CliLocalError("usage_error", {
    detail: "the self-update cannot prepare a credential-free npm config for its child process",
    hint: "ensure the agkit state directory is writable and its child npm config file is not occupied, then retry",
  });
}
