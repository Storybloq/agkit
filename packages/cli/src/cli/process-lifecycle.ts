// T-227 S6 — PROCESS LIFECYCLE: the crash handlers, the bounded stream flush, and the
// stdout-takeover exit latch. The SHELL owns every one of these; a handler may not (the
// handler-purity lint bans `process.exit` / `process.stdout` / `process.stderr` under
// `src/commands/**`, and `mcp serve` is a takeover handler that would otherwise be the one
// place tempted to exit for itself).
//
// WHY THIS FILE EXISTS AT ALL — the two gaps S6 closes:
//
//   1. NOTHING HANDLED `uncaughtException` / `unhandledRejection`. `run().catch` in cli.ts is a
//      last-resort guard for a REJECTED run promise; it cannot see a throw from a timer callback,
//      an EventEmitter listener, or a floating promise. Node's default for both is to print a raw
//      stack to stderr and die — a stack trace is the exact opposite of this CLI's contract (one
//      redacted error envelope, an exit code from the closed taxonomy), and a raw stack can carry
//      bytes the redaction pass exists to mask. Worse, `installProcessSignals` re-THROWS a
//      non-EPIPE stream error BY DESIGN, so that path was guaranteed to land on Node's default.
//
//   2. A STDOUT-TAKEOVER COMMAND COULD LEAVE A ZOMBIE. `mcp serve` resolves when the client closes
//      stdin, but "resolved" only ends the process if nothing else holds the event loop open. One
//      stray `setInterval` anywhere in the graph (ours, a dependency's, a future retry engine) and
//      the process lives forever with its client gone — the ticket's "no process left alive after
//      stdin-end". The takeover therefore ends with an EXPLICIT exit, and it is spelled here rather
//      than in the handler.
//
// THE EXIT IS NOT INSTANT — IT IS BOUNDED. `process.exit()` truncates whatever is still buffered in
// `process.stdout` / `process.stderr`; on macOS those are ASYNC when they are pipes (Node's own
// stream caveat), which is exactly the shape a piped `agkit mcp serve` has. So every exit through
// this module drains what is pending first, under a hard millisecond budget, and exits anyway when
// the budget expires — a slow or dead reader delays the exit by at most `FLUSH_BUDGET_MS`, never
// forever. The budget sits an order of magnitude under the ticket's 1 s stdin-close acceptance.
//
// EVERY SEAM IS INJECTED so this module is unit-testable without ending the test runner: production
// wiring lives in `realLifecycleDeps()` and nowhere else.
import { ENVELOPE_VERSION, redactText } from "../core/output";
import { EXIT, safeErrorMessage } from "../core/errors";

/**
 * The hard ceiling on draining `process.stdout` + `process.stderr` before a lifecycle exit.
 * 250 ms: long enough for a real reader to accept a buffered frame, short enough that the whole
 * exit path stays far inside the ticket's 1 s stdin-close budget even if BOTH streams stall.
 */
export const FLUSH_BUDGET_MS = 250;

/** The minimum a stream must expose for the bounded drain (both std streams satisfy it). */
export interface FlushableStream {
  readonly writableLength: number;
  /** The completion BARRIER (S8 relay fold): stream writes are FIFO, so an empty write's callback
   *  fires only after everything queued before it has been processed — or with an error when the
   *  stream is destroyed. Either way the stream has nothing more this flush could wait for. */
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
}

/** The injected process surface. `realLifecycleDeps()` is the ONE production binding. */
export interface LifecycleDeps {
  /** Raw stderr sink. MAY throw / EPIPE — every caller here treats that as a lost diagnostic. */
  readonly writeStderr: (text: string) => void;
  /** Terminate the process with this code. Production: `process.exit`. */
  readonly exit: (code: number) => void;
  /** Register a process-level crash listener. Production: `process.on`. */
  readonly onCrash: (event: "uncaughtException" | "unhandledRejection", handler: (err: unknown) => void) => void;
  /** The streams a lifecycle exit drains first. */
  readonly streams: readonly FlushableStream[];
  /** The drain ceiling in ms. */
  readonly flushBudgetMs: number;
}

