// The exit-code taxonomy (T-207, canonical L2-CLI-04, deliverable 1). This is the
// CLOSED set of process exit codes the CLI is allowed to produce — nothing outside
// it may ever reach `process.exitCode`. The provisional `EXIT_USAGE=64` (run.ts)
// and the `70` bootstrap codes are RETIRED in favour of this table.
//
//   0   success
//   1   retryable   — network / timeout / 5xx / 429-after-retries (retry_with_backoff)
//   2   terminal    — validation / auth / scope / not-found / conflict / plan-stale /
//                     confirmation-required / EVERY CLI-local code / unknown server code
//   3   partial     — batch / pagination partial success (envelope carries
//                     `partial:true` + `warnings[]`); the ONLY non-error exit != 0
//   130 SIGINT       — 128 + SIGINT(2); the interrupted-by-Ctrl-C convention
//
// EPIPE (e.g. `agkit … | head`) is NOT in this table on purpose: a reader that
// closes the pipe early is not an agkit error — it exits CLEAN 0 (wired in cli.ts).
//
// This module has ZERO imports so it is safe to reference from the render
// chokepoint (serialize.ts) and the bin bootstrap without risking an import cycle.
export const EXIT = {
  SUCCESS: 0,
  RETRYABLE: 1,
  TERMINAL: 2,
  PARTIAL: 3,
  SIGINT: 130,
} as const;

/** The union of the five legal exit codes. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The legal set as a runtime array — the conformance test iterates it. */
export const EXIT_CODES: readonly ExitCode[] = [
  EXIT.SUCCESS,
  EXIT.RETRYABLE,
  EXIT.TERMINAL,
  EXIT.PARTIAL,
  EXIT.SIGINT,
];

const EXIT_CODE_SET: ReadonlySet<number> = new Set(EXIT_CODES);

/** Runtime guard: is `n` one of the five ratified exit codes? */
export function isExitCode(n: number): n is ExitCode {
  return EXIT_CODE_SET.has(n);
}
