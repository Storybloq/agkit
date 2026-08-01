// The thrown-error dispatcher (T-207, canonical L2-CLI-04). ONE function the shell
// (run.ts) calls for every caught error; it maps any thrown value to a teachable
// `{envelope, exitCode}`. This is where the whole taxonomy converges — CLI-local
// codes (T-205/T-206 folded in here), wire problems (T-211 seam), malformed output
// flags, and the generic fallback. FORBIDDEN discipline honored throughout: the
// fallback NEVER string-matches human prose to branch (it wraps the message
// verbatim as `detail`); nothing produces an exit code outside {1,2}.
import { UnknownFieldError } from "../output/project";
import { OutputFlagError } from "../output/config";
import {
  KeychainUnavailableError,
  InsecureStorageRefusedError,
  InsecureFilePermissionsError,
} from "../auth/errors";
import { AmbiguousPrefixError, CliLocalError } from "./cli-codes";
import { WireProblemError } from "./wire-classify";
import {
  cliLocalErrorEnvelope,
  wireErrorEnvelope,
  retryableTransportEnvelope,
  PreClassifiedError,
  type ClassifiedError,
} from "./problem";

/** Context that lets the dispatcher concretize hints (the real command path). */
export interface ClassifyOpts {
  /** Command path tokens (argv before the first flag), e.g. ["project","get"]. */
  commandPath?: readonly string[];
  /**
   * A14: the SOURCE-AWARE hint a failed refresh emitted (e.g. "renew AGKIT_TOKEN"). When present
   * it OVERRIDES the default `agkit login` hint the wire classifier attaches to a `refresh_auth`
   * (401 `token_expired`) disposition — hint metadata only, applied by `wireErrorEnvelope` and
   * ONLY on that disposition (an unrelated wire error is never given the refresh hint).
   */
  refreshHint?: string;
}

/**
 * Stringify a thrown value for `detail` WITHOUT letting it crash the classifier. A
 * hostile / exotic thrown value (an object with a `Symbol.toPrimitive` or `message`
 * getter that throws) must not turn error rendering into an uncaught crash — the
 * "never crash" contract (deliverable 5) is absolute. Falls back to a static string.
 */
export function safeErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * The command path (tokens before the first `--flag`) from raw argv — used to
 * concretize hints like `agkit version --json version`. Mirrors vocab.splitExample.
 */
export function commandPathFromArgv(argv: readonly string[]): string[] {
  const path: string[] = [];
  for (const tok of argv) {
    if (tok.startsWith("-")) break;
    path.push(tok);
  }
  return path;
}

/** Map any thrown value to a teachable envelope + its (matching) exit code. */
export function classifyThrownError(err: unknown, opts: ClassifyOpts = {}): ClassifiedError {
  const path =
    opts.commandPath && opts.commandPath.length > 0 ? opts.commandPath.join(" ") : undefined;
  const helpHint = path ? `agkit ${path} --help` : "agkit --help";

  // --- an already-classified error (B0 carrier): a handler that rendered a wire problem through the
  // allowlisted scrub (sync) built its own {envelope, exitCode}. Pass it through verbatim — FIRST, so
  // a WireProblemError never gets re-routed to the general (server-string-preserving) renderer below.
  if (err instanceof PreClassifiedError) return err.classified;

  // --- a wire problem (T-211 throws WireProblemError; unit-tested with fixtures now). T-212 threads
  // the catch-site `hintOverride` (the exact re-plan command a plan-code error carries) through.
  if (err instanceof WireProblemError)
    return wireErrorEnvelope(err.problem, { refreshHint: opts.refreshHint, hintOverride: err.hintOverride });

  // --- unknown `--json` field (thrown by the serializer's projection, T-205)
  if (err instanceof UnknownFieldError) {
    const available = err.available;
    const detail =
      `'${err.field}' is not a field` +
      (available.length > 0 ? ` — available: ${available.join(", ")}` : "");
    // Concretize the hint to a real, runnable command when we know both the path
    // and at least one actually-available field.
    const hint =
      path && available.length > 0 ? `agkit ${path} --json ${available[0]}` : undefined;
    return cliLocalErrorEnvelope("unknown_field", {
      detail,
      hint,
      extra: { field: err.field, available_fields: available },
    });
  }

  // --- T-206 credential chain: fold its three codes into the closed registry. The
  // long teachable messages (which NAME the remedies) ride in `detail`.
  if (err instanceof KeychainUnavailableError) {
    return cliLocalErrorEnvelope("keychain_unavailable", {
      detail: err.message,
      extra: { remedies: err.remedies },
    });
  }
  if (err instanceof InsecureStorageRefusedError) {
    return cliLocalErrorEnvelope("insecure_storage_refused", { detail: err.message });
  }
  if (err instanceof InsecureFilePermissionsError) {
    return cliLocalErrorEnvelope("insecure_file_permissions", {
      detail: err.message,
      extra: { path: err.path, mode: err.mode },
    });
  }

  // --- any CLI-local error (ambiguous_prefix today; confirmation_required /
  // not_logged_in / version_skew via T-211). AmbiguousPrefixError carries the
  // candidate list, so concretize the hint to "use a fuller id" when we know the path.
  if (err instanceof CliLocalError) {
    let hint = err.hint;
    if (err instanceof AmbiguousPrefixError && path && err.candidates.length > 0) {
      hint = `agkit ${path} ${err.candidates[0]}`;
    }
    return cliLocalErrorEnvelope(err.code, {
      detail: err.detail,
      hint,
      extra: err.extra,
      message: err.message,
    });
  }

  // --- a malformed output flag (`--jq`/`--template` with no expression) — usage_error.
  if (err instanceof OutputFlagError) {
    return cliLocalErrorEnvelope("usage_error", { detail: err.message, hint: helpHint });
  }

  // --- a retry-EXHAUSTED transport/transient failure (RetryableTransportError, thrown by the
  // typed client's retry engine, core/client/retry). It renders as a RETRYABLE error, exit 1
  // ALWAYS — never the generic terminal-2 fallback below (A2/A30), and never a smuggled exit from
  // the error object (the envelope builder pins exit 1, so a name-matching error carrying a bogus
  // exitCode cannot make this branch emit success/terminal). Duck-typed by name to avoid a
  // core/errors ⇄ core/client import cycle (retry.ts already imports from core/errors); the
  // check is specific to that one exported class.
  if (err instanceof Error && err.name === "RetryableTransportError") {
    const e = err as Error & { status?: unknown };
    return retryableTransportEnvelope(safeErrorMessage(err), {
      status: typeof e.status === "number" ? e.status : null,
    });
  }

  // --- fallback: everything else (yargs unknown-command / arg errors, zod
  // validation, an unexpected Error) — usage_error, exit 2. We wrap the message
  // VERBATIM as detail (via safeErrorMessage, which never itself throws); we NEVER
  // inspect the prose to branch (FORBIDDEN).
  return cliLocalErrorEnvelope("usage_error", { detail: safeErrorMessage(err), hint: helpHint });
}
