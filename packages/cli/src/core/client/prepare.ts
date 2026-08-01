// The deterministic prepared-request layer (T-211 step 3a, A21). Turns a typed
// `{ operationId, params }` request + its frozen route-registry entry into an
// IMMUTABLE `PreparedRequest` whose bytes are computed ONCE and reused across every
// resend (A37: the retry loop never re-serializes — a re-serialized body could drift
// and trip the server's idempotency fingerprint, 422 `idempotency_key_conflict`).
//
// The param partition is entirely route-metadata-driven (never a per-op special case):
//   - path params  = the `{name}` template segments of `route.path` → percent-encoded
//                     substitution (a missing one is a typed usage error);
//   - the remainder = query string for GET/HEAD, a JSON body (serialized once) for a
//                     mutation; `undefined` values are omitted; there is NEVER a body
//                     on GET/HEAD.
// Preconditions (`If-Match` / `If-None-Match`) come from typed options and are honored
// ONLY on the route whose `concurrency` column expects them — a precondition on a
// `concurrency:"none"` route is REJECTED (§B-9 honor-or-reject, never silently dropped).
//
// Two rows are NOT callable through this layer and are REJECTED with a named reason
// (never a bogus URL): the dual-verb `GET+POST` method and the one dashboard-origin row
// `oauth.authorize` (a browser redirect whose `path` is not api-absolute).
import { routeFor, type RouteEntry } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import { CliLocalError } from "../errors";

/**
 * A client-side request-construction failure (bad/missing params, a precondition on a
 * route that has no concurrency guard, a non-callable row). Rendered as `usage_error`
 * (exit 2) through the existing taxonomy dispatcher — it is a determinate caller fault,
 * never something a script should auto-retry.
 */
export class RequestPreparationError extends CliLocalError {
  override name = "RequestPreparationError";
  constructor(detail: string, hint?: string) {
    super("usage_error", { detail, hint, message: detail });
  }
}

/**
 * The DUAL-MODE conditional operations (B0 shared-core, sub-wave B). Three frozen routes declare
 * `concurrency: "if_none_match"` (management-routes.json — `identity.upsert` :1157, `revenuecat.upsert`
 * :1232, `kill_switch.set` :1337) yet the SERVER accepts EITHER precondition depending on row presence:
 * absent → `If-None-Match: *` (create); present → `If-Match: <etag>` (replace / re-engage). The frozen
 * `killswitch_dual_mode_concurrency` note (management-routes.json:42) documents this "ratified DUAL-MODE
 * vocabulary" and the server gates it (`management-core direct-confirm.ts`). Without this set the If-Match
 * arm below would reject the replace/re-engage call CLIENT-side before any wire request — making
 * `revenuecat set` replace, `kill-switch activate` re-engage, and `voice-identity set` rebind UNREACHABLE.
 * If-None-Match stays strictly column-gated (these ops' column IS `if_none_match`, so create needs no
 * exception); ONLY the If-Match arm consults this set. Callers still never populate BOTH headers on one
 * request — the both-set guard below rejects that pre-network (defense-in-depth behind the caller-side
 * discriminated union `{mode:"create", ifNoneMatch:"*"} | {mode:"replace", ifMatch:<etag>}`).
 */
export const DUAL_MODE_CONDITIONAL_OPS: ReadonlySet<string> = new Set([
  "identity.upsert",
  "revenuecat.upsert",
  "kill_switch.set",
]);

/** The concrete method a prepared request carries (never the dual-verb `GET+POST`). */
export type ConcreteMethod = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";

/** An immutable, byte-stable prepared request. Reused verbatim across every resend. */
export interface PreparedRequest {
  /**
   * The operation this request was prepared FOR — stamped AFTER the spec↔route equality
   * check below, so downstream layers (the retry engine) can re-assert the request↔route
   * binding instead of trusting that the pair they were handed still agrees.
   */
  readonly operationId: string;
  readonly method: ConcreteMethod;
  readonly url: string;
  /** content-type (bodied only) + preconditions. The idempotency layer adds `Idempotency-Key`;
   * transport adds `Authorization` / version / client headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The serialized-once JSON body, or null for a bodiless request (GET/HEAD or an empty mutation). */
  readonly bodyBytes: string | null;
}

