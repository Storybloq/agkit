// The version-skew FENCE (T-211 step 5 — A2 / A11 / A13 / A30 / A31 + risk-register #4).
//
// It is NOT a new pipeline layer: it is a `ResponseMetaSink` composed onto the landed
// `onResponseMeta` channel (index.ts). That channel is AWAITED inside `send()` BEFORE the
// retry engine makes any resend decision, and a throw from it PROPAGATES — which is exactly
// how a MAJOR-skew fence preempts a retry: it throws the CLI-local `version_skew` (exit 2)
// through the sink and the request rejects on the FIRST response (`calls.length === 1`).
//
// Reading discipline (A2 — bytes over claims): the fence acts ONLY on the server's ADVERTISED
// `X-AgentKit-Management-Version` — the value transport read off the response — and ONLY when it
// is a strict full semver. It is the server's advertised version, NOT an echo of what we sent
// (absent header ⇒ the server treats us as current-major, so we must NOT invent skew from a
// missing header). The value is compared to the BUILD-TIME PIN (`MANAGEMENT_CONTRACT_VERSION`).
//
// Response-class tolerance (A30): retry keys on the transport STATUS, never body parseability.
//   • retryable-class (5xx or 429)                → the retry engine's business; the fence NEVER
//     converts one into `version_skew` or a warning. A headerless HTML 502 stays retryable and
//     exits 1 on exhaustion — never terminal-2 (the A2 acceptance twin).
//   • a SETTLED management 2xx / terminal 4xx      → the fence evaluates:
//       - MAJOR mismatch (either direction)  → `version_skew` (throw mode) / recorded (report mode);
//       - same major, server minor > pinned  → one stderr NOTICE, still exit 0;
//       - no/malformed advertised header     → one stderr WARNING + verdict "unknown" (observable,
//         never silent — §B-9 label-by-reality); proceed.
//
// Fence MODE per client (A11/A31): "throw" for every remote command (a major skew is terminal);
// "report" for `status` (and the step-6 refresh executor) — status is the instrument that
// MEASURES skew (T-208 deliverable 5) and cannot be killed by it, so its fence records rather
// than throws and it reports the verdict as DATA at exit 0.
import type { ResponseMetaSink } from "./index";
import { CliLocalError, CLI_LOCAL_REGISTRY } from "../errors";
import { clientAheadRemedy } from "../errors/skew-remedy";
import { MANAGEMENT_CONTRACT_VERSION } from "../../contract";

/** Strict full-semver — the fence evaluates ONLY a header matching this (A2). Captures major+minor.
 * Each component is `0 | [1-9]\d*` (semver's numeric-identifier rule): a leading-zero form like
 * `02.0.0` is NOT semver, and a lax `\d+` read of it would INVENT a major skew where A2 demands
 * abstention — malformed must always land on "unknown". */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The skew verdict for a settled response (what `status` reports; what the fence keys on). */
export type SkewVerdict = "match" | "minor_behind" | "skew" | "unknown";

/** Which side is behind on a MAJOR mismatch — drives the direction-aware remedy (A13). */
export type SkewDirection = "client_behind" | "client_ahead";

export interface SkewEvaluation {
  readonly verdict: SkewVerdict;
  /** Present only for `verdict === "skew"`. */
  readonly direction?: SkewDirection;
}

/**
 * REPORT-mode observability state (A11): a fence may record the last settled verdict + server
 * version here for a caller (the step-6 refresh executor) that wants the skew as data without a
 * throw. `status` computes its own verdict from the discovery body (it needs the exact server
 * version, which a header cannot carry through the typed `request()` return), so it does not
 * depend on this — it exists so the "report" channel is complete, not as `status`'s only source.
 */
export interface VersionFenceState {
  serverVersion: string | null;
  verdict: SkewVerdict;
}

