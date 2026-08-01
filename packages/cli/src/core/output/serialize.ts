// THE serializer chokepoint (T-205, canonical L2-CLI-03, deliverable 1). EVERY
// formatter passes through here, and the order is INVARIANT:
//
//        build datum (caller)  ->  APPLY REDACTION REGISTRY  ->  format
//
// `--json`, `--jq`, `--template`, human tables, and the `--verbose` trace ALL sit
// DOWNSTREAM of the single `redact()` call below. There is no path that reaches a
// formatter before redaction.
//
// Stream discipline (deliverable 4): a machine mode (json/jq/template) emits
// EXACTLY ONE document on stdout — success OR error, never both, never a banner.
// Human mode puts data on stdout and error prose on stderr. Diagnostics and the
// verbose trace ALWAYS go to stderr.
import type { CommandResult } from "../../commands/types";
import type { OutputConfig } from "./config";
import {
  buildSuccessEnvelope,
  isErrorEnvelope,
  shownOnceSecrets,
  type Envelope,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from "./envelope";
import { redact } from "./redaction";
import { projectFields } from "./project";
import { runJq } from "./jq";
import { renderTemplate } from "./template";
import { formatHuman, formatHumanError } from "./human";
import { EXIT } from "../errors/exit-codes";

export interface RenderResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Render an envelope to bytes + an exit code. PURE (no process I/O) so a test can
 * assert exact bytes for the SAME envelope under different `isTTY`. `errorExitCode`
 * applies only to error envelopes; success is always 0.
 *
 * May throw `UnknownFieldError` / `JqEvalError` / `TemplateError` (for a SUCCESS
 * envelope) BEFORE writing anything — the caller re-renders those as an error
 * envelope, so a failed projection never emits partial output.
 */
export async function renderEnvelope(
  envelope: Envelope,
  config: OutputConfig,
  errorExitCode = 1,
  verdictExit?: typeof EXIT.RETRYABLE | typeof EXIT.TERMINAL,
): Promise<RenderResult> {
  // --- the single, upstream redaction pass. Everything below is downstream. ----
  const safe = redact(envelope, { shownOnceSecrets: config.shownOnceSecrets }) as Envelope;
  const isError = isErrorEnvelope(safe);
  // Exit-code taxonomy (T-207, deliverable 1): an error uses the classifier's exit;
  // a SUCCESS is 0 unless it is a truncated page (`partial:true`) — batch/pagination
  // partial success is exit 3. This is the ONE place exit 3 is produced. T-222 S4: a
  // diagnostic verdict (selftest) overrides the success exit — the envelope stays a
  // success document with UNCHANGED bytes; only the process exit encodes the verdict.
  const exitCode = isError
    ? errorExitCode
    : (verdictExit ??
      ((safe as SuccessEnvelope).partial === true ? EXIT.PARTIAL : EXIT.SUCCESS));
  const trace = config.verbose ? buildTrace(safe) : "";

  // `auto` resolves by the TTY seam: json when piped (machine default), human in
  // a terminal. `json`/`jq`/`template` are explicit and TTY-invariant.
  const mode = config.mode === "auto" ? (config.isTTY ? "human" : "json") : config.mode;

  switch (mode) {
    case "json": {
      return { stdout: renderJson(safe, config), stderr: trace, exitCode };
    }
    case "jq": {
      const datum = isError ? (safe as ErrorEnvelope).error : (safe as SuccessEnvelope).data;
      const out = await runJq(datum, config.jqExpr ?? ".", { compact: config.compact });
      return { stdout: withTrailingNewline(out), stderr: trace, exitCode };
    }
    case "template": {
      const datum = isError ? (safe as ErrorEnvelope).error : (safe as SuccessEnvelope).data;
      const out = renderTemplate(datum, config.templateExpr ?? "{{.}}");
      return { stdout: withTrailingNewline(out), stderr: trace, exitCode };
    }
    case "human":
    default: {
      if (isError) {
        const prose = formatHumanError((safe as ErrorEnvelope).error, config);
        return { stdout: "", stderr: prose + trace, exitCode };
      }
      const data = (safe as SuccessEnvelope).data;
      const projected = config.fields ? projectFields(data, config.fields) : data;
      return { stdout: withTrailingNewline(formatHuman(projected, config)), stderr: trace, exitCode };
    }
  }
}

/** JSON document for the envelope. Field projection applies to SUCCESS data only. */
function renderJson(safe: Envelope, config: OutputConfig): string {
  let out: Envelope = safe;
  if (!isErrorEnvelope(safe) && config.fields) {
    out = { ...safe, data: projectFields(safe.data, config.fields) };
  }
  const json = config.compact ? JSON.stringify(out) : JSON.stringify(out, null, 2);
  return json + "\n";
}

/** A redacted diagnostic trace (verbose). Built from the ALREADY-redacted envelope. */
function buildTrace(safe: Envelope): string {
  return `# agkit --verbose trace\n# ${JSON.stringify(safe)}\n`;
}

function withTrailingNewline(text: string): string {
  if (text.length === 0) return "";
  return text.endsWith("\n") ? text : text + "\n";
}

// --- thin I/O wrappers (the shell calls these) -------------------------------

function writeResult(result: RenderResult): void {
  // A36 / T-207 deliverable 1 (EPIPE guard — write-site half): a downstream consumer that
  // closes the pipe (`agkit … | head`) makes a stdout/stderr write raise EPIPE. That is a
  // reader that went away, NOT an agkit failure — a SYNCHRONOUS EPIPE at the write site is
  // swallowed and the exit code forced to a clean 0 (no stack trace). This complements — it
  // does NOT replace — the process-level guard in cli.ts:installProcessSignals, which catches
  // the ASYNCHRONOUS EPIPE emitted as a stream `'error'` event (a try/catch here cannot see
  // that one). `--paginate`'s large buffered envelope materially exercises this path.
  try {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (err) {
    if (isBrokenPipe(err)) {
      process.exitCode = EXIT.SUCCESS;
      return;
    }
    throw err;
  }
  process.exitCode = result.exitCode;
}

/** A broken-pipe (EPIPE) errno error — the reader closed the pipe early. */
function isBrokenPipe(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "EPIPE"
  );
}

/**
 * Emit a successful `CommandResult`. Honors a per-call shown-once opt-in (a result
 * whose meta carries the shown-once marker). May throw a projection/jq/template
 * error BEFORE writing — the caller renders that as an error envelope.
 */
export async function emitSuccess(config: OutputConfig, result: CommandResult): Promise<void> {
  const envelope = buildSuccessEnvelope(result);
  const secrets = shownOnceSecrets(result);
  const effective: OutputConfig =
    secrets.length > 0 ? { ...config, shownOnceSecrets: secrets } : config;
  writeResult(await renderEnvelope(envelope, effective, 1, result.verdictExit));
}

/**
 * T-222 A6: the DESTINATION-AWARE redacted error document for the stdout-takeover path
 * (`mcp serve`). It rides the SAME single upstream redaction pass every formatter sits
 * downstream of (renderEnvelope) — a takeover failure can never leak a secret through a
 * raw stringify — rendered as ONE compact JSON line for the caller to write to STDERR
 * (stdout belongs to the protocol). Pure render: the caller owns the write + exit code.
 */
export async function renderTakeoverErrorDoc(envelope: ErrorEnvelope, exitCode: number): Promise<RenderResult> {
  const config: OutputConfig = {
    mode: "json",
    compact: true,
    color: false,
    verbose: false,
    isTTY: false,
    shownOnceSecrets: [],
  };
  return renderEnvelope(envelope, config, exitCode);
}

/**
 * Emit an error envelope. RESILIENT: if the chosen format itself fails (e.g. a
 * malformed `--jq`/`--template` — the very thing that caused the original error),
 * fall back to a plain JSON error so we ALWAYS emit exactly one well-formed
 * document and never crash the emitter.
 */
export async function emitError(
  config: OutputConfig,
  envelope: ErrorEnvelope,
  exitCode: number,
): Promise<void> {
  // Compute the RenderResult (with a json fallback if the chosen format itself
  // fails), THEN write exactly once. writeResult is OUTSIDE the try so a mid-write
  // failure can never be "recovered" into a second write — one document, always.
  let result: RenderResult;
  try {
    result = await renderEnvelope(envelope, config, exitCode);
  } catch {
    const fallback: OutputConfig = {
      ...config,
      mode: "json",
      fields: undefined,
      jqExpr: undefined,
      templateExpr: undefined,
    };
    result = await renderEnvelope(envelope, fallback, exitCode);
  }
  writeResult(result);
}
