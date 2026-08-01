// Load / save config.json (T-208, deliverable 1). NON-secret, so mode 0644 (vs
// T-206's 0600 credentials file) — but we borrow that file's atomic-write +
// symlinked-parent discipline where it is sensible: the write goes through an
// O_EXCL|O_NOFOLLOW temp + atomic rename (0644 from creation), and a symlinked
// config DIR is refused before we read/write through it. Everything is keyed off
// the injected env + homeDir (ConfigDirDeps), so a test drives a real temp dir via
// AGKIT_CONFIG_DIR (mirroring insecure-file.test.ts) with no mocking.
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "./errors";
import { parseConfig, emptyConfig, type ConfigData } from "./schema";
import { configFilePath, resolveConfigDir, type ConfigDirDeps } from "./dirs";

/** O_NOFOLLOW is POSIX; 0 where absent (Windows) — harmless there. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** Cap the config size read before parse (config.json is tiny; this is a guard). */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** What `loadConfig` returns: the validated document + where it lives + whether it existed. */
export interface LoadedConfig {
  readonly config: ConfigData;
  readonly path: string;
  readonly present: boolean;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/**
 * Reject a symlinked config DIR before reading/writing through it (a symlinked
 * parent would silently redirect the whole path). A missing dir is fine (config
 * simply absent). Non-secret, so this is defence-in-depth, not the load-bearing
 * guard T-206 needs — but cheap and worth keeping.
 */
function assertRealDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new ConfigError(`refusing to use ${dir}: the config directory must not be a symlink`);
  }
  if (!st.isDirectory()) {
    throw new ConfigError(`refusing to use ${dir}: not a directory`);
  }
}

/**
 * Load + validate config.json (deliverable 1). Absent file -> the empty valid config
 * (present:false). A `token` key or any schema violation -> `ConfigError`
 * (usage_error, exit 2) via `parseConfig`. Never throws for a merely-absent file.
 */
export function loadConfig(deps: ConfigDirDeps): LoadedConfig {
  const path = configFilePath(deps);
  assertRealDir(dirname(path));
  // Open with O_NOFOLLOW (numeric flags need openSync — readFileSync's `flag` option
  // is string-only), then read from the fd we hold, so a symlinked FILE is refused too.
  let text: string;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = errCode(err);
    if (code === "ENOENT") return { config: emptyConfig(), path, present: false };
    if (code === "ELOOP") {
      throw new ConfigError(`refusing to read ${path}: it is a symlink`);
    }
    throw err;
  }
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  if (text.length > MAX_CONFIG_BYTES) {
    throw new ConfigError(`${path} is too large to be a valid config file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} is not valid JSON`);
  }
  return { config: parseConfig(parsed, path), path, present: true };
}

/** Create + write `file` atomically at mode 0644 (never following a symlink). */
function atomicWrite0644(dir: string, file: string, text: string): void {
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o644);
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
    renameSync(tmp, file); // atomic on the same filesystem; replaces a symlink target itself
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Persist `config` to config.json (deliverable 1). Re-validates before writing (so a
 * caller can never persist an invalid/token-bearing document), creates the config
 * dir 0700, and commits via the atomic 0644 temp+rename. Returns the path written.
 */
export function saveConfig(deps: ConfigDirDeps, config: ConfigData): string {
  const validated = parseConfig(config, "config"); // defence-in-depth: never write invalid
  const dir = resolveConfigDir(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRealDir(dir);
  const path = configFilePath(deps);
  atomicWrite0644(dir, path, JSON.stringify(validated, null, 2) + "\n");
  return path;
}
