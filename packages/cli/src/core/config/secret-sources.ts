// The OPERATOR ALLOWLIST for indirect secret sources + the hardened file reader behind it
// (T-227 D0-H v2, plan deltas v3-5 / v4-3 / v5-2 / v6-2). Two things live here because they share
// one set of checks:
//
//   1. `secret_sources` — a per-PROFILE list of source DECLARATIONS in config.json:
//        {kind:"env",  name}                     — an env var the operator vouches for
//        {kind:"file", path, dev, ino}           — a CANONICAL path + the approved inode identity
//      Nothing here is a secret (it is a list of NAMES), so it lives in the non-secret config
//      document, which `.strict()`-validates every byte of it on load.
//
//   2. `readSecretFile` — the hardened read a `{source:"file"}` reference resolves through.
//
// WHY THE ALLOWLIST EXISTS. On the CLI the operator TYPED the flag, so the operator IS the
// authorization: `--api-key-env NAME` / `--api-key-file PATH` are honored directly. Over MCP the
// CALLER IS NOT THE OPERATOR — a host that could name any env var or any path would have a
// general-purpose read primitive pointed at the operator's machine ("read /home/me/.ssh/id_ed25519
// and put it in a credential body"). So on that channel a reference is honored ONLY when the exact
// name/path was pre-declared HERE, and the declaration surface is CLI-only by construction.
//
// WHY THE FILE READ IS THIS PARANOID. A path is not an identity. Between the moment an operator
// approves `/etc/agentkit/openai.key` and the moment a resolution reads it, the name can be pointed
// somewhere else (symlink), replaced (new inode at the same name), or made readable to other users.
// So the read binds to the INODE, not the name:
//   open O_NOFOLLOW      — the final component may not be a symlink (a swapped name fails here)
//   fstat(descriptor)    — every property is read from the OPENED FILE, never re-derived from the path
//   identity equality    — dev/ino must equal the APPROVED pair (v5-2), compared as BigInt (v6-2:
//                          `bigint:true` end to end; ids above 2^53 are real on modern filesystems
//                          and a Number round-trip would silently collide them)
//   regular / euid-owned / no group-or-other permission bits
//   size <= the caller's cap, then READ FROM THE DESCRIPTOR — never a second path-based open
//   post-open lstat      — the path must STILL name that same inode (nothing swapped underneath us)
//   trusted parents      — every ancestor directory owned by us or root and not group/other-writable
// A same-path/different-inode hit is NOT a generic refusal: it is a distinct RE-AUTHORIZATION
// message, because "the approved file was replaced" is an operator decision, not a bug.
//
// WINDOWS REFUSES, TYPED. Every guarantee above is POSIX (`O_NOFOLLOW`, euid ownership, mode bits,
// dev/ino identity). Rather than run a check that silently proves nothing, `win32` refuses the
// file source outright on BOTH channels (v3-5) — honor-or-reject, never a weaker read wearing the
// same name.
//
// EVERY MESSAGE HERE IS STATIC. The R-H #2 discipline of `provider-key/secret-env.ts` extends to
// this module: no message interpolates the path, the value, the byte count, or the inode numbers —
// a mis-pasted secret in a `--api-key-file` argument must not surface in an error either.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "./errors";
import { loadConfig, saveConfig } from "./config-file";
import { resolveConfigDir, type ConfigDirDeps } from "./dirs";
import { resolveContext, type ContextFlags } from "./context";
import { discoverRepoProject } from "./repo-project";
import { withConfigFileLock, type FileLockDeps } from "../auth/file-lock";
import { decimalBigIntString, MAX_SECRET_SOURCES, type ConfigData, type ProfileConfig, type SecretSource } from "./schema";

