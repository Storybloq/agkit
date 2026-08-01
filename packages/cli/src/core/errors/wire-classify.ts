// Wire-error classifier (T-207, canonical L2-CLI-04, deliverables 2 + 5). Turns an
// RFC 9457 problem+json the server sent into a disposition: an exit code, a
// refresh-intent signal, and a status class. Two rules govern it:
//
//   Deliverable 2 — wire → exit is DETERMINISTIC from the vendored `retry` column:
//     retry_with_backoff → 1 (retryable)
//     refresh_auth       → attempt ONE silent token refresh, THEN one retry; still
//                          failing → 2 with `hint: agkit login`
//     none               → 2 (terminal)
//   Deliverable 5 — an UNKNOWN code (not in the vendored table) → a generic
//     terminal-2 error keyed on the HTTP status class. NEVER crash on it; NEVER
//     string-match the human prose to branch (Postel consumer split — key on the
//     `code`/`status` bytes, not the `detail` sentence).
//
// This classifier owns only the DISPOSITION (exit code + refresh-intent signal + status
// class); it never executes a refresh. The ACTUAL refresh EXECUTOR landed in T-211 step 6
// (`core/client/refresh.ts` — `createRefreshExecutor`), driven by the retry state machine
// off the `refresh` signal below. When that executor resolves `null` (no refresh path or the
// server refused the grant), THIS classification (exit 2 + `hint`) is the terminal outcome.
import { EXIT, type ExitCode } from "./exit-codes";
import { CLI_LOCAL_REGISTRY } from "./cli-codes";
import { WIRE_ERROR_TABLE, isWireCode, type RetryClass } from "./wire-table";

/** The RFC 9457 problem shape the management plane emits (ratified members + code). */
export interface WireProblem {
  /** RFC 9457 members. */
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  /** Extension members ratified by the management contract. */
  code?: string;
  request_id?: string;
  retry?: string;
  [key: string]: unknown;
}

/**
 * A thrown wire error carrying its problem document. The typed client (T-211) will
 * throw this on a non-2xx management response; the shell's dispatcher (classify.ts)
 * routes it through `classifyWireProblem`. Defined now so the seam exists and is
 * unit-tested with fixtures; T-211 wires the throw site.
 */
export class WireProblemError extends Error {
  override name = "WireProblemError";
  /**
   * T-212 (S5a mechanism; S8 sets it): an EXACT recovery command a catch site knows better than the
   * vendored default — e.g. the plan/apply ceremony catching a `plan_stale` / `plan_expired` /
   * `plan_already_applied` and decorating it with the precise re-plan invocation. The dispatcher
   * (classify.ts) threads it into `wireErrorEnvelope`, where it OVERRIDES the vendored hint. Hint
   * METADATA only — it never changes the code, exit, or retry disposition (still the vendored bytes).
   */
  hintOverride?: string;
  constructor(readonly problem: WireProblem) {
    super(problem.detail ?? problem.title ?? problem.code ?? "management request failed");
  }
}

export type StatusClass = "client_error" | "server_error" | "unknown";

const STATUS_CLASS_TITLE: Record<StatusClass, string> = {
  client_error: "request rejected",
  server_error: "server error",
  unknown: "unexpected error",
};

/**
 * The CLOSED generic-fallback code set for an UNKNOWN / absent wire code (deliverable
 * 5). An unknown code maps to ONE of these — keyed ONLY by the HTTP status class — so
 * `error.code` stays an ENUMERABLE closed set a consumer can branch on, never an open
 * passthrough of an arbitrary server string (which would defeat the closed-set
 * guarantee). The server's RAW unknown code is preserved separately (`serverCode` →
 * envelope `server_code`) for honest labeling (§B-9), but it is NOT the branchable code.
 */
const STATUS_CLASS_CODE: Record<StatusClass, string> = {
  client_error: "request_rejected",
  server_error: "server_error",
  unknown: "unexpected_error",
};

