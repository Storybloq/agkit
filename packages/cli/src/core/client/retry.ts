// The retry × refresh state machine (T-211 step 3b — A39 + A3 + A5 + A7 + A37). This is
// the most-reviewed logic in the ticket; the resend predicate is followed EXACTLY.
//
// Resend eligibility (A39, supersedes A28):
//   • 429                → ALWAYS auto-retryable on any route (the rate limiter rejects
//                          BEFORE execution — a resend re-executes nothing).
//   • network/timeout/5xx → auto-resend ONLY when idempotent-safe: method GET/HEAD OR
//                          the route is `idempotency:"required"`. A keyless mutation
//                          (idempotency:"none" mutation) failure is NOT resent — its
//                          disposition is retryable (exit 1), the caller may retry it
//                          manually (a tx admits post-commit 5xx paths — ambiguity
//                          forbids the resend).
//   • 4xx other than 429 → NEVER retried. Within the eligible set the wire table refines:
//                          a `retry:"none"` code (e.g. 501 not_implemented) → no retry;
//                          409 idempotency_in_flight is NOT auto-retried despite its
//                          `retry_with_backoff` table value (A3 — the value still drives
//                          its exit disposition through the landed classifier).
//
// Budget: backoff-retries ≤ `retries` (default 2, 0 disables); the refresh counter is
// INDEPENDENT (cap 1) and a refresh does NOT reset the retry budget. Total management
// sends ≤ (1 + retries) + 1 refresh-triggered resend (A37).
//
// Backoff (A7): delay = random() * base * 2^attempt (full jitter), base = 1.0s
// (management-errors.json meta.default_backoff_seconds — errors.json:7). A numeric
// `Retry-After` (429 only, delta-seconds) OVERRIDES the computed delay; non-numeric /
// HTTP-date is malformed → computed. All delays are clamped to 60s (RULES: bound every
// wait). Injected `sleep` + `random` seams — no real waits.
//
// Refresh seam (A5 — the STATE MACHINE is here; the executor landed in step 6, refresh.ts): on a
// `refresh_auth`-disposition outcome (401 token_expired) we call `refreshAuth` ONCE per
// logical request, swap ONLY the bearer token on the SAME immutable request, and resend
// once (no backoff). Absent/null seam → terminal (the landed classifier renders exit 2 +
// the `agkit login` hint).
import { EXIT, classifyWireProblem, type ExitCode } from "../errors";
import type { RouteEntry } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import { RequestPreparationError, type PreparedRequest } from "./prepare";
import type { ClassifiedOutcome } from "./classify";
import { TransportError } from "./transport";

/** Default backoff-retry budget (ticket deliverable 3). */
export const DEFAULT_RETRIES = 2;
/** Full-jitter base (management-errors.json meta.default_backoff_seconds — errors.json:7). */
export const DEFAULT_BACKOFF_SECONDS = 1.0;
/** Hard ceiling on any single wait — clamps a hostile Retry-After AND a high-attempt computed delay. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * A retry-exhausted (or keyless-refused) transport/transient failure with NO wire code —
 * a network error, a timeout, or a non-parseable 5xx. Retryable disposition (exit 1); the
 * dispatcher renders it as a retryable error at run.ts-wiring time (step 5/7).
 */
export class RetryableTransportError extends Error {
  override name = "RetryableTransportError";
  readonly exitCode: ExitCode = EXIT.RETRYABLE;
  constructor(
    readonly cause: "network" | "timeout" | "server" | "rate_limited",
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Injected timing / entropy / refresh seams (no real waits or network in tests). */
export interface RetryDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /**
   * Refresh executor (step 6). Receives the bearer that OBSERVED the 401 (the stale token), so a
   * client-level wrapper can single-flight concurrent refreshes and skip entirely when another
   * request already rotated past it (re-review R4). Returns the token to resend under, or null
   * when refresh is impossible.
   */
  readonly refreshAuth?: (staleToken: string) => Promise<string | null>;
}

export interface RetryParams {
  /** One send of the immutable request under `token`; returns a classified outcome or throws TransportError. */
  readonly send: (token: string) => Promise<ClassifiedOutcome>;
  readonly token: string;
  /**
   * The immutable prepared request (finding 8). The engine DERIVES its safety facts from ground
   * truth — `method` from `request.method`, never a caller-passed boolean that could disagree with
   * the bytes actually on the wire.
   */
  readonly request: PreparedRequest;
  /** The frozen route-registry entry (finding 8) — `idempotency` is read here, never trusted from a param. */
  readonly route: RouteEntry;
  readonly retries: number;
  readonly deps: RetryDeps;
}

export interface SettledResult {
  readonly value: unknown;
  readonly replayed: boolean;
  readonly advertisedVersion: string | null;
}

/** Parse a `Retry-After` header as numeric delta-seconds; null when absent/malformed (HTTP-date, junk). */
function parseRetryAfterSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // HTTP-date or non-numeric → malformed → computed backoff
  return Number(trimmed);
}