/**
 * Pure skew evaluation: compare the pinned client version to the server's ADVERTISED version.
 * Absent OR non-strict-semver advertised (or a non-semver pin, impossible with the build pin) ⇒
 * "unknown" (the fence SKIPS — A2). Same major + server minor strictly greater ⇒ "minor_behind".
 * Any major difference ⇒ "skew" with the direction (server major higher ⇒ client is behind).
 */
export function evaluateSkew(pinned: string, advertised: string | null): SkewEvaluation {
  if (advertised === null) return { verdict: "unknown" };
  const s = STRICT_SEMVER.exec(advertised);
  const p = STRICT_SEMVER.exec(pinned);
  if (s === null || p === null) return { verdict: "unknown" };
  // BigInt, not Number: components are arbitrary-length digit strings, and a float compare
  // collapses distinct values past 2^53 (Number("…993") === Number("…992")) — a phantom match.
  const sMaj = BigInt(s[1] as string);
  const sMin = BigInt(s[2] as string);
  const pMaj = BigInt(p[1] as string);
  const pMin = BigInt(p[2] as string);
  if (sMaj !== pMaj) {
    return { verdict: "skew", direction: sMaj > pMaj ? "client_behind" : "client_ahead" };
  }
  if (sMin > pMin) return { verdict: "minor_behind" };
  return { verdict: "match" };
}

/**
 * The 2xx-trip ADDENDUM (T-227 S4.1, adversarial cell). A fence trip on a SETTLED SUCCESS is a
 * DIFFERENT fact from a trip on a terminal 4xx: the server ACCEPTED and answered the request
 * before the skew was noticed, so — for a mutation — the operation may already have EXECUTED
 * server-side. The refusal must therefore say two things a plain skew refusal must not: the
 * outcome is UNKNOWN (not "failed"), and a blind retry is forbidden — a second send of a write is
 * a SECOND write, not a retry of the first. A completed-but-unacknowledgeable operation is
 * RE-READ, never re-sent. A static literal (no interpolation): the MCP sweep pins these exact
 * bytes, and nothing attacker-controlled can ride in them.
 */
export const SKEW_SUCCESS_OUTCOME_UNKNOWN =
  "the response was a SUCCESS (2xx), so the server may have EXECUTED this operation before the skew was noticed — the outcome is UNKNOWN to this client; do NOT retry blindly (for a write, a blind retry is a second write): re-read the resource to learn how the operation settled, then resolve the version skew";

/**
 * Build the terminal `version_skew` error with a DIRECTION-AWARE remedy (A13). No new code is
 * minted — `version_skew` is L2-CLI-04's closed-set code; only the teachable hint differs:
 *   • client-behind (server major higher) → upgrade the CLI (the registry default hint);
 *   • client-ahead  (server major lower)  → point at a server on the CLI's major, or pin an
 *     older CLI release. The exact versions ride in `extra` for a machine consumer.
 *
 * `settledSuccess` (T-227 S4.1): the fence tripped on a 2xx — the detail gains the
 * outcome-unknown addendum above and `extra.outcome:"unknown"` rides for machine consumers.
 * `advertised` is safe to echo: the fence only reaches a skew verdict AFTER the value matched
 * `STRICT_SEMVER`, so the interpolation is digits-and-dots, never unbounded attacker bytes.
 */
export function versionSkewError(
  pinned: string,
  advertised: string,
  direction: SkewDirection,
  opts: { readonly settledSuccess?: boolean } = {},
): CliLocalError {
  const pinnedMajor = pinned.split(".")[0];
  const behind = direction === "client_behind";
  const base = behind
    ? `this CLI targets management v${pinned} but the server advertises v${advertised} (a newer MAJOR) — the CLI is out of date`
    : `this CLI targets management v${pinned} but the server advertises v${advertised} (an older MAJOR) — the server predates this CLI`;
  const detail = opts.settledSuccess === true ? `${base}. ${SKEW_SUCCESS_OUTCOME_UNKNOWN}` : base;
  const hint = behind
    ? CLI_LOCAL_REGISTRY.version_skew.hint // "npm install -g @shyegg/agkit@latest"
    : clientAheadRemedy(pinnedMajor as string);
  return new CliLocalError("version_skew", {
    detail,
    hint,
    extra: {
      client_version: pinned,
      server_version: advertised,
      direction,
      ...(opts.settledSuccess === true ? { outcome: "unknown" } : {}),
    },
  });
}

