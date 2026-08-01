// T-224 — the `agkit setup` handler. A thin shell over four independent legs: it narrows the
// injected seams, resolves the ONE absolute shim every registration leg bakes in, runs the legs in
// order, and folds their statuses into an exit code. Every decision of substance lives in a leg
// module (`skill-leg` / `claude-leg` / `agents-leg` / `codex-leg`); this file only sequences them.
//
// THE TWO MODES, AND THE ONE RULE THAT SEPARATES THEM:
//   • `--check` writes NOTHING. Not a directory, not a temp file, not a child process. That is not
//     a convention this file enforces with an `if` at the end — each leg's check arm is read-only
//     BY CONSTRUCTION (the pure resolver + the follow-READ, never `ensureRootForApply`, never
//     `runChild`), so there is no code path where a check could write even if this fold were wrong.
//     Exit: 1 when ANY leg is not converged (D-check-v2 — would_change, manual and refused all
//     count), 0 only when the machine is fully set up.
//   • the plain run APPLIES. Exit 0 when every leg is done-or-current; exit 3 (PARTIAL) when any
//     leg needs the user — the `init` precedent for "did some of it, and here is the rest".
//
// `verdictExit` is how a SUCCESS envelope carries exit 1 (the drift REPORT is the payload; an
// error document would throw the report away). Its usage is source-scan-locked, and this plane is
// on that allowlist deliberately — see verdict-exit-lock.test.ts.
import { EXIT } from "../../core/errors";
import { requireRuntime, requireService, requireFollowSeams, requireSkillInstallFacts } from "../types";
import type { CommandHandler, CommandResult } from "../types";
import { VERSION } from "../../version";
import { resolveAgkitBin } from "../../core/mcp/registration";
import { setupRunArgs, toBool, type SetupRunInput } from "./args";
import { agentsMdLeg } from "./agents-leg";
import { claudeMcpLeg } from "./claude-leg";
import { codexLeg } from "./codex-leg";
import { skillLeg } from "./skill-leg";
import { changedCount, isDrift, isPending, type SetupDeps, type SetupLeg } from "./legs";

export { setupRunArgs };
export type { SetupRunInput };

export const setupRun: CommandHandler<SetupRunInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const service = requireService(ctx);
  const install = requireSkillInstallFacts(service);
  const check = toBool(input.check);

  const deps: SetupDeps = {
    check,
    homeDir: rt.homeDir,
    cwd: rt.cwd,
    env: rt.env,
    platform: service.platform,
    version: VERSION,
    now: service.now,
    pid: install.pid,
    sourceDir: install.skillSourceDir,
    installFs: service.installFs,
    argv1: service.argv1,
    runChild: service.runChild,
    // Fail LOUD if the shell wired no follow seams: a leg that reported "current" because its
    // reader was absent is exactly the dishonesty this command exists to prevent.
    follow: requireFollowSeams(rt),
  };

  // ONE resolution, shared by BOTH registration legs: Claude and Codex must be pointed at the same
  // binary, and a ladder run twice could answer twice (a PATH that changed mid-run).
  const absBin = resolveAgkitBin({
    argv1: deps.argv1,
    env: deps.env,
    platform: deps.platform,
    fs: deps.installFs,
  });

  // Sequential, not parallel: three of the four touch the filesystem, and a deterministic order is
  // what makes the report readable and the tests exact.
  const legs: SetupLeg[] = [
    skillLeg(deps),
    await claudeMcpLeg(deps, absBin),
    await agentsMdLeg(deps),
    await codexLeg(deps, input.client === "codex", absBin),
  ];

  return check ? checkResult(legs) : applyResult(legs);
};

/**
 * `--check`: the drift REPORT, with the verdict on the exit channel (D3). The envelope BYTES are
 * the same document either way — only the process exit encodes the verdict, exactly as `selftest`
 * does. Converged ⇒ the member is omitted entirely and the run exits 0.
 */
function checkResult(legs: readonly SetupLeg[]): CommandResult {
  const drifted = legs.filter(isDrift);
  const data = { check: true, legs, changed_count: changedCount(legs, true) };
  if (drifted.length === 0) return { data };
  return { data, verdictExit: EXIT.RETRYABLE, warnings: drifted.map((l) => l.detail) };
}

/** The apply run: exit 0 when everything converged, exit 3 when some of it needs the user. */
function applyResult(legs: readonly SetupLeg[]): CommandResult {
  const pending = legs.filter(isPending);
  const data = { check: false, legs, changed_count: changedCount(legs, false) };
  if (pending.length === 0) return { data };
  return {
    data,
    meta: { partial: true },
    warnings: [
      "`agkit setup` could not finish every step — the rest is listed below and needs you",
      ...pending.map((l) => l.detail),
    ],
  };
}