/**
 * The production seams. `process.stdout` / `process.stderr` are resolved AT CALL TIME inside the
 * closures — never captured at module load — so a test that spies on `process.stderr.write` still
 * observes what the shell writes.
 */
export function realLifecycleDeps(): LifecycleDeps {
  return {
    writeStderr: (text: string) => {
      process.stderr.write(text);
    },
    exit: (code: number) => {
      process.exit(code);
    },
    onCrash: (event, handler) => {
      process.on(event, handler as (...args: unknown[]) => void);
    },
    streams: [process.stdout, process.stderr],
    flushBudgetMs: FLUSH_BUDGET_MS,
  };
}

/**
 * The MINIMAL redacted error envelope for a determinate crash — byte-identical in shape to cli.ts's
 * last-resort `run().catch` guard, and deliberately NOT routed through the teachable renderer: this
 * text exists precisely for the cases where the renderer itself may be what failed.
 *
 * `safeErrorMessage` never throws (a hostile `toString`/`message` getter cannot turn the crash
 * handler into a second crash) and `redactText` is the same single redaction pass every other
 * caller-visible string rides. `internal` is an EMERGENCY LITERAL, not a taxonomy code — the closed
 * CLI-local registry governs classifier-minted codes only.
 */
export function crashEnvelope(err: unknown): string {
  const message = redactText(safeErrorMessage(err));
  return JSON.stringify({ version: ENVELOPE_VERSION, error: { code: "internal", message } }) + "\n";
}

/**
 * Write one diagnostic to stderr, best-effort. A THROWING stderr (a test double, a closed fd, a
 * synchronous EPIPE) is a LOST DIAGNOSTIC and nothing more — it may never become a second
 * exception, because the callers of this function are the code that runs when everything else has
 * already failed. This is the same contract `transport.ts` states for the guards' diagnostic sink.
 */
export function writeDiagnostic(text: string, sink?: (text: string) => void): void {
  try {
    (sink ?? realLifecycleDeps().writeStderr)(text);
  } catch {
    /* a broken stderr is a lost diagnostic, never a crash */
  }
}

/**
 * Drain the given streams, then call `done` — ONCE, and never later than the budget. Returns
 * nothing: the caller owns what happens after (there is no promise to leak into a loop that is
 * about to end).
 *
 * A stream with nothing buffered is already drained. Otherwise the wait is a WRITE-CALLBACK
 * BARRIER, not a `'drain'` listener (S8 relay fold): Node emits `'drain'` only after backpressure
 * made a `write()` return false, so an ordinary below-highWaterMark buffered write would never
 * signal and every such flush would sit out the full budget. Stream writes are FIFO, so an empty
 * write's callback fires exactly when everything queued BEFORE it has been processed — and it still
 * fires (with an error) on a destroyed stream, so a stream that went away settles too instead of
 * hanging to the budget. `'error'` is deliberately not listened for: `installProcessSignals` owns
 * that event and its non-EPIPE branch throws, so a listener of ours would be racing a handler that
 * is allowed to take the process down.
 */
export function flushStreams(
  streams: readonly FlushableStream[],
  budgetMs: number,
  done: () => void,
): void {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done();
  };
  // Ref'd ON PURPOSE: it is the guarantee that `done` runs. An unref'd timer would let an already
  // empty event loop exit on its own with whatever `process.exitCode` happened to be, which is the
  // silent-wrong-code failure this whole path exists to prevent.
  const timer = setTimeout(settle, budgetMs);

  let pending = 0;
  const onFlushed = (): void => {
    pending -= 1;
    if (pending === 0) settle();
  };
  for (const stream of streams) {
    if (stream.writableLength === 0) continue;
    pending += 1;
    try {
      stream.write("", onFlushed);
    } catch {
      // A stream so broken that even queueing the barrier throws has nothing left to flush.
      pending -= 1;
    }
  }
  if (pending === 0) settle();
}

