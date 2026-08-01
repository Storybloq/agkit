// The typed management HTTP client (T-211 step 3b — minimal composition for now). It
// implements the landed `ManagementClient` seam by resolving `RequestSpec.operationId`
// through the frozen route registry (`routeFor`) and composing the leaf layers:
//   enforceGuard → prepare → idempotency → transport → classify → retry.
// Unknown op → a typed internal error (the type system already prevents it at compile
// time via `operationId: K extends keyof Operations`). NOT yet wired into run.ts — that
// (and the version fence, pagination, and the concrete refresh executor) land in later
// steps. Unit-tested with an injected fetch/transport.
import { routeFor, type RouteEntry } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import type { ManagementClient, OperationResponse, RawRequestSpec, RawResult, RequestSpec } from "../../commands/types";
import type { PreparedRequest } from "./prepare";
import type { Operations } from "@agentkit-cloud/shared/wire-contract/management-types.gen";
import { CliLocalError } from "../errors";
import { prepareRequest } from "./prepare";
import { applyIdempotencyKey, type UuidFn } from "./idempotency";
import { classifyResponse } from "./classify";
import type { Transport } from "./transport";
import { executeWithRetry, DEFAULT_RETRIES } from "./retry";
import { createSingleFlightRefresh } from "./refresh-latch";
import { validateRawPath } from "./raw-path";
import { parseRawQuery } from "./raw-query";
import { MAX_REQUEST_BYTES } from "./limits";

/**
 * Response-metadata callback (finding 16): invoked for EVERY classified response — successes AND
 * errors — with the operation, the transport status, the advertised management version, and the
 * idempotency-replay flag. It is the observation channel the version fence + `status` reporting
 * (step 5) and replay/warning surfacing consume. A thrown TransportError (network/timeout) reports
 * NOTHING (there was no response to classify).
 *
 * The sink is AWAITED and its failures — a sync throw OR a rejection — intentionally PROPAGATE
 * before any retry decision (re-review R5): the step-5 version fence throws `version_skew`
 * through this channel and must preempt a resend. Best-effort observers must catch their own
 * errors.
 */
export type ResponseMetaSink = (meta: {
  operationId: string;
  status: number;
  advertisedVersion: string | null;
  replayed: boolean;
  /**
   * T-222 6a (C2): the PER-REQUEST fence mode this request opted into (`RequestSpec.fence`),
   * or undefined to inherit the client-wide mode. The version fence reads `meta.fence ?? opts.mode`,
   * so a report-mode `selftest` client can still force THROW on its authenticated/mutating checks
   * (whoami/read/write) — a skew that first appears at one of THOSE responses throws before the
   * write is accepted — while `discovery.get` and the best-effort reconcile stay report-mode.
   */
  fence?: "report" | "throw";
}) => void | Promise<void>;

/** Everything the client needs, all injected (run.ts wires the production seams in step 7). */
export interface ManagementClientDeps {
  /** The resolved, guard-approved management base URL (origin). */
  readonly baseUrl: string;
  /** The bearer credential for the FIRST send (a refresh may swap it mid-request). */
  readonly token: string;
  /** One send of a prepared request under a token (createTransport(...) in production). */
  readonly transport: Transport;
  /**
   * Runs the API-URL exfiltration guard (`enforceApiUrlGuard`) BEFORE the first send.
   * Injected as a seam so the client owns the "guard-before-send" invariant without
   * dragging config-loading deps into this layer; step 7 wires the real guard.
   */
  readonly enforceGuard: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /** UUIDv4 seam for auto-generated idempotency keys (defaults to crypto.randomUUID). */
  readonly uuid?: UuidFn;
  /** Refresh executor (step 6). Receives the stale bearer that 401'd (A40). Absent ⇒ a token_expired 401 is terminal. */
  readonly refreshAuth?: (staleBearer?: string) => Promise<string | null>;
  /** `--retries` budget (default 2). */
  readonly retries?: number;
  /** `--idempotency-key` override (honored on any route). */
  readonly idempotencyKeyOverride?: string;
  /** Observation channel for EVERY classified response (finding 16). Optional. */
  readonly onResponseMeta?: ResponseMetaSink;
}

