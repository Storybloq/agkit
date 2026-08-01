// The VENDORED wire-error retry map (T-207, canonical L2-CLI-04, deliverable 2).
//
// Per §B-10 (consumers vendor byte-pinned copies of the contract, never reach into
// another package at RUNTIME) this is a hand-vendored, byte-pinned `code → {http,
// retry}` copy of the cloud-owned management error table, pinned to
// `management_version` 1.2.0. `packages/shared` is NOT in the npm tarball, so the
// runtime MUST read only this local copy — never the contract JSON. The contract
// JSON is loaded DEV-TIME ONLY, and only by TESTS (two of them today: the drift
// test, wire-table.test.ts, which asserts this map is EXACTLY consistent with the
// pinned bundle — same code set, same http, same retry — so a contract change that
// isn't mirrored here fails CI rather than silently drifting; and literal-guard.test.ts's
// version-stamp check, which reads the same bundle to verify the stamp below). No
// RUNTIME module reads it.
//
// `retry` is the static disposition the contract derives per code; the exit mapping
// (retry → exit) is applied in wire-classify.ts. NOTE: the contract publishes 24
// codes at v1.2.0 (its `$comment`/Guard-E count; byte-identical to v1.1.0 apart from
// the version stamp + one $comment tag string) — all 24 are vendored below.

/** The management_version this vendored copy is pinned to. Drift-tested. */
export const MANAGEMENT_ERRORS_VERSION = "1.2.0" as const;

/** The ratified retry vocabulary (management-errors.json `meta.retry_vocabulary`). */
export type RetryClass = "none" | "refresh_auth" | "retry_with_backoff";

/** The two byte-pinned facts per code. Exactly these keys (the drift test uses `toEqual`). */
export interface WireErrorSpec {
  readonly http: number;
  readonly retry: RetryClass;
}

/**
 * The vendored table. Byte-for-byte the `{code → {http, retry}}` projection of
 * the frozen `management/v<MANAGEMENT_ERRORS_VERSION>/management-errors.json`
 * `codes[]` — the path's version segment is ALWAYS the stamp declared above, never
 * a separately-typed tag. Named INDIRECTLY on purpose: this line used to hardcode
 * `v1.1.0` and went stale at the 1.2.0 bump. Comment drift like that is invisible
 * to every guard here — the literal-guard scans CODE lines only, and the drift test
 * compares VALUES, not prose.
 */
export const WIRE_ERROR_TABLE: Readonly<Record<string, WireErrorSpec>> = {
  invalid_request: { http: 400, retry: "none" },
  version_unsupported: { http: 400, retry: "none" },
  auth_invalid: { http: 401, retry: "none" },
  token_expired: { http: 401, retry: "refresh_auth" },
  forbidden: { http: 403, retry: "none" },
  scope_insufficient: { http: 403, retry: "none" },
  plan_required: { http: 403, retry: "none" },
  confirm_required: { http: 422, retry: "none" },
  not_found: { http: 404, retry: "none" },
  conflict: { http: 409, retry: "none" },
  idempotency_in_flight: { http: 409, retry: "retry_with_backoff" },
  plan_stale: { http: 409, retry: "none" },
  plan_already_applied: { http: 409, retry: "none" },
  plan_expired: { http: 410, retry: "none" },
  precondition_failed: { http: 412, retry: "none" },
  payload_too_large: { http: 413, retry: "none" },
  validation_failed: { http: 422, retry: "none" },
  idempotency_key_conflict: { http: 422, retry: "none" },
  limit_exceeded: { http: 403, retry: "none" },
  rate_limited: { http: 429, retry: "retry_with_backoff" },
  internal_error: { http: 500, retry: "retry_with_backoff" },
  upstream_error: { http: 502, retry: "retry_with_backoff" },
  service_unavailable: { http: 503, retry: "retry_with_backoff" },
  not_implemented: { http: 501, retry: "none" },
};

/** The vendored code set (runtime array — drift test compares it to the contract). */
export const WIRE_ERROR_CODES: readonly string[] = Object.keys(WIRE_ERROR_TABLE);

/** Runtime guard: is `code` a known (vendored) wire code? Postel: unknown → generic. */
export function isWireCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(WIRE_ERROR_TABLE, code);
}