/** O_NOFOLLOW is POSIX; 0 where absent. The `win32` refusal below means we never rely on the 0. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// The declaration SHAPES live in `./schema` (see its header: `profileConfigSchema` needs them, and
// this module needs `loadConfig`/`saveConfig`, so defining them here would be a runtime cycle).
// Re-exported so every caller still imports the whole secret-source surface from one place.
export {
  MAX_SECRET_SOURCES,
  envSecretSourceSchema,
  fileSecretSourceSchema,
  secretSourceSchema,
  secretSourcesSchema,
  type SecretSource,
} from "./schema";

/** The inode identity of an approved file, as BigInt (the ONLY form comparisons ever use). */
export interface SecretFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

// ── the static refusal messages (zero interpolation — R-H #2 extends here) ───────────────────────

const WIN32_DETAIL =
  "file-sourced secrets are unavailable on Windows: the source binds to a POSIX inode identity (O_NOFOLLOW, owner uid, permission bits, dev/ino) that has no equivalent here. Use the env-name channel instead.";
const SYMLINK_DETAIL =
  "refusing the secret file: the path is a symbolic link. A secret source must name a regular file directly (a link can be repointed after approval).";
const UNREADABLE_DETAIL =
  "refusing the secret file: it does not exist, is not readable by this user, or its directory cannot be traversed.";
const NOT_REGULAR_DETAIL = "refusing the secret file: it is not a regular file.";
const NOT_OWNED_DETAIL =
  "refusing the secret file: it is not owned by the user running this command.";
const PERMISSIVE_DETAIL =
  "refusing the secret file: it is readable or writable by group or other. Run `chmod 600` on it (owner-only) and retry.";
const OVERSIZE_FILE_DETAIL = "refusing the secret file: its contents exceed the secret byte limit.";
const EMPTY_FILE_DETAIL = "refusing the secret file: it is empty (or contains only a trailing newline).";
const SWAPPED_DETAIL =
  "refusing the secret file: the path stopped naming the file that was opened (it was replaced or relinked mid-read).";
const REAUTHORIZE_DETAIL =
  "the approved secret file was REPLACED: the path still exists but names a different file than the one authorized. Re-approve it from the CLI (the declaration stores the file's identity, so a replacement is never silently trusted) — no secret was read.";
const UNTRUSTED_PARENT_DETAIL =
  "refusing the secret file: one of its parent directories is writable by group or other, or is owned by another user. A directory anyone can write is a directory anyone can swap the file in.";
const BAD_IDENTITY_DETAIL =
  "the stored secret-file declaration is unreadable (its recorded file identity is missing or malformed). Re-approve the file from the CLI — no secret was read.";
const NOT_ABSOLUTE_DETAIL = "a secret file must be named by an ABSOLUTE path.";
const TOO_MANY_DETAIL = `refusing the declaration: a profile may declare at most ${MAX_SECRET_SOURCES} secret sources.`;

/** The env-var NAME grammar (identical to the one `provider-key/secret-env.ts` gates on). */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_DETAIL =
  "a declared env secret source must be an environment-variable NAME (letters, digits, underscore; not starting with a digit).";

function refuse(detail: string, hint?: string): never {
  throw new ConfigError(detail, hint === undefined ? {} : { hint });
}

// ── identity helpers ─────────────────────────────────────────────────────────────────────────────

/** Render an identity for STORAGE — canonical decimal strings, the only persisted form (v6-2). */
export function identityToStored(identity: SecretFileIdentity): { dev: string; ino: string } {
  return { dev: identity.dev.toString(10), ino: identity.ino.toString(10) };
}

/**
 * Parse a persisted `{dev, ino}` pair back into BigInts. A legacy numeric, a malformed string, or a
 * non-canonical spelling yields `null` — the caller turns that into the RE-AUTHORIZATION message
 * (v6-2), never a silent "no identity to compare, read it anyway".
 */
export function identityFromStored(raw: { dev?: unknown; ino?: unknown }): SecretFileIdentity | null {
  const dev = decimalBigIntString.safeParse(raw.dev);
  const ino = decimalBigIntString.safeParse(raw.ino);
  if (!dev.success || !ino.success) return null;
  return { dev: BigInt(dev.data), ino: BigInt(ino.data) };
}

