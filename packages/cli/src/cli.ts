#!/usr/bin/env node
// The `agkit` binary. The node>=22 gate MUST run first (before any modern
// syntax/APIs), exactly as in T-203. Everything after it is driven by the
// CommandSpec registry: src/cli/ builds the yargs shell from src/commands/registry
// (T-204). `agkit version` emits the `{ version, data }` success envelope via the
// registry's `version` command. The serializer chokepoint (envelope + redaction +
// --json/--jq/--template) is T-205; the exit-code taxonomy + teachable-error
// renderer is T-207 (src/core/errors). Never add a second bin name (T-203 FORBIDDEN).
import { assertNodeVersion } from "./runtime-gate";
import { run } from "./cli/run";
import { EXIT } from "./core/errors";
import {
  crashEnvelope,
  finalizeStdoutTakeover,
  installCrashHandlers,
  writeDiagnostic,
} from "./cli/process-lifecycle";

assertNodeVersion();
installProcessSignals();
// T-227 S6 (req 1): uncaughtException / unhandledRejection — the two death paths `run().catch`
// structurally cannot see (a throw from a timer callback or an event listener, a floating
// promise). Installed BEFORE run() so nothing the shell does can die on Node's default stack
// spew. Both end in one redacted envelope on stderr + a bounded flush + EXIT.TERMINAL.
installCrashHandlers();

run(process.argv.slice(2))
  .catch((err: unknown) => {
    // Last-resort guard: run() renders known usage/handler/projection/wire errors
    // through the chokepoint; this catches anything that escapes it (including a
    // failure INSIDE the teachable renderer itself — which is why this path does NOT
    // route back through it). We scrub concrete secrets and emit the minimal
    // error-envelope shape (crashEnvelope — the SAME bytes the crash handlers write).
    // It is a determinate crash → TERMINAL (exit 2), never a provisional 70;
    // `internal` there is an emergency literal, NOT a taxonomy code (the closed
    // CLI-local registry governs classifier-minted codes only).
    // safeErrorMessage never itself throws (a hostile toString/message getter can't
    // turn THIS last-resort guard into an uncaught crash — "never crash" is absolute),
    // and the WRITE is wrapped too: a throwing/EPIPE'd stderr is a lost diagnostic here,
    // never a second exception thrown out of the last-resort guard itself.
    writeDiagnostic(crashEnvelope(err));
    process.exitCode = EXIT.TERMINAL;
  })
  .finally(() => {
    // T-227 S6 (req 1, "no process left alive after stdin-end"): a stdout-takeover command
    // (`mcp serve`) ENDS the process once it settles — bounded flush, then the exit code the
    // takeover dispatch already set. A pending timer anywhere in the graph would otherwise keep
    // a client-less server alive forever. Strict no-op for every non-takeover command.
    finalizeStdoutTakeover();
  });

/**
 * Process-level signal + stream wiring (T-207, deliverable 1 + FORBIDDEN set):
 *   - EPIPE on stdout/stderr (e.g. `agkit … | head`) is a reader that closed the
 *     pipe early — NOT an agkit error. Exit CLEAN 0 instead of Node's default
 *     "Error: write EPIPE" crash. A non-EPIPE stream error is genuinely broken, so
 *     it re-throws (becomes an uncaughtException).
 *   - SIGINT (Ctrl-C) exits 130 (128 + SIGINT), the interrupted convention.
 */
function installProcessSignals(): void {
  const onStreamError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") process.exit(EXIT.SUCCESS);
    throw err;
  };
  process.stdout.on("error", onStreamError);
  process.stderr.on("error", onStreamError);
  process.on("SIGINT", () => process.exit(EXIT.SIGINT));
}
