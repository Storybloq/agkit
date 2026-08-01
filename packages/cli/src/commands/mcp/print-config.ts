// `agkit mcp print-config` handler (T-228 req 1, MCP-12). It answers ONE question — "what exactly
// do I paste into my MCP client to attach THIS installation?" — and its whole payload is the
// answer's bytes.
//
// THE ONE THING IT DECIDES IS THE BIN TOKEN. Every byte of every snippet comes from the two
// emitters in `core/mcp/registration.ts` (`claudeMcpAddCommand`, `codexServerBlock`), which are the
// same emitters `agkit setup` writes with and the same ones `src/mcp/print-config.ts` renders for
// its bare-name variant. Nothing is re-typed here: a renderer copied into this file would be a
// second source for a line whose whole value is that it matches what the writer writes.
//
// WHY ABSOLUTE, AND WHY A REFUSAL WHEN IT CANNOT BE (ISS-560). A registration entry names a
// command an MCP HOST will spawn, in an environment we do not control — a bare `agkit` resolves
// against whatever PATH the host happens to have (an nvm/fnm shim directory is routinely absent
// from a GUI app's environment), and `npx`/`node …` name an interpreter the installed launcher
// already resolves for itself. So this command resolves the ABSOLUTE launcher through T-224's
// ladder (`resolveAgkitBin`) and REFUSES when the ladder returns null. It never falls back to the
// bare name (a silent substitution of the thing the requirement forbids) and never to `setup`'s
// `/absolute/path/to/agkit` placeholder — `isAgkitShimPath` returns TRUE for that placeholder, so a
// pasted one would make our own detector and `agkit mcp doctor` both report REGISTERED while no
// such binary exists. A false "registered" is strictly worse than a refusal (§B-9 honor-or-reject).
//
// IT WRITES NOTHING. The only fs port it touches is `installFs`, and only through the ladder's
// `lstat`-only PATH walk. `agkit setup` remains the sole writer of client configs; this command is
// the copy-paste path for the operator who would rather do it themselves, and the `--json` path for
// a tool that wants the bytes.
import { z } from "zod";
import { type CommandHandler, requireRuntime, requireService } from "../types";
import { CliLocalError } from "../../core/errors";
import { claudeMcpAddCommand, codexConfigPath, codexServerBlock, resolveAgkitBin } from "../../core/mcp/registration";

/**
 * NO FLAGS, deliberately.
 *
 * `--client <claude|codex>` is ruled OUT: `agkit setup` already owns a closed client vocabulary
 * (`setup/args.ts` `SETUP_CLIENTS`), and a second, differently-shaped one in a sibling command is
 * exactly the two-graders drift this epic exists to kill. Filtering is free downstream anyway
 * (`--json`, `--jq`, `--template`).
 *
 * `--bin <path>` is ruled OUT harder: it would let a caller bake a NON-absolute path into a
 * registration, which is the ISS-560 regression itself, handed a flag.
 */
export const mcpPrintConfigArgs = z.object({}).strict();
export type McpPrintConfigInput = z.infer<typeof mcpPrintConfigArgs>;

/** One client's paste-ready block. `target` is the file it belongs in, or null when a CLI owns it. */
interface PrintConfigSnippet {
  /** Machine token (`claude_code` / `codex`), never the prose label a human-facing list would use. */
  readonly client: string;
  /** The grammar of `snippet` — a shell command line, or a TOML document fragment. */
  readonly format: "shell" | "toml";
  /**
   * Where the bytes go. `null` for Claude Code: the `claude` CLI owns `~/.claude.json` and we
   * never name someone else's file as an edit target — we hand over the command that edits it.
   */
  readonly target: string | null;
  readonly snippet: string;
}

export const mcpPrintConfig: CommandHandler<McpPrintConfigInput> = async (ctx) => {
  const runtime = requireRuntime(ctx);
  const service = requireService(ctx);

  // ONE resolution, shared by BOTH snippets — the `setup/run.ts` discipline: a ladder run twice
  // could answer twice (a PATH that changed mid-run) and emit two blocks naming two binaries.
  const bin = resolveAgkitBin({
    argv1: service.argv1,
    env: runtime.env,
    platform: service.platform,
    fs: service.installFs,
  });
  if (bin === null) {
    throw new CliLocalError("binary_unresolved", {
      detail:
        "no absolute `agkit` launcher resolved from argv[1] or PATH — a registration snippet must name an absolute path, never a bare name and never `npx` (ISS-560)",
    });
  }

  // ORDER IS THE CONTRACT: Claude first (the one-liner most operators want), Codex second. It is
  // pinned by this command's own test, because a machine consumer indexing `snippets[1]` is a
  // documented paste path.
  const snippets: readonly PrintConfigSnippet[] = [
    {
      client: "claude_code",
      format: "shell",
      target: null,
      // The platform rides through: a Windows shim path rendered in POSIX quotes would paste as a
      // different command. `claudeMcpAddCommand` picks the dialect; this handler picks neither.
      snippet: claudeMcpAddCommand(bin, service.platform),
    },
    {
      client: "codex",
      format: "toml",
      target: codexConfigPath(runtime.homeDir),
      snippet: codexServerBlock(bin),
    },
  ];

  // `bin` and `platform` ride the DOCUMENT, not just the snippets: they are what makes the bytes
  // reproducible — which launcher these blocks bake in, and which shell dialect the first one was
  // quoted for. A consumer that cannot see them cannot tell a stale snippet from a fresh one.
  return { data: { bin, platform: service.platform, snippets } };
};
