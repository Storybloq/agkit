// T-224 leg 4 — the CODEX client config (`~/.codex/config.toml`), only under `--client codex`.
//
// WHERE: `CODEX_HOME` when the environment sets it, else `~/.codex` — the same override Codex
// itself honors, so a developer who relocated their Codex home gets their real file edited.
//
// CONTAINMENT (D-new, as amended): the seam's root is `homeDir`, not `codexHome`. That is a
// deliberate widening of exactly one hop: a dotfiles-managed `~/.codex/config.toml` very often
// resolves to `~/dotfiles/codex/config.toml`, which leaves codexHome while staying the user's own
// file. A target resolving OUTSIDE home is refused — as is a `CODEX_HOME` pointed outside home,
// which the same check catches at the read.
//
// WHAT: the `[mcp_servers.agkit]` table the shipped detector re-reads verbatim, plus one
// `approval_mode = "approve"` table per READ-ONLY tool. The tool list is DERIVED from the
// advertised annotations (`codexReadOnlyApprovalTools`), never curated: pre-approving something
// that can write is the one thing this leg may never do.
import { join } from "node:path";
import { CliLocalError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";
import { CodexConfigError, spliceCodexConfig } from "./codex-toml";
import { leg, SETUP_CONFIG_MAX_BYTES, type SetupDeps, type SetupLeg } from "./legs";

const NAME = "codex";
const PATH_MAX = 200;
export const CODEX_CONFIG_FILE = "config.toml";

/** `CODEX_HOME` (the Codex override) else `~/.codex`. */
export function codexHomePath(deps: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  const override = deps.env.CODEX_HOME;
  return override !== undefined && override.trim() !== "" ? override : join(deps.homeDir, ".codex");
}

export async function codexLeg(deps: SetupDeps, requested: boolean, absBin: string | null): Promise<SetupLeg> {
  if (!requested) {
    return leg(NAME, "skipped", "not requested — pass `--client codex` to register with Codex too");
  }
  const codexHome = codexHomePath(deps);
  const path = join(codexHome, CODEX_CONFIG_FILE);
  const shown = displayCapped(path, PATH_MAX);
  if (absBin === null) {
    return leg(NAME, "manual", `${shown}: no absolute \`agkit\` binary resolved, so nothing can be registered`, {
      path,
    });
  }
  const tools = await readOnlyApprovalTools();
  try {
    return deps.check
      ? await checkCodex(deps, { path, shown, absBin, tools })
      : await applyCodex(deps, { path, shown, absBin, tools, codexHome });
  } catch (err) {
    return refusal(err, shown, path);
  }
}

/**
 * The read-only roster, loaded LAZILY and deliberately (the `core/output/jq.ts` precedent for a
 * dynamic import). Two reasons, and both are load-bearing:
 *
 *   1. IMPORT CYCLE. `codex-allowlist` derives from the MCP tool compiler (`mcp/tool-defs`), which
 *      does eager top-level work over the ASSEMBLED `registry`. This module is reachable FROM
 *      registry.ts (registry → setup/spec → setup/run → here), so a static import would evaluate
 *      the compiler while registry.ts is still initializing, and it would read an undefined
 *      binding. Deferring to call time is the fix: by the time a leg runs the registry is whole.
 *   2. BUNDLE WEIGHT. Nothing else in the CLI graph imports the tool compiler. A static import
 *      would pull the entire MCP schema compiler into `dist/cli.js` for every invocation; this way
 *      it loads only when someone actually asks for `--client codex`.
 */
async function readOnlyApprovalTools(): Promise<readonly string[]> {
  const { codexReadOnlyApprovalTools } = await import("../../core/mcp/codex-allowlist");
  return codexReadOnlyApprovalTools();
}

interface CodexArgs {
  readonly path: string;
  readonly shown: string;
  readonly absBin: string;
  readonly tools: readonly string[];
}

/** READ-ONLY: the follow-READ resolves and reads; it never creates a directory or a file. */
async function checkCodex(deps: SetupDeps, a: CodexArgs): Promise<SetupLeg> {
  const io = { within: deps.homeDir, maxBytes: SETUP_CONFIG_MAX_BYTES };
  const read = await deps.follow.readTextFileFollowing(a.path, io);
  const current = read.status === "present" ? read.text : null;
  const facts = { path: a.path, resolved_path: read.resolvedPath, tool_count: a.tools.length };
  // The SAME splice the apply arm would write — a dry run cannot disagree with its own writer.
  const desired = spliceCodexConfig(current, a.absBin, a.tools);
  if (current === desired) {
    return leg(NAME, "current", `${a.shown}: the agkit server block and tool approvals are current`, facts);
  }
  return leg(
    NAME,
    "would_change",
    current === null ? `${a.shown}: does not exist` : `${a.shown}: the agkit server block is missing or out of date`,
    facts,
  );
}

/** APPLY: provision the root (the ONE creating call), then read → splice → bound write → verify. */
async function applyCodex(deps: SetupDeps, a: CodexArgs & { codexHome: string }): Promise<SetupLeg> {
  // `ensureRootForApply` proves containment in home BEFORE it creates anything, then re-realpaths
  // and re-validates over the real bytes. It runs ONLY here — never on the check path.
  const realHome = deps.follow.ensureRootForApply(a.codexHome, { homeDir: deps.homeDir });
  const path = join(realHome, CODEX_CONFIG_FILE);
  const shown = displayCapped(path, PATH_MAX);
  const io = { within: deps.homeDir, maxBytes: SETUP_CONFIG_MAX_BYTES };

  const read = await deps.follow.readTextFileFollowing(path, io);
  const current = read.status === "present" ? read.text : null;
  const desired = spliceCodexConfig(current, a.absBin, a.tools);
  const facts = { path, resolved_path: read.resolvedPath, tool_count: a.tools.length };
  if (current === desired) {
    return leg(NAME, "current", `${shown}: the agkit server block and tool approvals are current`, facts);
  }
  const written = await deps.follow.writeTextFileFollowing(path, desired, {
    ...io,
    expected: {
      resolvedPath: read.resolvedPath,
      identity: read.status === "present" ? read.identity : null,
    },
  });
  const verified = await deps.follow.verifyFollowedWrite(path, desired, io);
  if (!verified.ok) return leg(NAME, "refused", `${shown}: ${verified.detail}`, facts);
  return leg(NAME, "done", `${shown}: registered the agkit MCP server and ${a.tools.length} read-only tool approvals`, {
    ...facts,
    resolved_path: written.resolvedPath,
    ...(written.cleanupWarning !== undefined ? { cleanup_warning: written.cleanupWarning } : {}),
  });
}

/**
 * A refused edit (a shape the conservative surgeon will not interpret — duplicate tables, a
 * non-canonical header spelling, a multi-line string) or an fs-seam refusal (a target outside
 * home, an unreadable file). Both wrote NOTHING; the typed `reason` travels so the user knows
 * which shape to fix. Anything else rethrows.
 */
function refusal(err: unknown, shown: string, path: string): SetupLeg {
  if (err instanceof CodexConfigError) {
    return leg(NAME, "refused", `${shown}: ${err.message} — edit it by hand`, { path, reason: err.reason });
  }
  if (err instanceof CliLocalError) {
    return leg(NAME, "refused", err.detail ?? `${shown}: could not be reconciled`, { path });
  }
  throw err;
}
