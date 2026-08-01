// The runtime's OPTIONAL I/O seams — the prompt channels and the fs channels a handler may use,
// plus their narrowers. Extracted from ./types (the `./command-seams` precedent) to keep that file
// under the packages/cli max-lines cap; `CliRuntime` extends this interface, so every consumer
// keeps reading these members off `requireRuntime(ctx)` exactly as before.
//
// The shared discipline of every member here:
//   • OPTIONAL — present only for the nouns `build-cli`'s `commandNeedsRuntime` covers, absent
//     everywhere else, so an unrelated command cannot even reach a prompt or the filesystem; the
//     T-221 fs/prompt members (`writeTextFile`/`listDir`/`promptLine`/`confirm`) gate TIGHTER
//     still — on the exact-key `RUNTIME_IO_CAPABLE` allowlist (today `init run` alone), never the
//     shared noun gate (codex k08), and the T-224 follow members gate on their OWN exact-key
//     allowlist `FOLLOW_IO_CAPABLE` (today `setup run` alone) so neither writer group inherits the
//     other's authority (least privilege);
//   • the shell owns the real implementation (`createShellDeps` in cli/run.ts, the production
//     bodies in cli/fs-seams.ts) and a test swaps it via `RunOverrides` — a HANDLER never touches
//     `process`, `node:readline`, or `node:fs` itself;
//   • fail-CLOSED where the shell wired nothing: an absent prompt reads as a decline, an absent
//     advisory probe as "nothing found", and an absent WRITER throws (see `requireWriteTextFile`)
//     rather than letting a run report files it never wrote.
import type {
  FollowExpectation,
  FollowReadResult,
  FollowVerification,
  FollowWriteResult,
} from "../cli/fs-seams";

// The follow-seam RESULT shapes are the production module's own types — re-exported so a handler
// (and a test fake) imports them from `./types` like every other seam contract, without importing
// the node:fs-bearing module itself.
export type { FollowExpectation, FollowIdentity, FollowReadResult, FollowVerification, FollowWriteResult } from "../cli/fs-seams";

/** The OPTIONAL prompt + filesystem seams the shell binds onto `CliRuntime`. */
export interface RuntimeIoSeams {
  /**
   * T-217 (R-D / RR-10): the echo-off hidden-secret prompt seam — sibling of
   * `ShellDeps.promptLine` (which ECHOES and is readline-based, so it is unusable for a
   * secret). Present ONLY when the shell injected it (`build-cli` threads `deps.promptSecret`
   * for the `provider-key` noun); absent everywhere else. Resolves the typed line (never
   * echoing a byte), `null` on non-TTY / EOF / Ctrl-C / stream error. A pure secret-resolution
   * module reads it via `requireRuntime(ctx)` exactly like `env`/`isTTY`.
   */
  readonly promptSecret?: (question: string) => Promise<string | null>;
  /**
   * T-221: the ECHOING typed-line reader and the y/N confirm — the sibling of `promptSecret` for
   * NON-secret answers (a project name, a confirm string, "proceed?"). These are the SAME two
   * shell seams `CeremonyDeps` already carries (`ShellDeps.promptLine` / `ShellDeps.confirm`),
   * threaded onto the runtime rather than duplicated: the dispatch hook can only hand them to a
   * spec with a `mutation` binding, and the `init` ORCHESTRATOR deliberately has none (it drives
   * several plans in one invocation), so without this it would have no interactive channel at all.
   * Present ONLY for `RUNTIME_IO_CAPABLE` commands (codex k08) — a non-init runtime noun never
   * receives an interactive channel through this seam. Both default fail-CLOSED where the shell
   * wires none (`promptLine` → null ⇒ treated as a decline, `confirm` → false).
   */
  readonly promptLine?: (question: string) => Promise<string | null>;
  readonly confirm?: (question: string) => Promise<boolean>;
  /**
   * B0 shared-core (sub-wave B): a BOUNDED, single-fd text-file reader — the first fs INPUT channel
   * (agent `sync --file`, media `--config-json @path`, T-221 `init`). Reads at most `maxBytes`
   * (oversize / non-regular / invalid-UTF-8 ⇒ a STATIC `usage_error` naming the path + class, NEVER
   * file content).
   */
  readonly readTextFile?: (path: string, opts: { maxBytes: number }) => Promise<string>;
  /**
   * T-221 (`init`): the fs OUTPUT channel — the SIBLING of `readTextFile`, and the ONLY way a
   * handler puts bytes on disk. Writes `text` to `path` ATOMICALLY at mode 0644 (temp + rename,
   * never following a symlink), creating the parent directory 0755 when absent. `opts.withinRoot`
   * (codex k07) scopes the write: the deepest existing ancestor of the target directory must
   * resolve inside the resolved root, so a symlinked parent (a hostile checkout's `.agentkit`)
   * can never redirect the artifact outside the repo. Present ONLY for `RUNTIME_IO_CAPABLE`
   * commands (codex k08); a handler outside that allowlist that reaches for it fails LOUD
   * (`requireWriteTextFile`) rather than silently skipping a write.
   */
  readonly writeTextFile?: (path: string, text: string, opts?: { withinRoot?: string }) => void;
  /**
   * T-221 (`init`): a directory listing of entry NAMES only — never file contents, never a
   * recursive walk. The scaffold reads it to detect the repo's project-type markers before it
   * chooses which artifact form to write. Resolves `[]` for a missing / unreadable /
   * non-directory path: a marker probe is advisory, so it must never fail the run.
   */
  readonly listDir?: (path: string) => string[];
  // ── T-224 (`setup`): the SYMLINK-FOLLOWING leaf seams ────────────────────────────────────────
  //
  // Separate members, not a flag on the pair above, because they carry the OPPOSITE contract at
  // the leaf: `writeTextFile` REPLACES a symlink (an `init` scaffold must land a regular file in
  // the repo), while these write THROUGH it (a stow/chezmoi-managed `AGENTS.md` /
  // `~/.codex/config.toml` is the user's deliberate indirection). Following is only safe with the
  // three disciplines the plain writer does not carry — containment in a named root, binding to
  // the exact bytes a prior follow-READ observed, and a no-replace fresh create — so the two
  // shapes stay two seams. Production bodies: `cli/fs-seams.ts`. Gated on their OWN exact-key
  // allowlist `FOLLOW_IO_CAPABLE` — a SEPARATE set from the T-221 siblings' `RUNTIME_IO_CAPABLE`,
  // because following a link (and `ensureRootForApply`'s create-under-$HOME) is strictly more
  // authority than the plain quartet, and `init` never claims it.
  /**
   * The bounded follow-READ. Returns `{status:"present", text, resolvedPath, identity}` or
   * `{status:"absent", resolvedPath}` — absence is a legitimate STATE at every leaf `setup`
   * reconciles (`--check` reports it as drift; apply takes the fresh-create arm), never an error.
   * Unreadable / non-regular / oversized / resolving outside `within` are typed refusals (thrown).
   */
  readonly readTextFileFollowing?: (
    path: string,
    opts: { within: string; maxBytes: number },
  ) => Promise<FollowReadResult>;
  /**
   * The identity-BOUND follow-WRITE. `expected` is the `{resolvedPath, identity}` a prior
   * follow-READ returned (or `identity: null` for the fresh-create arm); the write refuses, with
   * ZERO bytes written, if the link retargeted or the bytes changed since that read.
   */
  readonly writeTextFileFollowing?: (
    path: string,
    text: string,
    opts: { within: string; expected: FollowExpectation; maxBytes?: number },
  ) => Promise<FollowWriteResult>;
  /**
   * The publication POSTCONDITION: re-resolve, re-read, compare against what we intended to
   * publish. Bytes over claims — a returned write result is a claim, this is the evidence.
   */
  readonly verifyFollowedWrite?: (
    path: string,
    expectedText: string,
    opts: { within: string; maxBytes?: number },
  ) => Promise<FollowVerification>;
  /**
   * The APPLY-ONLY root provisioner (`mkdir -p` + re-realpath + re-validate inside `homeDir`).
   * The ONE member here that creates anything, which is why `--check` must never call it: a check
   * reports an absent `~/.codex` as drift instead of quietly provisioning it.
   */
  readonly ensureRootForApply?: (root: string, opts: { homeDir: string }) => string;
}

