// T-226 test 15 / D0-e — the MCP client CONFIG SNIPPETS: what an operator pastes to attach this
// server to their MCP host. PURE by construction: no fs, no env, no process, no I/O of any kind —
// it returns strings. The CLI command that PRINTS them is T-M3's; this module is the generator half
// only, so the snippets can be byte-tested before any surface exists to render them.
//
// THE COMMAND BYTES NAME THE BINARY, AND NOTHING ELSE. Every snippet invokes `agkit` — never an
// absolute path, never `node /path/to/cli.js`, never `npx`. That is a portability property with
// teeth: an absolute path is correct only on the machine that generated it (and leaks that
// machine's layout into a file people commit), while a `node …` invocation pins an interpreter the
// installed binary already resolves for itself. The one thing a host needs is a command on PATH,
// which is exactly what installing the CLI provides.
//
// THE ARGV IS DERIVED, NOT TYPED. `mcp serve` is the CLI's single stdout-takeover command — the
// registry load-check makes that class local, safe, scope-less and mcpExcluded — so this module
// FINDS that command instead of hardcoding its name. A rename of the noun or verb moves these
// snippets with it; a second takeover command (or none) is a startup failure rather than a snippet
// that tells an operator to run something that does not exist.
//
// THE SHELL LINE IS NOT SPELLED HERE (T-228). It used to be — a hand-typed
// `claude mcp add agkit -- agkit mcp serve` that had silently lost the `-s user` scope flag the
// WRITER (`agkit setup`) has always passed. Two sources for one line is how that happens, so this
// module now DELEGATES to `claudeMcpAddCommand`, the single emitter in `core/mcp/registration.ts`
// that `setup` and `agkit mcp print-config` also render. The only thing this module still decides
// is the BIN TOKEN it hands that emitter: the bare `agkit` (see above), where the COMMAND hands it
// a resolved absolute path. One renderer, two deliberate arguments.
import type { AnyCommandSpec } from "../commands/types";
import { RegistryError, registry } from "../commands/registry";
import { claudeMcpAddCommand } from "../core/mcp/registration";

/** The installed binary name (package.json `bin`). The only executable these snippets may name. */
export const MCP_BINARY = "agkit";

/** One host's configuration snippet. */
export interface McpClientConfigSnippet {
  /** The host this snippet is for, as an operator would recognize it. */
  readonly client: string;
  /** The bytes to paste — a shell command, or a JSON document. */
  readonly snippet: string;
}

/** The MCP server key hosts index this server under (matches the binary, deliberately). */
const SERVER_KEY = "agkit";

/**
 * The argv that starts the server: the registry's ONE stdout-takeover command, as `[noun, verb]`.
 * Fail-closed at module load — a missing or duplicated takeover command means the CLI no longer has
 * exactly one MCP entry point, and a config snippet must not guess which one to name.
 */
function serveArgv(specs: readonly AnyCommandSpec[] = registry): readonly string[] {
  const takeover = specs.filter((spec) => typeof spec.stdoutTakeover === "string" && spec.stdoutTakeover.length > 0);
  if (takeover.length !== 1) {
    throw new RegistryError(
      `MCP print-config: expected EXACTLY ONE stdout-takeover command to name in a client config, found ${takeover.length}`,
    );
  }
  return [takeover[0]!.noun, takeover[0]!.verb];
}

/** The full command an MCP host runs: the binary plus the takeover argv. FROZEN, not just
 *  type-readonly (relay chunk-26): a JS consumer pushing onto a merely TS-readonly array would
 *  corrupt every later snippet while the precomputed command string stayed stale. */
export const MCP_SERVE_ARGV: readonly string[] = Object.freeze([...serveArgv()]);
export const MCP_SERVE_COMMAND = `${MCP_BINARY} ${MCP_SERVE_ARGV.join(" ")}`;

/** The `mcpServers` block both JSON-configured hosts use, 2-space indented with a trailing LF. */
function mcpServersJson(): string {
  return `${JSON.stringify(
    { mcpServers: { [SERVER_KEY]: { command: MCP_BINARY, args: [...MCP_SERVE_ARGV] } } },
    null,
    2,
  )}\n`;
}

/**
 * The config snippets, in the order an operator most likely wants them: the one-liner first, then
 * the two files. No environment block is emitted: this server takes its credential from the CLI's
 * own chain (N-011 APX-E.1), so a config that planted `AGKIT_TOKEN` in a committed JSON file would
 * be teaching the exact habit the credential chain exists to avoid.
 */
export function mcpClientConfigSnippets(): readonly McpClientConfigSnippet[] {
  const json = mcpServersJson();
  return [
    // `"linux"` is the QUOTING DIALECT, not a claim about the host: this module's bin token is the
    // bare `agkit`, which every shell leaves unquoted, so POSIX rules render byte-identically to
    // cmd.exe rules here. The COMMAND passes the real `service.platform`, because ITS token is an
    // absolute path that can carry spaces.
    { client: "Claude Code (CLI)", snippet: claudeMcpAddCommand(MCP_BINARY, "linux") },
    { client: "Claude Code (.mcp.json)", snippet: json },
    { client: "Claude Desktop (claude_desktop_config.json)", snippet: json },
  ];
}