export interface VersionFenceOptions {
  /** "throw" (every remote command) preempts the resend by throwing `version_skew`; "report"
   * (status / refresh) records the verdict and NEVER throws (A11/A31). */
  readonly mode: "throw" | "report";
  /** Best-effort stderr sink for the once-per-invocation minor-notice / unknown-warning. */
  readonly warn: (message: string) => void;
  /** The pinned client version to compare against; defaults to the BUILD-TIME pin (no literal). */
  readonly pinned?: string;
  /** Optional REPORT-mode observability sink (A11). */
  readonly state?: VersionFenceState;
}

/**
 * Compose the fence as a `ResponseMetaSink`. It is invoked for EVERY classified response
 * (successes and errors, and every retry attempt), so its own once-guard keeps the minor-notice
 * and the unknown-header warning to a single stderr line per invocation (not per retry).
 */
export function createVersionFence(opts: VersionFenceOptions): ResponseMetaSink {
  const pinned = opts.pinned ?? MANAGEMENT_CONTRACT_VERSION;
  let announced = false;
  const announceOnce = (message: string): void => {
    if (announced) return;
    announced = true;
    opts.warn(message);
  };

  return (meta) => {
    const { status, advertisedVersion } = meta;
    // T-222 6a (C2): a PER-REQUEST fence mode overrides the client-wide default. A report-mode
    // `selftest` client forces "throw" on its authenticated/mutating checks so a skew first seen
    // at one of THOSE responses preempts the write; absent ⇒ the client-wide `opts.mode`.
    const effectiveMode = meta.fence ?? opts.mode;
    // A2/A30: a retryable-class response is settled by the RETRY ENGINE, never the fence — a 5xx
    // (incl. a headerless gateway 502) or a 429 must be able to retry-then-succeed, so the fence
    // ignores it entirely and lets the engine drive it (exit 1 only on exhaustion).
    const retryableClass = status >= 500 || status === 429;

    const { verdict, direction } = evaluateSkew(pinned, advertisedVersion);

    // REPORT-mode observability: record only for a SETTLED response (a retryable intermediate
    // must not clobber a later known verdict).
    if (opts.state && !retryableClass) {
      opts.state.verdict = verdict;
      opts.state.serverVersion = verdict === "unknown" ? null : advertisedVersion;
    }

    if (retryableClass) return;

    switch (verdict) {
      case "skew":
        // MAJOR mismatch — terminal. Throw ONLY in "throw" mode (report/status records + exits 0).
        if (effectiveMode === "throw") {
          // A trip on a settled 2xx carries the outcome-unknown addendum (T-227 S4.1): the server
          // ANSWERED before the skew was noticed, so the operation may have executed — the refusal
          // must forbid a blind retry and demand a re-read instead.
          throw versionSkewError(pinned, advertisedVersion as string, direction as SkewDirection, {
            settledSuccess: status >= 200 && status < 300,
          });
        }
        return;
      case "minor_behind":
        announceOnce(
          `agkit: notice — the server speaks a newer management minor (v${advertisedVersion}); this CLI targets v${pinned}. Consider updating: ${CLI_LOCAL_REGISTRY.version_skew.hint}\n`,
        );
        return;
      case "unknown":
        // A30 case ii: a settled 2xx / terminal-4xx with no parseable advertised version — proceed
        // but SAY so (never silent). Reserved capability-gated commands still fail closed elsewhere.
        announceOnce(
          `agkit: warning — the server did not advertise a parseable management version; version-skew is unknown\n`,
        );
        return;
      case "match":
      default:
        return;
    }
  };
}