/** BigInt equality on both components — the ONE identity comparison (never `==` on Numbers). */
export function identityEquals(a: SecretFileIdentity, b: SecretFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// ── the hardened read ────────────────────────────────────────────────────────────────────────────

/** What a secret-file read needs to know. `platform`/`euid` are injected so the POSIX-only and
 *  ownership branches are testable without mutating globals (production passes neither). */
export interface SecretFileReadOptions {
  /** UTF-8 byte cap for the resolved value (the caller's `MAX_SECRET_BYTES`). */
  readonly maxBytes: number;
  /** The APPROVED identity, when resolving a declared source. Absent ⇒ operator-typed (CLI). */
  readonly expect?: SecretFileIdentity;
  readonly platform?: NodeJS.Platform;
  readonly euid?: number;
}

/** A completed read: the value plus the identity of the inode it actually came from. */
export interface SecretFileRead {
  readonly value: string;
  readonly identity: SecretFileIdentity;
}

function currentPlatform(opts: SecretFileReadOptions): NodeJS.Platform {
  return opts.platform ?? process.platform;
}

function currentEuid(opts: SecretFileReadOptions): number {
  if (opts.euid !== undefined) return opts.euid;
  // `geteuid` is absent on Windows — but `win32` has already refused before we get here.
  return process.geteuid ? process.geteuid() : -1;
}

/**
 * Refuse the file source outright on a platform without the POSIX identity primitives (v3-5). Split
 * out so BOTH the read and the DECLARATION share one refusal (declaring a source we could never
 * safely resolve would be a lie stored in config).
 */
export function assertFileSourceSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") refuse(WIN32_DETAIL);
}

/**
 * Every ancestor directory of `dir` must be owned by us or by root and must not be writable by
 * group or other — otherwise someone else can swap the file out from under an approved path.
 *
 * THE STICKY-BIT EXCEPTION IS DELIBERATE. A world-writable directory with the sticky bit (`/tmp`,
 * 1777) permits CREATION but forbids a non-owner from deleting or renaming an entry they do not
 * own — which is exactly the attack this walk defends against. Refusing sticky dirs outright would
 * ban the one world-writable layout that is actually safe here; accepting a NON-sticky one would
 * ban nothing at all. `dir` must already be CANONICAL (the caller realpaths it), so no component
 * walked here can itself be a symlink.
 */
function assertTrustedParents(dir: string, euid: number): void {
  let cur = dir;
  for (;;) {
    let st;
    try {
      st = statSync(cur);
    } catch {
      refuse(UNREADABLE_DETAIL);
    }
    if (!st.isDirectory()) refuse(UNTRUSTED_PARENT_DETAIL);
    if (st.uid !== euid && st.uid !== 0) refuse(UNTRUSTED_PARENT_DETAIL);
    const mode = st.mode & 0o7777;
    const sticky = (mode & 0o1000) !== 0;
    if ((mode & 0o022) !== 0 && !sticky) refuse(UNTRUSTED_PARENT_DETAIL);
    const parent = dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

/** Strip EXACTLY ONE trailing newline (`\r?\n`) — the shape `echo 'sk-…' > key.txt` produces. A
 *  second trailing newline is content and stays: a secret is bytes, and we do not guess. */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** Read every byte of an OPEN descriptor (never a second path-based open). */
function readAllFromDescriptor(fd: number, size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, buf, read, size - read, read);
    if (n <= 0) break;
    read += n;
  }
  return read === size ? buf : buf.subarray(0, read);
}

/**
 * THE hardened secret-file read (see the module header for the full ladder). `path` must be
 * ABSOLUTE and — when `opts.expect` is set — must be the CANONICAL path recorded at declaration.
 * Returns the value AND the identity it was read from; every failure is a STATIC `ConfigError`.
 */