/**
 * T-221: narrow the OPTIONAL fs OUTPUT seam to a present value, or throw a clear internal error
 * (the `requireRuntime` precedent). Fail-LOUD is the point: a mis-wired shell must never let the
 * `init` orchestrator report "files written" for writes that silently never happened.
 */
export function requireWriteTextFile(
  rt: RuntimeIoSeams,
): (path: string, text: string, opts?: { withinRoot?: string }) => void {
  if (!rt.writeTextFile) {
    throw new Error("agkit: internal — this command requires the writeTextFile seam but it was not injected");
  }
  return rt.writeTextFile;
}

/**
 * T-224: narrow the four OPTIONAL follow seams to present values, or throw (the
 * `requireWriteTextFile` posture — fail LOUD). `setup` reports a per-leg status for everything it
 * could not do; a MIS-WIRED SHELL is not one of those things, and a leg that silently reported
 * "current" because its reader was absent would be the exact dishonesty this command exists to
 * prevent. Returned as ONE record so a handler binds all four in a single statement.
 */
export interface FollowSeams {
  readonly readTextFileFollowing: NonNullable<RuntimeIoSeams["readTextFileFollowing"]>;
  readonly writeTextFileFollowing: NonNullable<RuntimeIoSeams["writeTextFileFollowing"]>;
  readonly verifyFollowedWrite: NonNullable<RuntimeIoSeams["verifyFollowedWrite"]>;
  readonly ensureRootForApply: NonNullable<RuntimeIoSeams["ensureRootForApply"]>;
}

export function requireFollowSeams(rt: RuntimeIoSeams): FollowSeams {
  const missing = (
    ["readTextFileFollowing", "writeTextFileFollowing", "verifyFollowedWrite", "ensureRootForApply"] as const
  ).filter((name) => typeof rt[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `agkit: internal — this command requires the symlink-following fs seams but ${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not injected`,
    );
  }
  return {
    readTextFileFollowing: rt.readTextFileFollowing!,
    writeTextFileFollowing: rt.writeTextFileFollowing!,
    verifyFollowedWrite: rt.verifyFollowedWrite!,
    ensureRootForApply: rt.ensureRootForApply!,
  };
}