/** The per-dispatch inputs `dispatchPrepared` needs (drawn from a typed `RequestSpec` OR a raw spec). */
interface DispatchOpts {
  /** For `onResponseMeta` labeling + diagnostics (`raw:<METHOD> <path>` for the raw door, step 10c). */
  readonly operationId: string;
  /** The frozen route entry — the retry engine reads `idempotency` from it, never a param (finding 8). */
  readonly route: RouteEntry;
  /** Per-request custody budget (S3): `timeoutMs` rides to the transport, `retries` overrides the default. */
  readonly budget?: RequestSpec["budget"];
  /** Capture the settled send's ETag (T-213 S12). */
  readonly captureMeta?: boolean;
  /** Per-request version-fence mode (C2) — carried on the response-meta so a report-mode client can force throw. */
  readonly fence?: "report" | "throw";
  /** Whether a 401 `refresh_auth` may invoke the refresh executor (a zero-mutation instrument opts OUT). */
  readonly allowRefresh: boolean;
  /**
   * T-222 step 10b: the RAW door opts in — a 2xx whose body is NOT JSON (classify's `nonJson`
   * terminal) is converted to a `value:null` success instead of a terminal error, so `agkit api get`
   * can surface a text/plain 2xx verbatim. The typed path never sets this (a management op that
   * returns a non-JSON 2xx is a genuine terminal). A truncated or over-deep body is NEVER tolerated.
   */
  readonly tolerateNonJson2xx?: boolean;
}

/** The rich settled result — the typed `request()` shapes `value`; the raw door reads `status`/`bodyText`. */
interface DispatchResult {
  readonly value: unknown;
  readonly replayed: boolean;
  readonly advertisedVersion: string | null;
  /** The LAST classified send's transport status (last-write-wins across a 500→200 retry). */
  readonly status: number | null;
  /** The LAST classified send's raw body text. */
  readonly bodyText: string | null;
  /** The settled send's ETag (only when `captureMeta`). */
  readonly etag: string | null;
  /** T-222 step 10b: the settled send was a tolerated non-JSON 2xx (`value` is null; read `bodyText`). */
  readonly nonJson2xx: boolean;
}