/** The disposition of a classified wire problem. */
export interface WireClassification {
  /**
   * The branchable code. For a KNOWN code, the vendored code verbatim. For an
   * UNKNOWN / absent code, a FIXED generic label from the closed `STATUS_CLASS_CODE`
   * set (never the raw server string — see `serverCode`).
   */
  code: string;
  /**
   * The server's RAW code when it sent an UNKNOWN one (undefined for a known code or
   * when the server sent no code). Preserved for honest labeling (§B-9) and surfaced
   * as the envelope's `server_code`, but is NEVER the branchable `code`.
   */
  serverCode?: string;
  /** Was `code` in the vendored table? (false → the generic, unknown-code path). */
  known: boolean;
  /** The vendored retry class (null for an unknown code). */
  retry: RetryClass | null;
  /**
   * refresh_auth signal: attempt exactly ONE silent token refresh then ONE retry. The
   * executor (`core/client/refresh.ts`) performs it at the retry-engine seam; if it resolves
   * `null` (no refresh path / the grant was refused), THIS classification (exit 2 + `hint`)
   * is the terminal outcome.
   */
  refresh: boolean;
  /** Exit code for the terminal outcome — 1 (retryable) or 2 (terminal). */
  exitCode: ExitCode;
  /** `agkit login` for refresh_auth (still-failing); otherwise undefined. */
  hint?: string;
  /** Status class the disposition (and the generic title) is keyed on. */
  statusClass: StatusClass;
  /** Human title for a known code (server `title` overrides it in the envelope builder). */
  title: string;
}

/** retry column → exit disposition (deliverable 2). The one place the mapping lives. */
function retryDisposition(retry: RetryClass): { exitCode: ExitCode; refresh: boolean; hint?: string } {
  switch (retry) {
    case "retry_with_backoff":
      return { exitCode: EXIT.RETRYABLE, refresh: false };
    case "refresh_auth":
      // One silent refresh + retry (executed by core/client/refresh.ts); still-failing →
      // terminal-2 + login hint (a source-aware hint may override it at the shell — A14).
      return { exitCode: EXIT.TERMINAL, refresh: true, hint: CLI_LOCAL_REGISTRY.not_logged_in.hint };
    case "none":
      return { exitCode: EXIT.TERMINAL, refresh: false };
  }
}

function statusClassOf(status: number | undefined): StatusClass {
  if (status === undefined) return "unknown";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unknown";
}

/** `rate_limited` → "rate limited". A friendly default title for a known code. */
function humanizeCode(code: string): string {
  return code.replace(/_/g, " ");
}

/**
 * Classify a wire problem into its disposition. Keys on `code` (known → vendored
 * retry→exit) and falls back to a generic terminal-2 keyed on the HTTP status class
 * for an unknown/absent code. Pure; never throws; never inspects `detail` prose.
 */
export function classifyWireProblem(problem: WireProblem): WireClassification {
  const rawCode = typeof problem.code === "string" ? problem.code : undefined;
  const status = typeof problem.status === "number" ? problem.status : undefined;

  if (rawCode !== undefined && isWireCode(rawCode)) {
    const spec = WIRE_ERROR_TABLE[rawCode] as { http: number; retry: RetryClass };
    const disp = retryDisposition(spec.retry);
    return {
      code: rawCode,
      known: true,
      retry: spec.retry,
      refresh: disp.refresh,
      exitCode: disp.exitCode,
      hint: disp.hint,
      statusClass: statusClassOf(spec.http),
      title: humanizeCode(rawCode),
    };
  }

  // Unknown / absent code — Postel consumer split. Generic terminal-2 keyed on the
  // HTTP status class. `code` is a FIXED generic label (closed set), NOT the raw
  // server string — so a consumer branching on `code` sees only the closed set. The
  // server's raw code (if any) rides along as `serverCode` for honest labeling.
  const cls = statusClassOf(status);
  return {
    code: STATUS_CLASS_CODE[cls],
    serverCode: rawCode,
    known: false,
    retry: null,
    refresh: false,
    exitCode: EXIT.TERMINAL,
    hint: undefined,
    statusClass: cls,
    title: STATUS_CLASS_TITLE[cls],
  };
}
