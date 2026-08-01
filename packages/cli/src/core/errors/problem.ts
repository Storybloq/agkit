// The teachable-problem builder (T-207, canonical L2-CLI-04, deliverables 3 + 4).
//
// A teachable error IS an RFC 9457 problem passed through (A8), extended with:
//   - `code`      : a wire code (vendored table) OR a CLI-local code (closed set)
//   - `hint`      : an exact, copy-pasteable recovery command
//   - `exit_code` : the taxonomy exit for this error
// plus the RFC 9457 passthrough members (`type`, `title`, `status`, `detail`,
// `instance`, `request_id`, `retry`). Everything renders DOWNSTREAM of the
// serializer chokepoint: these builders only produce the `{version, error{…}}`
// envelope + its exit code — serialize.ts redacts and formats it, human.ts renders
// the two lines, json emits the `error` member verbatim. `exit_code` and `hint`
// are placed IN the envelope's error member so JSON output carries them (deliverable
// 4), and the returned `exitCode` is the SAME value (single source — never a skew
// between `error.exit_code` and the process exit).
import { buildErrorEnvelope, type ErrorEnvelope } from "../output/envelope";
import { CLI_LOCAL_REGISTRY, type CliLocalCode } from "./cli-codes";
import { EXIT, type ExitCode } from "./exit-codes";
import { classifyWireProblem, type WireProblem } from "./wire-classify";
import { clientAheadRemedy } from "./skew-remedy";
import { MANAGEMENT_CONTRACT_VERSION } from "../../contract";

/** An error envelope paired with its (matching) process exit code. */
export interface ClassifiedError {
  envelope: ErrorEnvelope;
  exitCode: ExitCode;
}

/** Options the shell may supply when rendering a WIRE problem (T-211 / A14; T-212 hintOverride). */
export interface WireErrorOptions {
  /** A source-aware refresh hint that OVERRIDES the default `agkit login` on a refresh_auth 401. */
  refreshHint?: string;
  /**
   * T-212 (S5a): an EXACT catch-site recovery command (the plan/apply ceremony's re-plan hint for a
   * `plan_stale` / `plan_expired` / `plan_already_applied`). Applied LAST so it wins over the
   * vendored hint AND the refresh hint — hint metadata only, never touching code/exit/retry.
   */
  hintOverride?: string;
}

/** Overrides a throw-site may supply for a CLI-local teachable error. */
export interface CliLocalOverrides {
  /** The specific `(detail)` on line 1 (e.g. "'nope' is not a field — available: …"). */
  detail?: string;
  /** A concrete hint overriding the registry default (still a runnable command). */
  hint?: string;
  /** RFC-9457-style passthrough extras (field, available_fields, remedies, path…). */
  extra?: Record<string, unknown>;
  /** The JSON `message` (defaults to detail, then the registry title). */
  message?: string;
}

/**
 * Build the teachable envelope for a CLI-local code (deliverable 3). Reads the
 * closed registry for {title, default hint, exit}; the throw site refines detail /
 * hint / extras. The result's `error` member always carries `title`, `exit_code`,
 * and a runnable `hint`.
 */
export function cliLocalErrorEnvelope(code: CliLocalCode, overrides: CliLocalOverrides = {}): ClassifiedError {
  const spec = CLI_LOCAL_REGISTRY[code];
  const hint = overrides.hint ?? spec.hint;
  // The caller's passthrough `extra` is spread FIRST; the trusted taxonomy fields
  // (title/hint/exit_code) are set LAST so a caller's extra can NEVER overwrite them.
  // This guarantees the single-source invariant: `error.exit_code` in the envelope
  // ALWAYS equals the returned `exitCode` (and the process exit), with no skew — even
  // if a future throw site echoes a server field that happens to be named `exit_code`.
  const extra: Record<string, unknown> = {
    ...(overrides.extra ?? {}),
    title: spec.title,
    hint,
    exit_code: spec.exitCode,
  };
  if (overrides.detail !== undefined) extra.detail = overrides.detail;
  const message = overrides.message ?? overrides.detail ?? spec.title;
  return { envelope: buildErrorEnvelope(code, message, extra), exitCode: spec.exitCode };
}