export function readSecretFile(path: string, opts: SecretFileReadOptions): SecretFileRead {
  assertFileSourceSupported(currentPlatform(opts));
  if (!path.startsWith("/")) refuse(NOT_ABSOLUTE_DETAIL);
  const euid = currentEuid(opts);

  // Parents first: a file reached THROUGH a directory anyone can rewrite is not trustworthy no
  // matter what the file itself looks like. The canonical form of the PARENT is what gets walked;
  // the final component is never resolved (that is O_NOFOLLOW's job, one line down).
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(dirname(path));
  } catch {
    refuse(UNREADABLE_DETAIL);
  }
  assertTrustedParents(canonicalDir, euid);

  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
    if (code === "ELOOP" || code === "EMLINK") refuse(SYMLINK_DETAIL);
    refuse(UNREADABLE_DETAIL);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const identity: SecretFileIdentity = { dev: st.dev, ino: st.ino };

    // Identity BEFORE the shape checks: "this is not the file you approved" is its own answer, and
    // the operator needs the re-authorization instruction, not a generic refusal.
    if (opts.expect !== undefined && !identityEquals(identity, opts.expect)) refuse(REAUTHORIZE_DETAIL);

    if (!st.isFile()) refuse(NOT_REGULAR_DETAIL);
    if (Number(st.uid) !== euid) refuse(NOT_OWNED_DETAIL);
    if ((Number(st.mode) & 0o077) !== 0) refuse(PERMISSIVE_DETAIL, "chmod 600 <path>");
    const size = Number(st.size);
    if (size > opts.maxBytes) refuse(OVERSIZE_FILE_DETAIL);

    const bytes = readAllFromDescriptor(fd, size);

    // Post-open lstat (v5-2): the descriptor is pinned to an inode, but the PATH is not — if it now
    // names something else, the approval we are acting on no longer describes reality. Applied on
    // BOTH channels: on the CLI there is no stored identity to compare, so we compare against the
    // descriptor's own — which still closes the swap-between-open-and-read window.
    let after;
    try {
      after = lstatSync(path, { bigint: true });
    } catch {
      refuse(SWAPPED_DETAIL);
    }
    if (!identityEquals({ dev: after.dev, ino: after.ino }, identity)) refuse(SWAPPED_DETAIL);

    const value = stripOneTrailingNewline(bytes.toString("utf8"));
    if (value.length === 0) refuse(EMPTY_FILE_DETAIL);
    if (Buffer.byteLength(value, "utf8") > opts.maxBytes) refuse(OVERSIZE_FILE_DETAIL);
    return { value, identity };
  } finally {
    closeSync(fd);
  }
}

// ── the allowlist store (per-profile declarations in config.json) ────────────────────────────────

/** Everything the declaration surface reads/writes — all injected (the `ProfileStoreDeps` idiom). */
export interface SecretSourceDeps extends ConfigDirDeps {
  readonly cwd?: string;
  readonly flags?: ContextFlags;
}

/** Which profile's allowlist applies — the SAME precedence chain every other context value uses. */
export function activeSecretSourceProfile(deps: SecretSourceDeps, config: ConfigData): string {
  const repo = deps.cwd === undefined ? null : (discoverRepoProject(deps.cwd)?.project ?? null);
  return resolveContext({ flags: deps.flags ?? {}, env: deps.env, repo, config }).profile.value;
}

/** Read one profile's declarations from an ALREADY-LOADED snapshot (S8 relay fold): a caller that
 *  resolved the profile from a snapshot must read the sources from the SAME snapshot — a second
 *  load could observe a concurrent config write and pair one snapshot's profile with another's
 *  sources. */
export function declaredSecretSourcesFromConfig(config: ConfigData, name: string): SecretSource[] {
  return [...(config.profiles?.[name]?.secret_sources ?? [])];
}

/** Read one profile's declarations (never throws for an absent config — an undeclared world is
 *  simply the empty allowlist, which refuses everything on the MCP channel). */