/** Drain what is pending (bounded), then exit with `code`. The ONE exit shape this module uses. */
export function exitAfterFlush(code: number, deps: LifecycleDeps = realLifecycleDeps()): void {
  flushStreams(deps.streams, deps.flushBudgetMs, () => deps.exit(code));
}

/**
 * Install the two crash handlers. FORBIDDEN by the ticket: swallowing either without a clean exit —
 * so both end in a nonzero exit from the closed taxonomy (`EXIT.TERMINAL`, the same class the
 * last-resort `run().catch` guard assigns a determinate crash), never a provisional code and never
 * a return to a process that has already lost its footing.
 *
 * RE-ENTRANCY IS THE HAZARD THIS LATCH CLOSES. The diagnostic write can itself fault (a broken
 * stderr emits `'error'`, whose listener re-throws for anything but EPIPE → a SECOND
 * uncaughtException), and the bounded flush gives the loop real time in which that can happen. A
 * second crash therefore exits IMMEDIATELY and writes nothing: one envelope per death.
 *
 * INTERPLAY WITH `installProcessSignals` (cli.ts), by design: a non-EPIPE stream error is re-thrown
 * from inside the `'error'` listener, which makes it an uncaughtException. That is what routes it
 * HERE — a genuinely broken stdout/stderr still dies with an envelope and a taxonomy exit code
 * instead of Node's default stack spew.
 */
export function installCrashHandlers(deps: LifecycleDeps = realLifecycleDeps()): void {
  let crashing = false;
  const onCrash = (err: unknown): void => {
    if (crashing) {
      deps.exit(EXIT.TERMINAL);
      return;
    }
    crashing = true;
    writeDiagnostic(crashEnvelope(err), deps.writeStderr);
    exitAfterFlush(EXIT.TERMINAL, deps);
  };
  deps.onCrash("uncaughtException", onCrash);
  deps.onCrash("unhandledRejection", onCrash);
}

// ── the stdout-takeover exit latch ───────────────────────────────────────────────────────────────
//
// SPLIT ACROSS TWO SITES ON PURPOSE. The takeover DISPATCH (build-cli.ts) knows a takeover
// completed; only the BIN (cli.ts) may end the process — an exit from inside the dispatch would
// kill the test runner for every in-process `run(["mcp","serve"])` suite, and an exit from inside
// the handler is what the purity lint forbids outright. So the dispatch raises a flag and the bin
// acts on it, after `run()` has fully settled.

let takeoverCompleted = false;

/** Called by the takeover dispatch tail once a stdout-takeover command has settled (either way). */
export function markStdoutTakeoverComplete(): void {
  takeoverCompleted = true;
}

/** TEST SEAM: clear the latch between cases. Production never calls it (one command per process). */
export function resetStdoutTakeoverLatch(): void {
  takeoverCompleted = false;
}

/** Whether a stdout-takeover command ran to completion in this process. */
export function stdoutTakeoverCompleted(): boolean {
  return takeoverCompleted;
}

/**
 * The bin's post-`run()` step: if this invocation was a stdout takeover, END the process — bounded
 * flush first, then the exit code the dispatch already decided (`process.exitCode`, which
 * `runTakeover` sets on BOTH its paths). A NON-takeover invocation is a strict no-op, which is what
 * keeps every other command's exit contract (pinned by the existing suites) byte-identical: they
 * still exit by draining the event loop with `process.exitCode` set.
 */
export function finalizeStdoutTakeover(deps: LifecycleDeps = realLifecycleDeps()): void {
  if (!takeoverCompleted) return;
  // `process.exitCode` is typed `number | string | undefined` (Node accepts a signal-name string);
  // the CLI only ever assigns a member of the closed numeric taxonomy, so anything else is not a
  // code this shell set and SUCCESS is the honest default. `runTakeover` sets it on both paths.
  const code = process.exitCode;
  exitAfterFlush(typeof code === "number" ? code : EXIT.SUCCESS, deps);
}