/** Typed preconditions supplied by the caller (validated against the route's concurrency column). */
export interface PrepareOptions {
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

/** The minimal request shape prepare reads (a `RequestSpec` without the compile-time key generic). */
export interface RequestSpecLike {
  readonly operationId: string;
  readonly params?: Record<string, unknown>;
}

const PATH_PARAM_RE = /\{([^}]+)\}/g;

/** Is this a body-carrying verb? GET/HEAD never carry a body (A21). */
function isBodied(method: ConcreteMethod): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * The ONE `{name}` template-substitution machinery (T-212 S7 / A-16 extraction): every
 * `{name}` segment of a route path template is replaced with the percent-encoded param
 * value; a missing/null param is a typed refusal naming the operation and the param.
 * `prepareRequest` runs every prepared request through this; `renderRoutePath` gives the
 * plan-change builders the SAME machinery so a change's CONCRETE path is never assembled
 * by hand (param validation + percent-encoding cannot drift between the two consumers).
 */
function substitutePathParams(
  op: string,
  templatePath: string,
  params: Record<string, unknown>,
): { readonly path: string; readonly consumed: ReadonlySet<string> } {
  const consumed = new Set<string>();
  const path = templatePath.replace(PATH_PARAM_RE, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new RequestPreparationError(
        `operation "${op}" requires the path parameter "${name}"`,
        `supply "${name}" for this command`,
      );
    }
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  return { path, consumed };
}

/**
 * A-16 (T-212 S7): render a route's CONCRETE api-absolute path for a plan change —
 * the frozen route registry supplies the template; `substitutePathParams` (the SAME
 * machinery prepareRequest uses) validates + percent-encodes the params. Fails loud
 * (typed `usage_error`) on an unknown operation, a non-api-absolute row (a browser
 * redirect is not a plannable route), or a missing path param — never a guessed path.
 */
export function renderRoutePath(operationId: string, params: Record<string, unknown>): string {
  const route = routeFor(operationId);
  if (route === undefined) {
    throw new RequestPreparationError(
      `unknown management operation "${operationId}" — no route entry exists to render a path from`,
      "this is an internal wiring bug — the operation_id must exist in the frozen route registry",
    );
  }
  if (!route.path.startsWith("/")) {
    throw new RequestPreparationError(
      `operation "${operationId}" has a non-api-absolute path ("${route.path}") — it is a browser redirect, not a plannable management route`,
      "this route is reached via the browser, not a plan change",
    );
  }
  return substitutePathParams(operationId, route.path, params).path;
}

/**
 * Build the immutable prepared request. Deterministic over `(spec, routeEntry, baseUrl, opts)`:
 * the same inputs always produce byte-identical `url` / `headers` / `bodyBytes`.
 */