export function declaredSecretSources(deps: SecretSourceDeps, profile?: string): SecretSource[] {
  const { config } = loadConfig(deps);
  return declaredSecretSourcesFromConfig(config, profile ?? activeSecretSourceProfile(deps, config));
}

/** The declared env source with EXACTLY this name, or null. Exact match — never a prefix/case fold. */
export function findDeclaredEnv(sources: readonly SecretSource[], name: string): SecretSource | null {
  return sources.find((s) => s.kind === "env" && s.name === name) ?? null;
}

/**
 * The declared file source whose CANONICAL path is exactly this string, or null. The comparison is
 * on the STORED canonical path against the reference's path VERBATIM — the untrusted reference is
 * never realpath'd into a match, because that would let a caller-planted symlink name an approved
 * target and be honored.
 */
export function findDeclaredFile(sources: readonly SecretSource[], path: string): SecretSource | null {
  return sources.find((s) => s.kind === "file" && s.path === path) ?? null;
}

/** Immutably write one profile's `secret_sources` (dropping the key when the list empties). */
function withSecretSources(config: ConfigData, profile: string, sources: SecretSource[]): ConfigData {
  const profiles = { ...(config.profiles ?? {}) };
  const entry: ProfileConfig = { ...(profiles[profile] ?? {}) };
  const next: ProfileConfig =
    sources.length === 0 ? stripSecretSources(entry) : { ...entry, secret_sources: sources };
  profiles[profile] = next;
  return { ...config, profiles };
}

function stripSecretSources(entry: ProfileConfig): ProfileConfig {
  const { secret_sources: _drop, ...rest } = entry;
  return rest;
}

/** What a declaration mutation reports back (never a value — a declaration holds no material). */
export interface SecretSourceWriteResult {
  readonly profile: string;
  readonly sources: SecretSource[];
  readonly config_path: string;
  readonly changed: boolean;
}

/**
 * The one read-modify-write, under the SAME cross-process config lock `ensureProfileEntry` uses
 * (X6): acquire → RE-READ → transform → save. Two concurrent declarations must not atomically
 * rename over each other and drop an approval.
 */
