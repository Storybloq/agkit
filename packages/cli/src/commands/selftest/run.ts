// `agkit selftest` handler (T-222 6c, canonical L2-CLI-20). A diagnostic whose DATA is a
// report: it emits a SUCCESS envelope carrying all eight checks and encodes the aggregate
// verdict in the PROCESS EXIT via `verdictExit` (pass→0, all-retryable→1, any-terminal→2) —
// the report is never an error document. The pure check runner lives in `core/selftest/run.ts`;
// this handler only assembles the injected seams (`requireRuntime` + `requireService`) and maps
// the verdict onto the exit channel. `meta` stays `contractFacts()`.
import { z } from "zod";
import { type CommandHandler, requireRuntime, requireService } from "../types";
import { VERSION } from "../../version";
import { contractFacts } from "../../contract";
import { runSelftest } from "../../core/selftest/run";
import { EXIT } from "../../core/errors";

/** No input — `agkit selftest` takes no arguments. */
export const selftestRunArgs = z.object({}).strict();
export type SelftestRunInput = z.infer<typeof selftestRunArgs>;

export const selftestRun: CommandHandler<SelftestRunInput> = async (ctx) => {
  const runtime = requireRuntime(ctx);
  const service = requireService(ctx);
  const { checks, verdict } = await runSelftest({
    client: ctx.client,
    keyring: runtime.keyring,
    installFs: service.installFs,
    homeDir: runtime.homeDir,
    cwd: runtime.cwd,
    platform: service.platform,
    env: runtime.env,
    version: VERSION,
    // Absent nodeVersion (a mis-wired seam) fails the binary check honestly rather than crashing.
    nodeVersion: runtime.nodeVersion ?? "",
    now: service.now,
    randomUUID: service.randomUUID,
  });

  // Map the verdict onto the exit channel: `pass` omits the member (exit 0); the two failure
  // classes ride the closed {RETRYABLE, TERMINAL} taxonomy. The envelope bytes are identical
  // regardless of exit — only the process exit encodes the verdict (S4).
  const verdictExit =
    verdict === "terminal_failures"
      ? EXIT.TERMINAL
      : verdict === "retryable_failures"
        ? EXIT.RETRYABLE
        : undefined;

  return {
    data: { ok: verdict === "pass", checks },
    ...(verdictExit !== undefined ? { verdictExit } : {}),
    meta: contractFacts(),
  };
};
