// `mcp serve` (T-222, canonical L2-CLI-20) — the in-process MCP handoff. The command is
// the ONE stdout-takeover citizen (types.ts stdoutTakeover): once dispatched, stdout
// belongs to the MCP stdio protocol (T-226 writes the frames), so the shell emits no
// envelope and every failure renders on stderr. A12: the strict empty args schema makes
// any unsupported flag a usage_error BEFORE the takeover hands stdout away.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const mcpServeArgs = z.object({}).strict();

export const mcpServe: CommandHandler<Record<string, never>> = async () => {
  // S2: DYNAMIC import — defers the future registry↔mcp import cycle and the mcp module's
  // eval cost (both files are tsup entries sharing chunks). T-226 replaces ONLY the body
  // of startMcpServer; this handoff line is stable.
  //
  // T-226 S3b: the roster/dispatch table is injected, not built by the shell (mcp.ts's
  // default table is an EMPTY roster). `mcp/session` is imported DYNAMICALLY for the same
  // reason `mcp` is: it reaches the command registry, and this file is itself reachable
  // FROM that registry — a static edge here would close the cycle the S2 note defers.
  const [{ startMcpServer }, { productionMcpToolTable }] = await Promise.all([
    import("../../mcp"),
    import("../../mcp/session"),
  ]);
  await startMcpServer({ tools: productionMcpToolTable() });
  // The takeover dispatch DISCARDS this value (no envelope is ever emitted) — it exists
  // only to satisfy the CommandHandler contract.
  return { data: null };
};
