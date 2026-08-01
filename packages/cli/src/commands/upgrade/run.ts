// `agkit upgrade` handler (T-222 step 7, §4.7). Evidence-based self-update: it detects HOW this
// binary was installed and MUTATES only when it positively proves an `npm -g` install (FORBIDDEN 3).
//   • npm-global → run `npm install -g <pkg>@latest` through the redacting sink + sanitized env
//     (the seam owns the tree-kill watchdog); success → a `setup --check` reminder (D-7); a
//     non-zero/timeout → a teachable terminal error carrying the manual command.
//   • npx / dev / unknown → PRINT the manual command (`data.command`), run NOTHING, exit 0.
// Handler stays pure: all exec/fs/clock ride `requireService(ctx)`; all writes ride `runtime.stderr`.
import { z } from "zod";
import { type CommandHandler, requireRuntime, requireService } from "../types";
import { contractFacts } from "../../contract";
import { CliLocalError } from "../../core/errors";
import { IS_DEV } from "../../version";
import { detectInstallMethod, npmCommand } from "../../core/service/install-method";
import { PACKAGE_NAME } from "../../core/housekeeping/update-check-child";

/** Hard watchdog for the whole `npm install -g` run (the seam terminates the tree on expiry). */
export const UPGRADE_TIMEOUT_MS = 120_000;

/** No input — `agkit upgrade` takes no arguments. */
export const upgradeRunArgs = z.object({}).strict();
export type UpgradeRunInput = z.infer<typeof upgradeRunArgs>;

export const upgradeRun: CommandHandler<UpgradeRunInput> = async (ctx) => {
  const runtime = requireRuntime(ctx);
  const service = requireService(ctx);
  // The manual command is single-sourced from PACKAGE_NAME — the same identity `upgrade` would run.
  const command = `npm install -g ${PACKAGE_NAME}@latest`;

  const method = await detectInstallMethod({
    argv1: service.argv1,
    realpath: service.realpath,
    probeChild: service.probeChild,
    isDev: IS_DEV,
    platform: service.platform,
  });

  if (method !== "npm-global") {
    // npx / dev / unknown: we did NOT positively detect a mutable npm-global install → touch nothing.
    return {
      data: { method, performed: false, command },
      warnings: [`this build was not installed via npm -g (detected: ${method}); to upgrade, run: ${command}`],
      meta: contractFacts(),
    };
  }

  // npm-global: the ONLY mutating path. The seam streams the child's output through the redacting
  // sink (→ our stderr) with a sanitized env and terminates the whole process tree on timeout.
  const result = await service.runChild(npmCommand(service.platform), ["install", "-g", `${PACKAGE_NAME}@latest`], {
    timeoutMs: UPGRADE_TIMEOUT_MS,
    onLine: (line) => runtime.stderr(line + "\n"),
  });

  if (result.timedOut || result.code !== 0) {
    // Teachable terminal error (exit 2, closed code set) carrying the manual command as the hint.
    throw new CliLocalError("usage_error", {
      detail: result.timedOut ? "the self-update timed out and was stopped" : "the self-update command failed",
      hint: command,
    });
  }

  // D-7: the skill tree re-syncs on the next run, but nudge an explicit verification.
  runtime.stderr("run `agkit setup --check` to verify the new install\n");
  return { data: { method, performed: true, command }, meta: contractFacts() };
};
