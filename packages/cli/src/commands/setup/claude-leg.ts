// T-224 leg 2 — the CLAUDE user-scope MCP registration (D4 / D4v2–D4v5). The custody-critical leg.
//
// WE NEVER HAND-EDIT `~/.claude.json`. Claude owns that schema; every mutation goes through the
// `claude` CLI with RAW argv and no shell. We READ that one file (through the follow-read seam, so
// a dotfiles-managed link is read THROUGH rather than misread as empty) to decide what to do and
// to prove what happened.
//
// GROUNDED FACT (live probe against the real CLI, sandbox HOME, 2026-07-28): `claude mcp add
// <name>` when the name ALREADY EXISTS is a SILENT NO-OP AT EXIT 0 — it prints "MCP server <name>
// already exists in user config" and neither replaces the entry nor fails. Two consequences drive
// this entire file:
//   1. AN EXIT CODE PROVES NOTHING. Every mutation is followed by a POSTCONDITION RE-READ of the
//      file, and only those bytes decide what we report. `code` rides along as a diagnostic fact
//      and is never branched on.
//   2. REMOVE→ADD IS THE ONLY RECONCILE PATH for a drifted entry. A plain `add` would exit 0 and
//      change nothing, and we would have reported success for a no-op.
//
// AND WE ONLY TAKE THAT PATH WHEN WE CAN PUT BACK WHAT WE REMOVE (D4v4). The existing entry must
// consist of exactly the members a re-add reproduces (`{type: "stdio", command, args}` — `add`
// MATERIALIZES `type`, so an entry where it is ABSENT is as irreproducible as a foreign
// transport); an entry carrying `env`, headers, or ANYTHING else is REFUSED with sanitized facts
// — never removed. The
// custody snapshot we take before removing lives in MEMORY ONLY and is never serialized into a
// result, a log, or a detail: its whole purpose is restoration, not reporting.
import { isAbsolute } from "node:path";
import {
  claudeMcpAddCommand,
  claudeUserAgkitEntry,
  claudeUserConfigPath,
  isAgkitShimPath,
  isServeArgv,
  resolvePathBinary,
  MCP_SERVER_ENTRY,
  type ClaudeUserEntry,
} from "../../core/mcp/registration";
import { CODEX_SERVE_ARGS } from "./codex-toml";
import { CliLocalError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";
import { CHILD_TIMEOUT_MS, leg, SETUP_CONFIG_MAX_BYTES, type SetupDeps, type SetupLeg } from "./legs";

const NAME = "claude_mcp";
const PATH_MAX = 200;
/** A bounded, value-free render of a foreign entry's member NAMES (D-detail-sanitize-v2). */
const FIELD_SAMPLE_MAX = 5;
const FIELD_NAME_MAX = 40;
/** The client binary that owns `~/.claude.json`. */
export const CLAUDE_BIN = "claude";
/**
 * The path a manual snippet names when we could not resolve our own binary. A plain POSIX-safe
 * token so the printed line stays unquoted and obviously a placeholder — never a guess at a real
 * path, and never a relative or `npx` form (FORBIDDEN).
 */
export const BIN_PLACEHOLDER = "/absolute/path/to/agkit";

/** The exact members a `claude mcp add` re-add reproduces. Anything else forbids auto-reconcile. */
const REPRODUCIBLE_KEYS: ReadonlySet<string> = new Set(["type", "command", "args"]);

/**
 * The paste-able registration line, as a FACT FRAGMENT. `claudeMcpAddCommand` REFUSES a path its
 * target shell cannot quote faithfully — `cmd.exe` has no in-quote escape for `"`, `%` or `!`, and
 * neither shell may carry a control character — and real Windows paths can contain all three
 * (`C:\Users\a!b\…`). A leg must REPORT that and keep going: taking the whole `setup` run down
 * with an exception would trade one unprintable line for the entire drift report, and printing a
 * line we cannot quote correctly would hand the user a command that means something else.
 */
function addCommandFacts(absBin: string, platform: NodeJS.Platform): Record<string, unknown> {
  try {
    return { command: claudeMcpAddCommand(absBin, platform) };
  } catch {
    return { command_unrenderable: true, bin: displayCapped(absBin, PATH_MAX) };
  }
}

/** The PRIVATE custody snapshot. In memory only — never serialized anywhere. */
interface EntrySnapshot {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
}

export async function claudeMcpLeg(deps: SetupDeps, absBin: string | null): Promise<SetupLeg> {
  const path = claudeUserConfigPath(deps.homeDir);
  const shown = displayCapped(path, PATH_MAX);
  let read: ClaudeUserEntry;
  try {
    read = await readEntry(deps);
  } catch (err) {
    if (err instanceof CliLocalError) {
      return leg(NAME, "refused", err.detail ?? `${shown}: could not be read`, { path, registered: false });
    }
    throw err;
  }

  if (read.status === "unreadable") {
    return leg(NAME, "refused", `${shown}: this file is not a readable Claude config (${read.reason})`, {
      path,
      registered: false,
      reason: read.reason,
    });
  }
  const registered = read.status === "present" && looksRegistered(read.entry);
  if (absBin !== null && read.status === "present" && isConverged(read.entry, absBin)) {
    return leg(NAME, "current", `${shown}: \`${MCP_SERVER_ENTRY}\` is registered at user scope`, {
      path,
      registered: true,
      scope: "user",
    });
  }

  // No absolute shim ⇒ nothing we would stand behind can be written (honor-or-reject: never a
  // relative path, never `npx`). The user gets the exact line to run with their own path.
  if (absBin === null) {
    return leg(NAME, "manual", `${shown}: no absolute \`agkit\` binary resolved — register it by hand`, {
      path,
      registered,
      scope: "user",
      ...addCommandFacts(BIN_PLACEHOLDER, deps.platform),
    });
  }

  const claudeBin = resolvePathBinary(CLAUDE_BIN, {
    argv1: undefined,
    env: deps.env,
    platform: deps.platform,
    fs: deps.installFs,
  });
  if (claudeBin === null) {
    return leg(NAME, "manual", `${shown}: no \`${CLAUDE_BIN}\` binary on PATH — register it by hand`, {
      path,
      registered,
      scope: "user",
      ...addCommandFacts(absBin, deps.platform),
    });
  }
  if (deps.check) {
    // READ-ONLY. `claude mcp add`/`remove` both WRITE, so the check arm stops here by construction.
    return leg(NAME, "would_change", `${shown}: \`${MCP_SERVER_ENTRY}\` is not registered at user scope`, {
      path,
      registered,
      scope: "user",
    });
  }
  return read.status === "present"
    ? reconcile(deps, read.entry, absBin, shown, path)
    : freshAdd(deps, absBin, shown, path);
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────

async function readEntry(deps: SetupDeps): Promise<ClaudeUserEntry> {
  const read = await deps.follow.readTextFileFollowing(claudeUserConfigPath(deps.homeDir), {
    within: deps.homeDir,
    maxBytes: SETUP_CONFIG_MAX_BYTES,
  });
  return read.status === "absent" ? { status: "absent" } : claudeUserAgkitEntry(read.text);
}

/**
 * CONVERGENCE (D4v2): the registered `command` is EXACTLY the absolute shim we chose — absolute,
 * with an agkit launcher basename — and `args` is EXACTLY the serve argv. A relative `agkit`, a
 * foreign path, or a realpath'd `dist/cli.js` all count as DRIFT, not as registration.
 */
function isConverged(entry: Readonly<Record<string, unknown>>, absBin: string): boolean {
  const { command, args } = entry;
  return (
    typeof command === "string" && command === absBin && isAbsolute(command) && isAgkitShimPath(command) && isServeArgv(args)
  );
}

/** A weaker, REPORTING-only question: is something plausibly agkit-shaped already there? */
function looksRegistered(entry: Readonly<Record<string, unknown>>): boolean {
  return typeof entry.command === "string" && isAgkitShimPath(entry.command) && isServeArgv(entry.args);
}

// ── the two apply arms ────────────────────────────────────────────────────────────────────

/** No existing entry: a plain add, then prove it by re-reading the file. */
async function freshAdd(deps: SetupDeps, absBin: string, shown: string, path: string): Promise<SetupLeg> {
  const add = await runClaude(deps, addArgv(absBin));
  const after = await readEntry(deps);
  if (after.status === "present" && isConverged(after.entry, absBin)) {
    return leg(NAME, "done", `${shown}: registered \`${MCP_SERVER_ENTRY}\` at user scope`, {
      path,
      registered: true,
      scope: "user",
      add_exit: add.code,
    });
  }
  // The child may well have exited 0. The FILE says otherwise, and the file is the authority.
  return leg(NAME, "refused", `${shown}: \`${CLAUDE_BIN} mcp add\` did not register the server — do it by hand`, {
    path,
    registered: false,
    scope: "user",
    add_exit: add.code,
    timed_out: add.timedOut,
    ...addCommandFacts(absBin, deps.platform),
  });
}

/**
 * An existing, DRIFTED entry. Gate → private snapshot → remove → prove removed → add → prove
 * converged → (on failure) restore from the snapshot → prove the restoration, field by field.
 */
async function reconcile(
  deps: SetupDeps,
  entry: Readonly<Record<string, unknown>>,
  absBin: string,
  shown: string,
  path: string,
): Promise<SetupLeg> {
  const snapshot = snapshotOf(entry);
  if (snapshot === null) {
    // We cannot reproduce this entry, so we will not remove it. Facts only — no VALUES: what is
    // in someone's MCP entry (an env binding, a header) is their business and often a secret.
    return leg(NAME, "refused", `${shown}: the existing \`${MCP_SERVER_ENTRY}\` entry is not a shape this command can restore exactly — update it by hand`, {
      path,
      registered: looksRegistered(entry),
      scope: "user",
      ...foreignFacts(entry),
      ...addCommandFacts(absBin, deps.platform),
    });
  }

  const remove = await runClaude(deps, ["mcp", "remove", MCP_SERVER_ENTRY, "-s", "user"]);
  const afterRemove = await readEntry(deps);
  if (afterRemove.status !== "absent") {
    // Nothing was lost — the entry is still there, exactly as it was.
    return leg(NAME, "refused", `${shown}: \`${CLAUDE_BIN} mcp remove\` did not remove the stale entry — update it by hand`, {
      path,
      registered: looksRegistered(entry),
      scope: "user",
      remove_exit: remove.code,
      ...addCommandFacts(absBin, deps.platform),
    });
  }

  const add = await runClaude(deps, addArgv(absBin));
  const after = await readEntry(deps);
  if (after.status === "present" && isConverged(after.entry, absBin)) {
    return leg(NAME, "done", `${shown}: re-registered \`${MCP_SERVER_ENTRY}\` at user scope`, {
      path,
      registered: true,
      scope: "user",
      remove_exit: remove.code,
      add_exit: add.code,
    });
  }
  return restore(deps, snapshot, absBin, shown, path, add.code);
}

/**
 * D4v5 — the restoration, and its OWN postcondition. We removed something we promised we could put
 * back; the add that was supposed to replace it did not land. Re-add the snapshot by argv (which
 * is well-defined precisely because the gate above proved the entry was `{type?, command, args}`
 * only), then RE-READ and compare EVERY snapshot field exactly. The leg stays `refused` either
 * way — convergence failed — but the user must be told, truthfully, whether their old entry is
 * back. The child's exit code is never the answer.
 */
async function restore(
  deps: SetupDeps,
  snapshot: EntrySnapshot,
  absBin: string,
  shown: string,
  path: string,
  addExit: number | null,
): Promise<SetupLeg> {
  const restoreAdd = await runClaude(deps, ["mcp", "add", MCP_SERVER_ENTRY, "-s", "user", "--", snapshot.command, ...snapshot.args]);
  const after = await readEntry(deps);
  const restored = after.status === "present" && matchesSnapshot(after.entry, snapshot);
  const facts = {
    path,
    registered: after.status === "present" && looksRegistered(after.entry),
    scope: "user",
    add_exit: addExit,
    restore_exit: restoreAdd.code,
    previous_entry_restored: restored,
    ...addCommandFacts(absBin, deps.platform),
  };
  if (restored) {
    return leg(NAME, "refused", `${shown}: the new registration did not land; the previous entry was restored — register it by hand`, facts);
  }
  // NOT restored — but say only what the re-read PROVED. "There is no entry" is a claim about the
  // file, and it is only true when the file says so; a present-but-different entry (a concurrent
  // writer, a client that lands different bytes) must be reported as exactly that, names only.
  if (after.status === "absent") {
    return leg(NAME, "refused", `${shown}: the new registration did not land AND the previous entry could NOT be restored — there is now no \`${MCP_SERVER_ENTRY}\` entry at user scope`, facts);
  }
  if (after.status === "present") {
    return leg(NAME, "refused", `${shown}: the new registration did not land; a \`${MCP_SERVER_ENTRY}\` entry EXISTS at user scope but does not match the previous registration — inspect it by hand`, { ...facts, ...foreignFacts(after.entry) });
  }
  return leg(NAME, "refused", `${shown}: the new registration did not land AND the config could not be re-read to verify the restoration — inspect it by hand`, { ...facts, reason: after.reason });
}

// ── the reproducibility gate + the snapshot comparison ────────────────────────────────────

/** The snapshot, or null when the entry carries anything a re-add would not reproduce. */
function snapshotOf(entry: Readonly<Record<string, unknown>>): EntrySnapshot | null {
  for (const key of Object.keys(entry)) if (!REPRODUCIBLE_KEYS.has(key)) return null;
  const { type, command, args } = entry;
  // `add` MATERIALIZES `type: "stdio"` (grounded), so an entry where `type` is ABSENT cannot be
  // put back exactly any more than a foreign transport can. Both refuse the remove.
  if (type !== "stdio") return null;
  if (typeof command !== "string" || command === "") return null;
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) return null;
  return { type, command, args: [...args] };
}

/** EVERY field, exactly — presence included (D4v5). */
function matchesSnapshot(entry: Readonly<Record<string, unknown>>, snapshot: EntrySnapshot): boolean {
  const keys = Object.keys(entry).sort();
  if (keys.length !== 3 || keys[0] !== "args" || keys[1] !== "command" || keys[2] !== "type") return false;
  if (entry.type !== snapshot.type) return false;
  if (entry.command !== snapshot.command) return false;
  const args = entry.args;
  return (
    Array.isArray(args) && args.length === snapshot.args.length && snapshot.args.every((a, i) => args[i] === a)
  );
}

/**
 * The SANITIZED facts a refusal may carry about a foreign entry: which member NAMES are there and
 * the command's BASENAME. No values, ever — not the command path, not an env binding, not a header.
 */
function foreignFacts(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const keys = Object.keys(entry).sort();
  const extra = keys.filter((k) => !REPRODUCIBLE_KEYS.has(k));
  const command = entry.command;
  return {
    has_env: Object.prototype.hasOwnProperty.call(entry, "env"),
    command_basename:
      typeof command === "string" ? displayCapped(command.replace(/\\/g, "/").split("/").pop() ?? "", FIELD_NAME_MAX) : null,
    extra_fields: extra.slice(0, FIELD_SAMPLE_MAX).map((k) => displayCapped(k, FIELD_NAME_MAX)),
    extra_field_count: extra.length,
    extra_fields_truncated: extra.length > FIELD_SAMPLE_MAX,
  };
}

// ── the child ─────────────────────────────────────────────────────────────────────────────

/** The converge argv. `--` separates claude's own flags from the server command (RAW argv, no shell). */
function addArgv(absBin: string): string[] {
  return ["mcp", "add", MCP_SERVER_ENTRY, "-s", "user", "--", absBin, ...CODEX_SERVE_ARGS];
}

/**
 * Run the `claude` CLI. RAW argv, never a shell string, so nothing in a path can be interpreted.
 * The child's output is DISCARDED: it is already redacted by the seam, and we do not read it for
 * evidence — the postcondition re-read is the evidence. The child inherits the invoking process's
 * HOME through the seam's sanitized allowlist, which is the same home our reads resolve from in
 * production (`runtime.homeDir` is `os.homedir()`); a test injects its own `runChild` instead.
 */
function runClaude(deps: SetupDeps, args: readonly string[]): Promise<{ code: number | null; timedOut: boolean }> {
  return deps.runChild(CLAUDE_BIN, args, {
    timeoutMs: CHILD_TIMEOUT_MS,
    onLine: () => {
      /* discarded: the file is the evidence, not the chatter */
    },
  });
}