export function prepareRequest(
  spec: RequestSpecLike,
  routeEntry: RouteEntry,
  baseUrl: string,
  opts: PrepareOptions = {},
): PreparedRequest {
  const op = routeEntry.operation_id;

  // ── route-confusion guard (finding 1): the spec's operation_id MUST match the route
  //    entry it was paired with. A mispaired lookup (a caller / registry bug that hands
  //    us route B for a request that asked for A) must NEVER silently construct route B's
  //    URL under A's identity — it would send the wrong method to the wrong path with A's
  //    params. Fail loud, naming BOTH ids, before any URL is built.
  if (spec.operationId !== op) {
    throw new RequestPreparationError(
      `route mismatch: request is for operation "${spec.operationId}" but was paired with the route entry for "${op}"`,
      "this is an internal pairing bug — the operation_id and its route entry must agree",
    );
  }

  // ── non-callable rows: reject with a NAMED reason (never construct a bogus URL) ──
  if (routeEntry.method === "GET+POST") {
    throw new RequestPreparationError(
      `operation "${op}" uses the dual-verb GET+POST method and is not a callable management API request`,
      "this is a browser-redirect row, not a management API call",
    );
  }
  if (!routeEntry.path.startsWith("/")) {
    throw new RequestPreparationError(
      `operation "${op}" has a non-api-absolute path ("${routeEntry.path}") — it is a dashboard-origin browser redirect, not a callable management API request`,
      "this route is reached via the browser, not the CLI HTTP client",
    );
  }

  const method = routeEntry.method as ConcreteMethod;
  const params = spec.params ?? {};

  // ── path params: {name} template segments → percent-encoded substitution (the ONE
  //    machinery, shared with the S7 plan-change builders via renderRoutePath — A-16) ──
  const { path, consumed } = substitutePathParams(op, routeEntry.path, params);

  // ── remaining params (not path-consumed, not undefined) → query or body ──
  const remaining: Array<[string, unknown]> = Object.entries(params).filter(
    ([key, value]) => !consumed.has(key) && value !== undefined,
  );

  const headers: Record<string, string> = {};
  let bodyBytes: string | null = null;
  let query = "";

  if (isBodied(method)) {
    if (remaining.length > 0) {
      // `Object.fromEntries` uses CreateDataProperty semantics (finding 2): an own "__proto__"
      // param becomes an OWN, serializable property rather than mutating Object.prototype the way
      // `bodyObj["__proto__"] = …` would (that assignment hits the prototype setter and is dropped
      // from the serialized body). Object.prototype is left untouched.
      const bodyObj = Object.fromEntries(remaining);
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(bodyObj); // serialized ONCE — the exact bytes every resend reuses
      } catch (err) {
        // A non-serializable param (BigInt, a circular reference, a throwing toJSON) is a
        // determinate caller fault, not a network error (finding 3). Fail typed, naming the
        // operation, and fold the original cause into the detail (CliLocalError has no `cause`).
        throw new RequestPreparationError(
          `operation "${op}" has a request body that cannot be serialized to JSON: ${messageOf(err)}`,
          "remove or fix the non-serializable parameter (e.g. a BigInt or a circular reference)",
        );
      }
      // JSON.stringify can also return `undefined` WITHOUT throwing (an own top-level callable
      // `toJSON` returning undefined). Same fault family as the throw path — a bodied request
      // must never carry undefined bytes under a JSON content-type.
      if (typeof serialized !== "string") {
        throw new RequestPreparationError(
          `operation "${op}" has a request body that cannot be serialized to JSON: JSON.stringify returned undefined (a top-level toJSON returning undefined)`,
          "remove or fix the non-serializable parameter (e.g. a toJSON that returns undefined)",
        );
      }
      bodyBytes = serialized;
      headers["content-type"] = "application/json"; // exact, lowercase (A21)
    }
  } else if (remaining.length > 0) {
    const qs = new URLSearchParams();
    for (const [key, value] of remaining) qs.append(key, String(value));
    query = qs.toString();
  }

  // ── preconditions: honor ONLY on the concurrency column that expects them ──
  // A single request NEVER carries both conditional headers (the caller's dual-mode discriminated
  // union makes it structurally impossible; this is defense-in-depth). Reject pre-network rather than
  // let the server 400 `invalid_header` — client-side honor-or-reject.
  if (opts.ifMatch !== undefined && opts.ifNoneMatch !== undefined) {
    throw new RequestPreparationError(
      `operation "${op}" cannot carry both an If-Match and an If-None-Match precondition`,
      "supply exactly one precondition (create ⇒ If-None-Match:*, replace ⇒ If-Match:<etag>)",
    );
  }
  if (opts.ifMatch !== undefined) {
    // If-Match is accepted on an `if_match` row OR a DUAL-MODE `if_none_match` row in replace mode
    // (the server accepts If-Match to update an existing row on those three ops — see the set above).
    if (routeEntry.concurrency !== "if_match" && !DUAL_MODE_CONDITIONAL_OPS.has(op)) {
      throw new RequestPreparationError(
        `operation "${op}" does not accept an If-Match precondition (concurrency: "${routeEntry.concurrency}")`,
        "remove the precondition option for this route",
      );
    }
    headers["If-Match"] = opts.ifMatch;
  }
  if (opts.ifNoneMatch !== undefined) {
    if (routeEntry.concurrency !== "if_none_match") {
      throw new RequestPreparationError(
        `operation "${op}" does not accept an If-None-Match precondition (concurrency: "${routeEntry.concurrency}")`,
        "remove the precondition option for this route",
      );
    }
    headers["If-None-Match"] = opts.ifNoneMatch;
  }

  const url = baseUrl.replace(/\/$/, "") + path + (query.length > 0 ? `?${query}` : "");
  // `operationId` is stamped from the route entry (`op`) — the equality check above already
  // proved spec.operationId === op, so the stamp is the VALIDATED identity, not a raw echo.
  return Object.freeze({ operationId: op, method, url, headers: Object.freeze(headers), bodyBytes });
}

/** Extract a message from an unknown thrown value without itself throwing. */
function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown error";
  }
}