/** A valid `supported_major` extension value (string digits or a non-negative SAFE integer), or
 * null. Numeric values above 2^53 are REJECTED, not stringified: `String(1e21)` is exponential
 * notation ("1e+21") and `BigInt` on it THROWS — a hostile value must never crash the error
 * renderer. An arbitrary-size supported major stays representable via the digit-string form. */
function readSupportedMajor(problem: WireProblem): string | null {
  const raw = problem["supported_major"];
  if (typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  return null;
}

/**
 * The `version_unsupported`(400) → `version_skew` TRANSLATION (T-211, A30 + ticket-correction #2).
 * The server's version middleware rejects a mismatched major with the WIRE code
 * `version_unsupported`; the CLI's teachable code for that condition is the CLI-LOCAL
 * `version_skew` (T-207's closed set — no new code minted). The fence already translates when the
 * response CARRIES the advertised header; this is the defense-in-depth path for a response
 * WITHOUT one (e.g. a proxy stripped it): keyed on the wire code + the DOCUMENTED transport
 * status (400 — the code under any other status is not the ratified rejection shape and stays on
 * the untranslated wire path). Direction comes ONLY from a VALIDATED `supported_major` extension;
 * absent/malformed/equal → the default client-behind upgrade remedy with NO fabricated
 * direction or server version.
 */
function versionUnsupportedSkewEnvelope(problem: WireProblem): ClassifiedError {
  const pinned = MANAGEMENT_CONTRACT_VERSION;
  const pinnedMajor = pinned.split(".")[0] as string;
  const supported = readSupportedMajor(problem);
  const direction =
    supported !== null && BigInt(supported) !== BigInt(pinnedMajor)
      ? BigInt(supported) > BigInt(pinnedMajor)
        ? "client_behind"
        : "client_ahead"
      : null;

  const detail =
    direction === "client_behind"
      ? `this CLI targets management v${pinned} but the server only supports management major ${supported} (a newer MAJOR) — the CLI is out of date`
      : direction === "client_ahead"
        ? `this CLI targets management v${pinned} but the server only supports management major ${supported} (an older MAJOR) — the server predates this CLI`
        : `the server rejected this CLI's management version (v${pinned}) as unsupported`;
  const hint =
    direction === "client_ahead" ? clientAheadRemedy(pinnedMajor) : CLI_LOCAL_REGISTRY.version_skew.hint;

  const extra: Record<string, unknown> = { client_version: pinned };
  if (direction !== null) extra.direction = direction;
  if (supported !== null) extra.supported_major = supported;
  if (typeof problem.request_id === "string") extra.request_id = problem.request_id;
  return cliLocalErrorEnvelope("version_skew", { detail, hint, extra });
}

/**
 * Build the teachable envelope for a WIRE problem (deliverables 2 + 5). The server's
 * `title`/`detail`/`instance`/`type`/`request_id`/`status` pass through unchanged
 * (bytes over claims); the `code`, `exit_code`, `hint`, and `retry` come from the
 * vendored classification — never from trusting the wire's own `retry`. An unknown
 * code is already resolved to a generic terminal-2 disposition by the classifier.
 */
export function wireErrorEnvelope(problem: WireProblem, opts: WireErrorOptions = {}): ClassifiedError {
  // T-211 A30: the documented major-mismatch rejection renders as the teachable CLI-local
  // `version_skew`, even when no advertised-version header reached the fence.
  if (problem.code === "version_unsupported" && problem.status === 400) {
    return versionUnsupportedSkewEnvelope(problem);
  }
  const c = classifyWireProblem(problem);
  const title =
    typeof problem.title === "string" && problem.title.length > 0 ? problem.title : c.title;

  const extra: Record<string, unknown> = { title, exit_code: c.exitCode };
  if (typeof problem.detail === "string") extra.detail = problem.detail;
  if (typeof problem.type === "string") extra.type = problem.type;
  if (typeof problem.instance === "string") extra.instance = problem.instance;
  if (typeof problem.status === "number") extra.status = problem.status;
  if (typeof problem.request_id === "string") extra.request_id = problem.request_id;
  if (c.hint !== undefined) extra.hint = c.hint;
  // A14: a failed refresh's SOURCE-AWARE hint OVERRIDES the default `agkit login` — but ONLY on the
  // `refresh_auth` disposition (the 401 that actually attempted a refresh). An unrelated wire error
  // is never given the refresh hint. Applied AFTER `c.hint` so it wins; still just hint metadata.
  if (opts.refreshHint !== undefined && c.refresh) extra.hint = opts.refreshHint;
  // T-212 (S5a): a catch-site plan-code hint (the exact re-plan invocation) is applied LAST so it
  // wins over both the vendored and the refresh hint — the ceremony/apply site knows the precise
  // recovery command a plan_stale/plan_expired/plan_already_applied wants.
  if (opts.hintOverride !== undefined) extra.hint = opts.hintOverride;
  // T-212 (S5a, gated per F-G1): pass the server's `drifted` extension through verbatim (bytes
  // over claims) — but ONLY on the ratified shape: the `plan_stale` code under its documented 409
  // transport status, with an ARRAY value. Any other (code, status, type) combination is NOT the
  // ratified drift report and must not smuggle an arbitrary extension into the closed envelope.
  if (problem.code === "plan_stale" && problem.status === 409 && Array.isArray(problem.drifted)) {
    extra.drifted = problem.drifted;
  }
  if (c.retry !== null) extra.retry = c.retry; // the vendored disposition, not the wire's claim
  // Honest labeling (§B-9): when the server sent an UNKNOWN code, `c.code` is a fixed
  // generic label and the raw server code is preserved here for debuggability.
  if (c.serverCode !== undefined) extra.server_code = c.serverCode;

  const message =
    (typeof problem.detail === "string" && problem.detail.length > 0 && problem.detail) || title;
  return { envelope: buildErrorEnvelope(c.code, message, extra), exitCode: c.exitCode };
}

/** A contract request-id: a short opaque token. A server value that does not match is DROPPED (not
 * echoed) — it could otherwise carry file/user content through the allowlisted rebuild below. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The generic value-free detail when the caller supplies no per-command static string. */
const ALLOWLISTED_GENERIC_DETAIL = "the server rejected the request";

/** Options for the allowlisted rebuild — the general `WireErrorOptions` plus a caller-authored,
 * value-free static detail (a per-command constant; NEVER server/file content). */
export interface AllowlistedWireErrorOptions extends WireErrorOptions {
  readonly staticDetail?: string;
}

/**
 * Build a teachable envelope for a wire problem while DROPPING every server-controlled string
 * (B0 shared-core, sub-wave B). Unlike `wireErrorEnvelope` — which passes the server's
 * `title`/`detail`/`type`/`instance` and the raw unknown `server_code` through for debuggability —
 * this rebuild renders ONLY closed/validated fields, so a command that ROUND-TRIPS user or file
 * CONTENT to the server (agent `sync`, billing-config, media) can never have that content echoed
 * back through a 4xx problem body:
 *   - `code`       : the CLASSIFIED code (a vendored-table code or a fixed generic — closed set)
 *   - `title`      : the classifier's title (closed) — the server's `title` is DROPPED
 *   - `detail`     : the caller's static value-free string (or a generic) — the server's is DROPPED
 *   - `status`     : numeric only
 *   - `retry`      : the vendored RetryClass enum only (never the wire's claim)
 *   - `request_id` : ONLY if it matches the contract grammar+length; otherwise DROPPED
 * The raw `server_code`, `type`, `instance`, and all arbitrary extensions are DROPPED. Consumers
 * catch `WireProblemError` and render through this instead of the general renderer.
 */
export function allowlistedWireErrorEnvelope(
  problem: WireProblem,
  opts: AllowlistedWireErrorOptions = {},
): ClassifiedError {
  // Validate `request_id` ONCE, up front — a server value that fails the grammar is DROPPED. This must
  // happen BEFORE the version-skew delegation, whose builder copies `problem.request_id` UNVALIDATED
  // (problem.ts versionUnsupportedSkewEnvelope): a hostile request_id carrying file/secret content
  // would otherwise leak through the "allowlisted" envelope on the version_unsupported path.
  const safeRequestId =
    typeof problem.request_id === "string" && REQUEST_ID_RE.test(problem.request_id)
      ? problem.request_id
      : undefined;
  // The documented major-mismatch rejection stays teachable — its detail is CLI-authored from the
  // pinned version + a VALIDATED numeric supported_major (no server strings); the ONLY server field
  // it reads is request_id, which we sanitize here before delegation.
  if (problem.code === "version_unsupported" && problem.status === 400) {
    return versionUnsupportedSkewEnvelope({ ...problem, request_id: safeRequestId });
  }
  const c = classifyWireProblem(problem);
  const detail = opts.staticDetail ?? ALLOWLISTED_GENERIC_DETAIL;
  const extra: Record<string, unknown> = { title: c.title, exit_code: c.exitCode, detail };
  if (typeof problem.status === "number") extra.status = problem.status;
  if (safeRequestId !== undefined) {
    extra.request_id = safeRequestId;
  }
  // hint precedence mirrors wireErrorEnvelope: vendored → refresh-source-aware (only on refresh_auth)
  // → catch-site override. All three are CLI-authored/closed, never server content.
  let hint = c.hint;
  if (opts.refreshHint !== undefined && c.refresh) hint = opts.refreshHint;
  if (opts.hintOverride !== undefined) hint = opts.hintOverride;
  if (hint !== undefined) extra.hint = hint;
  if (c.retry !== null) extra.retry = c.retry;
  // DELIBERATELY OMITTED vs wireErrorEnvelope: problem.title/detail/type/instance and c.serverCode
  // (the raw unknown server code) — every one is a server-controlled string and would defeat the
  // whole point of this rebuild.
  return { envelope: buildErrorEnvelope(c.code, detail, extra), exitCode: c.exitCode };
}

/**
 * A carrier for an ALREADY-CLASSIFIED error (B0 shared-core, sub-wave B). A handler that must render
 * a wire problem through a NON-default path — the `allowlistedWireErrorEnvelope` scrub that drops
 * server strings for a content-round-tripping command (agent `sync`, billing-config, media) — builds
 * its `ClassifiedError` itself and throws it wrapped in this carrier. The thrown-error dispatcher
 * (`classifyThrownError`) passes the carried `{envelope, exitCode}` straight through instead of
 * re-classifying (which would route a `WireProblemError` back to the general, server-string-preserving
 * `wireErrorEnvelope`). Generic by design — the carrier holds any `ClassifiedError`.
 */
export class PreClassifiedError extends Error {
  override name = "PreClassifiedError";
  constructor(readonly classified: ClassifiedError) {
    super("agkit: pre-classified error");
  }
}

/**
 * Build the teachable envelope for a retry-EXHAUSTED transport/transient failure (T-211 — the
 * typed client's `RetryableTransportError`: a network error, a timeout, an unparseable 5xx, or a
 * gateway 429 that survived the retry budget). It is RETRYABLE (exit 1) — a script MAY re-run it,
 * unlike a determinate terminal fault — so it must NEVER collapse into the generic terminal-2
 * fallback (A2/A30: a headerless HTML 502 exhaustion is exit 1, never terminal-2). NO new code is
 * minted: it renders under the existing generic `server_error` label with the vendored
 * `retry: retry_with_backoff` disposition; the honest cause (network / timeout / server / rate
 * limited) rides in `message`/`detail`.
 */
export function retryableTransportEnvelope(
  message: string,
  opts: { status?: number | null } = {},
): ClassifiedError {
  // DEFINITIONALLY exit 1: "retryable" is what this envelope MEANS. No caller-supplied exit is
  // accepted — a name-duck-typed error carrying a bogus exitCode (0/2/3) must never make this
  // branch emit success or terminal (the dispatcher's branch invariant).
  const exitCode: ExitCode = EXIT.RETRYABLE;
  const extra: Record<string, unknown> = {
    title: "server unavailable",
    exit_code: exitCode,
    retry: "retry_with_backoff",
    detail: message,
  };
  if (typeof opts.status === "number") extra.status = opts.status;
  return { envelope: buildErrorEnvelope("server_error", message, extra), exitCode };
}
