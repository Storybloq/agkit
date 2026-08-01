// Bytes-first response classification (T-211 step 3a, A22). Turns one raw
// `TransportResult` into a typed outcome the retry engine acts on — WITHOUT trusting
// the Content-Type. On any ≥400 body we attempt a problem+json parse regardless of
// charset params / a wrong or missing type (§B-9 trust order: bytes > Content-Type >
// request); a parseable problem is wrapped in the landed `WireProblemError` so its wire
// code flows through the existing `classifyWireProblem` disposition machinery. A
// non-parseable body classifies by STATUS CLASS (A2/A30 — retry keys on transport
// status, not body parseability): 5xx → a retryable `transient` outcome; 4xx → a
// generic terminal (T-207's unknown-code rule, via a synthetic status-only problem).
// 204/205 → typed empty success; a malformed 2xx JSON body → a typed terminal error,
// NEVER a crash. `Idempotency-Replayed: true` and the raw `Retry-After` ride through as
// meta for the retry engine and the later replay/warning surface.
import { classifyWireProblem, WireProblemError, type WireClassification, type WireProblem } from "../errors";
import type { TransportResult } from "./transport";
import { measureJsonStructure } from "./json-bounds";
import { MAX_JSON_DEPTH, MAX_RESPONSE_JSON_NODE_COUNT } from "./limits";

/** Meta carried on every outcome (independent of the outcome kind). */
export interface OutcomeMeta {
  /** Server replayed a stored idempotent response (`Idempotency-Replayed: true`). */
  readonly replayed: boolean;
  /** The server's advertised management version header, raw (step 5's fence reads this). */
  readonly advertisedVersion: string | null;
  /** The raw `Retry-After` header (retry.ts parses/clamps it — 429 only). */
  readonly retryAfter: string | null;
}

/**
 * A classified single-send outcome. `wire`/`terminal` both carry a `WireProblemError`
 * so the dispatcher renders them uniformly; `transient` is a non-parseable 5xx (no wire
 * code) the retry engine treats as retryable-class.
 */
export type ClassifiedOutcome =
  | ({ kind: "success"; value: unknown } & OutcomeMeta)
  | ({ kind: "empty" } & OutcomeMeta)
  | ({ kind: "wire"; error: WireProblemError; classification: WireClassification; status: number } & OutcomeMeta)
  | ({ kind: "transient"; status: number } & OutcomeMeta)
  | ({ kind: "terminal"; error: WireProblemError; status: number; nonJson?: boolean } & OutcomeMeta);

