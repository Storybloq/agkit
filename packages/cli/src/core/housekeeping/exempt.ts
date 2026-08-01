// The housekeeping exemption predicate (T-209, canonical L2-CLI-19, deliverable 3 /
// ISS-570, codex M6). Side-effect-free and PURE over its inputs so it is trivially
// table-tested. Housekeeping (skill install + update check + banner) is exempt when:
//   - this is a DEV build (`IS_DEV`) — FORBIDDEN to run housekeeping on 0.0.0-dev; and
//   - the command path begins with `mcp` — a forward-guard for a future `agkit mcp
//     serve` CLI subcommand (the FORBIDDEN "zero housekeeping on mcp serve"). NOTE the
//     REAL MCP server is a separate entry (src/mcp.ts) that never imports housekeeping
//     at all, so this predicate is belt-and-suspenders for the CLI-subcommand shape;
//   - the command path begins with `setup` (T-224 D2) — see EXEMPT_HEADS below.
//
// The command path is the argv tokens before the first `-flag` (the shared
// `commandPathFromArgv`), so `agkit mcp serve --json` -> ["mcp","serve"] is exempt,
// while `agkit status` -> ["status"] is not. A global flag placed BEFORE the command
// (not the documented options-after-path form) yields an empty path and is treated as
// non-mcp — harmless, because the actual mcp server entry is structurally exempt.
import { commandPathFromArgv } from "../errors";
import { IS_DEV } from "../../version";

/** Options for the exemption check — `isDev` is injectable so tests cover both builds. */
export interface ExemptOptions {
  /** Defaults to the build-time `IS_DEV`. */
  readonly isDev?: boolean;
}

/**
 * The command heads that must run NO housekeeping. `mcp` is the T-209/T-222 forward-guard above;
 * `setup` is T-224 (D2) and is exempt for the OPPOSITE reason — not because housekeeping would
 * break it, but because housekeeping would make it LIE. `preCommandHousekeeping` installs the
 * skill tree BEFORE the handler runs, so on a stale machine `agkit setup --check` would report
 * "current" about a tree the very same invocation had just silently fixed, violating "`--check`
 * … exits 1 and changes nothing". `setup` therefore owns its own install: the SAME `install.ts`
 * engine under the SAME O_EXCL lock — one writer, never two racing the same directory.
 *
 * Side effect, and it is the correct one: `agkit setup` now also installs on DEV builds, because
 * housekeeping's `IS_DEV` blanket no longer shields it. An explicit `agkit setup` is a
 * PROVISIONING REQUEST, not a hot path.
 */
const EXEMPT_HEADS: ReadonlySet<string> = new Set(["mcp", "setup"]);

/** True when this invocation must perform NO housekeeping. Pure — no side effects. */
export function isHousekeepingExempt(argv: readonly string[], opts: ExemptOptions = {}): boolean {
  const isDev = opts.isDev ?? IS_DEV;
  if (isDev) return true;
  const head = commandPathFromArgv([...argv])[0];
  if (head !== undefined && EXEMPT_HEADS.has(head)) return true;
  // T-222 A5: the exemption must be RESILIENT to leading global flags — `agkit --json mcp
  // serve` yields an EMPTY command path above, but housekeeping before MCP startup is the
  // FORBIDDEN. Without yargs' flag table a preparse cannot know whether the bare token
  // after a `--flag` is the flag's VALUE or the command head, so BOTH interpretations are
  // computed and ambiguity biases TOWARD exemption (a false skip is benign — housekeeping
  // is best-effort; a missed skip breaks mcp serve's stdout/spawn guarantees). The same
  // reading applies to `setup`: a false skip just means setup does its own install, which it
  // does anyway; a missed skip is the `--check` dishonesty above.
  for (const candidate of headCandidates(argv)) {
    if (EXEMPT_HEADS.has(candidate)) return true;
  }
  return false;
}

/**
 * The possible first-command-token readings of an argv with leading flags: one walk
 * treats every `--flag value` pair as consuming (the bare token is a value), the other
 * treats every flag as boolean (the first bare token is the head). Pure.
 */
function headCandidates(argv: readonly string[]): Set<string> {
  const heads = new Set<string>();
  for (const consumeValues of [true, false]) {
    let i = 0;
    while (i < argv.length) {
      const tok = argv[i]!;
      if (tok.startsWith("-")) {
        i += 1;
        if (consumeValues && !tok.includes("=") && i < argv.length && !argv[i]!.startsWith("-")) i += 1;
        continue;
      }
      heads.add(tok);
      break;
    }
  }
  return heads;
}