export function createManagementClient(deps: ManagementClientDeps): ManagementClient {
  // Token retention + single-flight, stale-aware refresh (finding 15 + re-review R4 + codex
  // confirmation round): the bearer lives in a cell in the CLIENT closure, so a refresh that
  // rotates it persists ACROSS request() calls on this one client. The latch semantics
  // (single-flight, stale fast-path, settlement-race invariant, rejection propagation) live in
  // refresh-latch.ts, where they are unit-tested at microtask granularity.
  const bearer = { current: deps.token };
  const singleFlightRefresh = deps.refreshAuth ? createSingleFlightRefresh(deps.refreshAuth, bearer) : undefined;

  /**
   * The post-prepare send CORE (T-222 step 10a): send → retry policy → single 401-refresh →
   * classifyResponse → fence via `onResponseMeta` → wire-problem mapping. Behavior-preserving
   * extraction from `request()` — the ONLY caller today; the raw door (step 10b) consumes the SAME
   * pipeline (never a duplicate) with a `raw:<METHOD> <path>` operationId. `prepared` is already
   * immutable (bytes + idempotency key computed once); only `Authorization` may change (a refresh).
   */
  async function dispatchPrepared(prepared: PreparedRequest, opts: DispatchOpts): Promise<DispatchResult> {
    // The ETag / status / bodyText of the LAST classified send (last-write-wins, so a 500→200 retry
    // keeps the SUCCESS's values). ETag is read only on `captureMeta` (T-213 S12); status/bodyText are
    // always captured for the raw door (a thrown wire/terminal error never returns, so a caller only
    // ever reads these on a resolved success).
    let capturedEtag: string | null = null;
    let lastStatus: number | null = null;
    let lastBodyText: string | null = null;
    let nonJson2xx = false;

    // Report meta for EVERY classified response (finding 16) — after classifyResponse, so a
    // 500-then-200 sequence reports BOTH. A thrown TransportError bypasses this (no response).
    const send = async (token: string) => {
      // T-222 S3: a per-request budget's timeoutMs rides to the transport's per-call opts.
      const raw = await deps.transport(prepared, token, { timeoutMs: opts.budget?.timeoutMs });
      let outcome = classifyResponse(raw);
      lastStatus = raw.status;
      lastBodyText = raw.bodyText;
      // T-222 step 10b: the raw door tolerates a NON-JSON 2xx — classify tagged it `nonJson` (the
      // body is not json, but the status is a success and it was fully read). Convert it to a
      // `value:null` success so the retry engine settles it and the raw caller reads `bodyText`.
      // Scoped to the tolerating (raw) path; the typed path leaves such a response terminal.
      if (opts.tolerateNonJson2xx && outcome.kind === "terminal" && outcome.nonJson === true) {
        nonJson2xx = true;
        outcome = {
          kind: "success",
          value: null,
          replayed: outcome.replayed,
          advertisedVersion: outcome.advertisedVersion,
          retryAfter: outcome.retryAfter,
        };
      }
      if (opts.captureMeta) capturedEtag = raw.headers.get("ETag");
      // AWAITED (re-review R5): a sink failure — sync throw or rejection — propagates out of
      // send() BEFORE the retry engine makes any resend decision. That is deliberate: the
      // step-5 version fence throws version_skew through this channel; best-effort observers
      // must catch their own errors.
      await deps.onResponseMeta?.({
        operationId: opts.operationId,
        status: raw.status,
        advertisedVersion: raw.advertisedVersion,
        replayed: outcome.replayed,
        // T-222 6a (C2): carry the per-request fence mode so the composed fence can honor a
        // per-request override (`meta.fence ?? opts.mode`) — selftest forces "throw" on its
        // authenticated/mutating checks while its client-wide default stays "report".
        fence: opts.fence,
      });
      return outcome;
    };

    const settled = await executeWithRetry({
      send,
      token: bearer.current,
      request: prepared,
      route: opts.route,
      // T-222 S3: a per-request budget overrides the client-wide budget for THIS request only.
      retries: opts.budget?.retries ?? deps.retries ?? DEFAULT_RETRIES,
      // A-9 (T-212 S8): a request flagged `refresh: false` gets NO refresh hook — a 401
      // refresh_auth disposition is terminal for it, and the executor (which would consume
      // a refresh-token rotation) is never invoked. Zero-mutation instruments opt in.
      deps: {
        sleep: deps.sleep,
        random: deps.random,
        refreshAuth: opts.allowRefresh ? singleFlightRefresh : undefined,
      },
    });

    return {
      value: settled.value,
      replayed: settled.replayed,
      advertisedVersion: settled.advertisedVersion,
      status: lastStatus,
      bodyText: lastBodyText,
      etag: capturedEtag,
      nonJson2xx,
    };
  }

  /**
   * T-222 step 10b: build the raw-door prepared request + a SYNTHETIC route entry. The synthetic entry
   * exists ONLY to satisfy `executeWithRetry`'s pairing guard + its 3 reads ({operation_id, method,
   * idempotency}); `routeFor`/`isIdempotencyRequired`/`isPaginated` read the FROZEN table, never this.
   * S7.2/S7.3 resend safety rides the EXISTING predicate: GET/HEAD are always resend-safe; a mutation
   * is resend-safe ONLY when it carries an idempotency key (idempotency:"required" ⇔ a key is present).
   * The Idempotency-Key is set from the client-wide override ALONE — NEVER auto-generated (a raw POST
   * without an explicit key must never be silently resent).
   */
  function buildRawPrepared(
    method: RawRequestSpec["method"],
    url: string,
    canonicalPath: string,
    bodyBytes: string | null,
    override: string | undefined,
  ): { prepared: PreparedRequest; route: RouteEntry } {
    const operationId = `raw:${method} ${canonicalPath}`;
    const headers: Record<string, string> = {};
    if (bodyBytes !== null) headers["content-type"] = "application/json";
    if (override !== undefined) headers["Idempotency-Key"] = override;
    const prepared: PreparedRequest = Object.freeze({
      operationId,
      method,
      url,
      headers: Object.freeze(headers),
      bodyBytes,
    });
    const route: RouteEntry = {
      operation_id: operationId,
      // The frozen `RouteMethod` has no "HEAD" (no table row uses it); the raw door does. The retry
      // engine only STRING-compares this field (retry.ts reads it via a string-typed local precisely
      // so HEAD works), so the cast is safe — this synthetic entry never enters the frozen table.
      method: method as RouteEntry["method"],
      path: canonicalPath,
      idempotency: override !== undefined ? "required" : "none",
      paginated: false,
      concurrency: "none",
      secret_bearing: "none",
      route_status: "implemented",
    };
    return { prepared, route };
  }

  return {
    async request<K extends keyof Operations>(op: RequestSpec<K>): Promise<OperationResponse<K>> {
      const route = routeFor(op.operationId);
      if (route === undefined) {
        // Compile-time unreachable (K is constrained to a real operation_id); a runtime miss means
        // a corrupted registry or a cast. Throw the landed T-207 CLI-local terminal error (exit 2)
        // rather than a bare Error — no new code is minted (usage_error is the closed-set catch-all
        // for a local/unknown-command validation fault; the bare Error folded to it anyway).
        throw new CliLocalError("usage_error", {
          detail: `agkit: internal — unknown management operation "${String(op.operationId)}"`,
        });
      }

      // Guard the destination host BEFORE constructing or sending anything.
      await deps.enforceGuard();

      // prepare (bytes computed once) → idempotency key (once) → the immutable request. Preconditions
      // come from the PER-REQUEST spec (finding 17), never a client-wide setting. T-212 F-A/A-1: a
      // request flagged `idempotency.ignoreClientOverride` drops the client-wide `--idempotency-key`
      // override and auto-generates a fresh key — the ceremony's internal writes must never reuse the
      // user's key (unique per principal → a reuse deterministically 422s idempotency_key_conflict).
      const override = op.idempotency?.ignoreClientOverride ? undefined : deps.idempotencyKeyOverride;
      const prepared = applyIdempotencyKey(
        prepareRequest(op, route, deps.baseUrl, {
          ifMatch: op.preconditions?.ifMatch,
          ifNoneMatch: op.preconditions?.ifNoneMatch,
        }),
        override,
        deps.uuid,
      );

      const result = await dispatchPrepared(prepared, {
        operationId: String(op.operationId),
        route,
        budget: op.budget,
        captureMeta: op.captureMeta,
        fence: op.fence,
        allowRefresh: op.refresh !== false,
      });

      // T-213 S12: on `captureMeta`, augment the resolved object with a `meta.etag` (undefined when
      // the server sent no ETag). Attach ONLY to an object value (a 204/205 empty resolves to
      // `undefined`, and a non-object success has no field to carry it) — `readCapturedEtag`
      // returns undefined for those, so a bodiless response never crashes the consumer.
      if (op.captureMeta && result.value !== null && typeof result.value === "object") {
        return {
          ...(result.value as Record<string, unknown>),
          meta: { ...(result.value as { meta?: Record<string, unknown> }).meta, etag: result.etag ?? undefined },
        } as OperationResponse<K>;
      }
      return result.value as OperationResponse<K>;
    },

    async raw(spec: RawRequestSpec): Promise<RawResult> {
      // Guard the destination host BEFORE constructing or sending anything (same invariant as request).
      await deps.enforceGuard();

      // Validate + canonicalize the operator path against the guard-approved origin, then the query.
      // Both throw a STATIC usage_error on any boundary/format violation — NO send happens on failure.
      const { canonicalPath, rawQuery } = validateRawPath(spec.path, deps.baseUrl);
      // The `--field k=v` entries (10c) are query-ONLY: parseRawQuery validates them against the closed
      // allowlist and dedups them against the path's inline `?query` (D3). Absent → an empty extra set.
      const canonicalQuery = parseRawQuery(rawQuery, spec.queryFields ?? []);

      // M1: bound the request body BEFORE building the request (a static usage_error, never a send).
      const bodyBytes = spec.bodyBytes ?? null;
      if (bodyBytes !== null && new TextEncoder().encode(bodyBytes).length > MAX_REQUEST_BYTES) {
        throw new CliLocalError("usage_error", {
          detail: "the request body exceeds the maximum request size",
          hint: "reduce the request body size",
        });
      }

      const base = deps.baseUrl.replace(/\/$/, "");
      const url = base + canonicalPath + (canonicalQuery.length > 0 ? `?${canonicalQuery}` : "");
      // The Idempotency-Key rides from the client-wide override ONLY (S7.2 — never auto-generated for
      // the raw door); a keyless raw mutation stays idempotency:"none" and is never silently resent.
      const { prepared, route } = buildRawPrepared(
        spec.method,
        url,
        canonicalPath,
        bodyBytes,
        deps.idempotencyKeyOverride,
      );

      const result = await dispatchPrepared(prepared, {
        operationId: prepared.operationId,
        route,
        budget: spec.budget,
        allowRefresh: true,
        // The raw door surfaces a non-JSON 2xx verbatim rather than failing it (a text/plain endpoint).
        tolerateNonJson2xx: true,
      });

      // A tolerated non-JSON 2xx carries its verbatim text in `bodyText` and a null `body`; every other
      // settled send carries the parsed `value` (JSON) and no verbatim text. `dispatchPrepared` never
      // re-parses — `result.value` is the ALREADY-classified body (closes C2-b).
      return {
        status: result.status,
        // A 204/empty settles to `undefined`; normalize it (and only it) to null. `?? null` preserves
        // a legitimate falsy JSON body (`false`/`0`/`""`) and a literal JSON `null`.
        body: result.nonJson2xx ? null : (result.value ?? null),
        bodyText: result.nonJson2xx ? result.bodyText : null,
      };
    },
  };
}