/** Parse `text` as a JSON OBJECT, or null when it is not parseable / not an object. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function classifyResponse(result: TransportResult): ClassifiedOutcome {
  const meta: OutcomeMeta = {
    replayed: result.headers.get("Idempotency-Replayed") === "true",
    advertisedVersion: result.advertisedVersion,
    retryAfter: result.headers.get("Retry-After"),
  };
  const status = result.status;

  // 204 No Content / 205 Reset Content — a typed empty success (never parse a body).
  if (status === 204 || status === 205) {
    return { kind: "empty", ...meta };
  }

  // T-222 step 10b (B6/C2): an over-cap response was NEVER fully read — its `bodyText` is
  // partial/empty and MUST NOT be parsed. Admit it by STATUS CLASS before any parse: a ≥500 is a
  // retryable transient (a bounded re-download may land under the cap), everything else is a typed
  // terminal (a truncated success/4xx is not recoverable by resending). Static message, no body byte.
  if (result.bodyTruncated === true) {
    if (status >= 500) {
      return { kind: "transient", status, ...meta };
    }
    const error = new WireProblemError({
      status,
      detail: "the server response exceeded the client's maximum response size and was not read",
    });
    return { kind: "terminal", error, status, ...meta };
  }

  if (status >= 400) {
    const problemObj = parseJsonObject(result.bodyText);
    if (problemObj !== null) {
      // C2 structural admission: a pathologically DEEP problem body would overflow the native
      // recursive `JSON.stringify` (serialize.ts), and a flat-but-HUGE one would OOM the iterative
      // redaction walker — both sinks the WireProblemError flows into (→ envelope, incl. the 409
      // `drifted` passthrough). Reject either as a typed terminal BEFORE it reaches them. Static
      // message (never a body byte).
      const overCap = structuralOverCap(problemObj);
      if (overCap !== null) {
        const error = new WireProblemError({ status, detail: overCap });
        return { kind: "terminal", error, status, ...meta };
      }
      // Bytes-first: a parseable object IS the problem doc (any Content-Type). The TRANSPORT
      // status is authoritative (finding 7 / A2 / risk register #4): retry keys on the real HTTP
      // status, never a status the body claims. When the body claimed a DIFFERENT numeric status,
      // preserve it as `claimed_status` (WireProblem has an index signature) for diagnostics
      // BEFORE overwriting — then always stamp the transport status.
      const problem: WireProblem = { ...problemObj };
      if (typeof problem.status === "number" && problem.status !== status) {
        problem.claimed_status = problem.status;
      }
      problem.status = status;
      const error = new WireProblemError(problem);
      return { kind: "wire", error, classification: classifyWireProblem(problem), status, ...meta };
    }
    // Non-parseable body → classify by status class (A2/A30).
    if (status >= 500) {
      return { kind: "transient", status, ...meta };
    }
    // 4xx with no parseable problem → generic terminal (T-207 unknown-code rule).
    const error = new WireProblemError({ status });
    return { kind: "terminal", error, status, ...meta };
  }

  // 2xx-ONLY success (finding 6): a management success is exactly a 2xx. 204/205 were handled
  // above; any other 200–299 body parses into a success (or a typed-malformed terminal, never a
  // crash).
  if (status >= 200 && status < 300) {
    const value = safeParse(result.bodyText);
    if (value.ok) {
      // C2 structural admission (success leg): the same depth + node-count protection as the ≥400
      // problem leg — a hostile deep OR flat-but-huge 2xx body is a typed terminal, never a crash
      // (stack overflow) or OOM downstream.
      const overCap = structuralOverCap(value.value);
      if (overCap !== null) {
        const error = new WireProblemError({ status, detail: overCap });
        return { kind: "terminal", error, status, ...meta };
      }
      return { kind: "success", value: value.value, ...meta };
    }
    // A 2xx whose body is NOT JSON — a typed terminal on the typed path (a management op expects a
    // DTO), but distinguished with `nonJson` so the RAW door can opt to tolerate it (a raw GET of a
    // text/plain 2xx endpoint). NOT set on the depth-admission terminal above (that body IS json,
    // just hostile) — so tolerating non-JSON never tolerates an over-deep body.
    const error = new WireProblemError({
      status,
      detail: `the server returned HTTP ${status} with an unparseable JSON body`,
    });
    return { kind: "terminal", error, status, nonJson: true, ...meta };
  }

  // Any other sub-400 status (1xx informational, 3xx redirect) is NOT a management success — the
  // client expects a 2xx and follows no redirects. Classify as a typed terminal on the ACTUAL
  // status (finding 6) so a 302/304 can never be mistaken for a success.
  const error = new WireProblemError({
    status,
    detail: `the server returned HTTP ${status}, which is not a management success (a 2xx was expected)`,
  });
  return { kind: "terminal", error, status, ...meta };
}

/**
 * The response structural-admission cap (C2): reject a parsed body that would overflow the recursive
 * `JSON.stringify` sink (too DEEP) or OOM the iterative redaction walker (too many nodes — a flat,
 * shallow 16 MiB array passes a depth-only cap). Returns a STATIC over-cap detail (never a body byte)
 * or null when the body is admissible. Measured in ONE walk (measureJsonStructure) — no double pass.
 */
function structuralOverCap(value: unknown): string | null {
  const { depth, nodeCount } = measureJsonStructure(value);
  if (depth > MAX_JSON_DEPTH) return "the server response JSON exceeded the client's maximum nesting depth";
  if (nodeCount > MAX_RESPONSE_JSON_NODE_COUNT) {
    return "the server response JSON exceeded the client's maximum node count";
  }
  return null;
}

function safeParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