export async function executeWithRetry(params: RetryParams): Promise<SettledResult> {
  const { send, retries, deps } = params;

  // ── request↔route binding (re-review R3, completes finding 8): the engine's safety facts come
  //    from TWO inputs — the immutable request (method) and the route entry (idempotency). A
  //    mispairing (request A handed route B) could grade an unsafe resend as safe — e.g. a keyless
  //    mutation paired with an idempotency:"required" route would be resent on a 5xx. prepare.ts
  //    stamped `operationId` after validating spec↔route equality, so identity AND method must
  //    both agree here; a mismatch is a NON-retryable internal pairing bug — fail loud, before
  //    any send. (The dual-verb "GET+POST" can never reach here: prepare rejects that row, so a
  //    route carrying it simply fails this method equality like any other mismatch.)
  // Compare methods through a string-typed local: a direct `request.method !== route.method`
  // would NARROW request.method by intersection with RouteMethod (which has no "HEAD"), breaking
  // the HEAD arm of the idempotent-safe predicate below.
  const requestMethod: string = params.request.method;
  if (params.request.operationId !== params.route.operation_id || requestMethod !== params.route.method) {
    throw new RequestPreparationError(
      `request/route mismatch: prepared request "${params.request.operationId}" (${params.request.method}) was paired with the route entry for "${params.route.operation_id}" (${params.route.method})`,
      "this is an internal pairing bug — executeWithRetry must receive a request with its own route entry",
    );
  }

  // Derive the safety facts from ground truth, not from trusted booleans (finding 8): the method
  // is whatever the immutable request actually carries; idempotency-required is the route's own
  // column. Idempotent-safe = the failure can be resent without risking a double-execution (A39).
  const method = params.request.method;
  const idempotencyRequired = params.route.idempotency === "required";
  const idempotentSafe = method === "GET" || method === "HEAD" || idempotencyRequired;

  let token = params.token;
  let backoffUsed = 0;
  let refreshUsed = 0;
  let attempt = 0; // number of backoffs performed so far — drives 2^attempt

  /** Compute + await one backoff. `retryAfter` (429 only) overrides the computed delay. */
  const doBackoff = async (retryAfter: string | null): Promise<void> => {
    let delayMs = deps.random() * DEFAULT_BACKOFF_SECONDS * 1000 * 2 ** attempt;
    const ra = parseRetryAfterSeconds(retryAfter);
    if (ra !== null) delayMs = ra * 1000;
    await deps.sleep(Math.min(delayMs, MAX_BACKOFF_MS));
    backoffUsed += 1;
    attempt += 1;
  };

  const canBackoff = (): boolean => backoffUsed < retries;

  for (;;) {
    let outcome: ClassifiedOutcome;
    try {
      outcome = await send(token);
    } catch (err) {
      if (err instanceof TransportError) {
        // network / timeout — retryable-class, but resend ONLY if idempotent-safe (A39).
        if (idempotentSafe && canBackoff()) {
          await doBackoff(null); // no Retry-After on a transport failure
          continue;
        }
        throw new RetryableTransportError(err.kind, null, err.message);
      }
      throw err; // a non-transport throw is a programming error — propagate
    }

    if (outcome.kind === "success") {
      return { value: outcome.value, replayed: outcome.replayed, advertisedVersion: outcome.advertisedVersion };
    }
    if (outcome.kind === "empty") {
      return { value: undefined, replayed: outcome.replayed, advertisedVersion: outcome.advertisedVersion };
    }
    // outcome is now `wire | transient | terminal` — each carries `status` + `retryAfter`; the
    // decision keys on the ACTUAL HTTP status (A2/A30/A39), not on body parseability.

    // (1) 429 — ALWAYS auto-retryable on ANY route (A39), even when the body did not parse as a
    //     problem+json (a gateway/CDN 429). Retry-After (429-only) overrides the computed delay.
    if (outcome.status === 429) {
      if (canBackoff()) {
        await doBackoff(outcome.retryAfter);
        continue;
      }
      // Exhausted → ALWAYS exit 1 (finding 10): rate limiting is inherently retryable, so an
      // exhausted 429 must NEVER collapse to a terminal exit 2 just because the body happened to
      // claim a terminal code (or an unknown one). Throw the wire error ONLY when its OWN
      // classification is already exit-1 (rate_limited); for any other body — unknown/terminal
      // code, or a non-parseable gateway 429 — raise a rate_limited RetryableTransportError,
      // keeping the server's code as a diagnostic.
      if (outcome.kind === "wire" && classifyWireProblem(outcome.error.problem).exitCode === EXIT.RETRYABLE) {
        throw outcome.error;
      }
      // The claimed code is diagnostic ONLY and may be ANY JSON value (re-review R7): a parsed
      // body's `code` could be an object/array/number — interpolate it only when it is a string.
      const code = outcome.kind === "wire" ? outcome.error.problem.code : undefined;
      const diag = typeof code === "string" ? ` (server code: ${code})` : "";
      throw new RetryableTransportError("rate_limited", 429, `rate limited (HTTP 429); retries exhausted${diag}`);
    }

    // (2) refresh_auth — GATED on a genuine 401 (finding 9): only a real HTTP 401 whose classified
    //     problem asks for a refresh triggers one. A body that merely CLAIMS `token_expired` under
    //     a 400/429/5xx transport status does NOT — the transport status is authoritative (A2),
    //     so those flow to the 429 / 5xx / terminal branches instead of burning the refresh.
    if (outcome.status === 401 && outcome.kind === "wire" && outcome.classification.refresh) {
      if (refreshUsed < 1 && deps.refreshAuth) {
        refreshUsed += 1;
        // Pass the bearer that OBSERVED this 401 (re-review R4): the client-level wrapper uses it
        // to skip a refresh when another request already rotated past it, and to single-flight
        // concurrent refreshes under the same stale token.
        const next = await deps.refreshAuth(token);
        if (next !== null) {
          token = next; // swap ONLY the bearer — the request bytes are unchanged (A37)
          continue; // resend immediately (no backoff)
        }
      }
      throw outcome.error; // no seam / already refreshed / null → terminal (exit 2 + agkit login)
    }

    // (3) retryable-class 5xx: eligibility keys on the STATUS CLASS (A2/A3/A30 — retry keys on the
    //     transport status, not the body's claimed code), and the table only REFINES it downward.
    //     A non-parseable 5xx (transient) OR a wire 5xx is retryable UNLESS its KNOWN code says
    //     `retry:"none"` (501 not_implemented) — that single refinement excludes it and falls
    //     through to (4). Unknown 5xx codes (retry === null) and a 5xx body claiming an auth code
    //     (e.g. token_expired under a 503) stay retryable-by-status, never a refresh.
    const retryable5xx =
      outcome.status >= 500 &&
      (outcome.kind === "transient" ||
        (outcome.kind === "wire" && outcome.classification.retry !== "none"));
    if (retryable5xx) {
      // resend ONLY when idempotent-safe (A39); a keyless mutation failure is not resent.
      if (idempotentSafe && canBackoff()) {
        await doBackoff(null);
        continue;
      }
      if (outcome.kind === "wire") throw outcome.error; // exit 1 (retry_with_backoff)
      throw new RetryableTransportError("server", outcome.status, `server error (HTTP ${outcome.status})`);
    }

    // (4) terminal — no retry. A `transient` is always ≥500 (handled in (3)); the remainder is a
    //     wire retry:"none" / non-429 4xx problem, or a generic terminal — the landed classifier
    //     drives the exit disposition (retry:"none" → 2; 409 idempotency_in_flight
    //     retry_with_backoff → 1 but NOT resent, A3).
    if (outcome.kind === "transient") {
      throw new RetryableTransportError("server", outcome.status, `server error (HTTP ${outcome.status})`);
    }
    throw outcome.error;
  }
}