function mutateSecretSources(
  deps: SecretSourceDeps,
  profile: string | undefined,
  transform: (current: SecretSource[]) => SecretSource[],
  lockDeps: FileLockDeps = {},
): SecretSourceWriteResult {
  const dir = resolveConfigDir(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withConfigFileLock(
    dir,
    () => {
      const { config } = loadConfig(deps);
      const name = profile ?? activeSecretSourceProfile(deps, config);
      const current = [...(config.profiles?.[name]?.secret_sources ?? [])];
      const next = transform(current);
      if (next.length > MAX_SECRET_SOURCES) refuse(TOO_MANY_DETAIL);
      const changed = JSON.stringify(current) !== JSON.stringify(next);
      const path = saveConfig(deps, withSecretSources(config, name, next));
      return { profile: name, sources: next, config_path: path, changed };
    },
    lockDeps,
  );
}

/** Declare an env-var NAME (`agkit secret-source add --env NAME`). Idempotent. */
export function declareEnvSecretSource(
  deps: SecretSourceDeps,
  name: string,
  opts: { profile?: string; lockDeps?: FileLockDeps } = {},
): SecretSourceWriteResult {
  if (!ENV_VAR_NAME.test(name)) refuse(ENV_NAME_DETAIL);
  return mutateSecretSources(
    deps,
    opts.profile,
    (current) => (findDeclaredEnv(current, name) ? current : [...current, { kind: "env", name }]),
    opts.lockDeps,
  );
}

/**
 * Declare a FILE (`agkit secret-source add --file PATH`): canonicalize, run the IDENTICAL hardening
 * ladder resolution runs (so a source that could never resolve is never stored), and record the
 * `{dev,ino}` observed on THAT descriptor. Re-declaring a replaced file is how re-authorization
 * happens — the stored identity is overwritten with the new one.
 *
 * The file's CONTENT is read as part of the check and immediately discarded: approving a file we
 * cannot actually read would push the failure to the moment it matters least.
 */
export function declareFileSecretSource(
  deps: SecretSourceDeps,
  path: string,
  opts: { maxBytes: number; profile?: string; lockDeps?: FileLockDeps; platform?: NodeJS.Platform; euid?: number } = {
    maxBytes: 8192,
  },
): SecretSourceWriteResult {
  assertFileSourceSupported(opts.platform ?? process.platform);
  if (!path.startsWith("/")) refuse(NOT_ABSOLUTE_DETAIL);
  let canonical: string;
  try {
    // Canonicalize the PARENT and re-attach the final component: realpath'ing the whole path would
    // silently follow a symlinked final component, which is exactly what O_NOFOLLOW forbids.
    canonical = `${realpathSync(dirname(path)).replace(/\/$/, "")}/${path.slice(path.lastIndexOf("/") + 1)}`;
  } catch {
    refuse(UNREADABLE_DETAIL);
  }
  const read = readSecretFile(canonical, {
    maxBytes: opts.maxBytes,
    platform: opts.platform,
    euid: opts.euid,
  });
  const stored = identityToStored(read.identity);
  const entry: SecretSource = { kind: "file", path: canonical, dev: stored.dev, ino: stored.ino };
  return mutateSecretSources(
    deps,
    opts.profile,
    // In place, not filter-then-append (S8 relay fold): re-declaring an UNCHANGED file is a strict
    // no-op (same list back ⇒ changed:false, no rewrite), and a replaced file's new identity lands
    // at the entry's EXISTING index — an idempotent re-approval must not reorder the allowlist.
    (current) => {
      const index = current.findIndex((s) => s.kind === "file" && s.path === canonical);
      if (index === -1) return [...current, entry];
      const existing = current[index] as SecretSource & { kind: "file" };
      if (existing.dev === entry.dev && existing.ino === entry.ino) return current;
      const next = [...current];
      next[index] = entry;
      return next;
    },
    opts.lockDeps,
  );
}

/** Remove one declaration by kind + name/path. Reports `changed:false` when nothing matched. */
export function removeSecretSource(
  deps: SecretSourceDeps,
  selector: { kind: "env"; name: string } | { kind: "file"; path: string },
  opts: { profile?: string; lockDeps?: FileLockDeps } = {},
): SecretSourceWriteResult {
  return mutateSecretSources(
    deps,
    opts.profile,
    (current) =>
      current.filter((s) =>
        s.kind !== selector.kind
          ? true
          : s.kind === "env"
            ? s.name !== (selector as { name: string }).name
            : s.path !== (selector as { path: string }).path,
      ),
    opts.lockDeps,
  );
}

/**
 * Resolve a DECLARED file source: re-check the stored identity is well-formed, then read through
 * the full ladder with `expect` bound to it. A malformed stored identity and a replaced file both
 * land on the re-authorization message — in neither case has anything been read.
 */
export function readDeclaredSecretFile(
  source: SecretSource,
  opts: { maxBytes: number; platform?: NodeJS.Platform; euid?: number },
): string {
  if (source.kind !== "file") refuse(BAD_IDENTITY_DETAIL);
  const expect = identityFromStored(source);
  if (expect === null) refuse(BAD_IDENTITY_DETAIL);
  return readSecretFile(source.path, { maxBytes: opts.maxBytes, expect, platform: opts.platform, euid: opts.euid })
    .value;
}

/**
 * The mcpExclude rationale the `secret-source` command family MUST carry when it is wired into the
 * registry. Exported as a constant so the security property travels with the mechanism: the
 * allowlist is writable ONLY from the CLI channel — an MCP host that could add a declaration could
 * expand its own read authority, which is the whole thing the allowlist exists to prevent.
 */
export const SECRET_SOURCE_MCP_EXCLUDE =
  "operator allowlist for indirect secret sources — writable ONLY from the CLI channel (an MCP host that could declare a source could expand its own read authority); not an MCP tool";
