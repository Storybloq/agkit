// The pinned client-side IO / JSON bounds (T-222 step 10b, C5/D4). Every request the CLI sends and
// every response it reads is now bounded — the typed client's real traffic never approaches these
// ceilings, but the raw wire door (`agkit api …`) forwards operator-controlled paths/bodies and
// consumes arbitrary server responses, so the whole pipeline must fail-closed on a hostile or
// runaway payload rather than exhaust memory or overflow the native recursive JSON sinks.
//
// These are DELIBERATELY generous relative to real management traffic (a management envelope is a
// few KB and a handful of nesting levels): the point is a hard backstop, not a tight fit. They are
// pinned constants (not config) so the bound is identical across every surface and cannot be
// widened per-invocation. Units are called out per constant.

/**
 * Max container-nesting depth of any JSON value the client (de)serializes. Bounds the recursion
 * depth of the native `JSON.stringify` sink AND the redaction walker — a pathologically deep body
 * (`[[[…]]]`) would otherwise overflow the stack. Enforced at RESPONSE admission (classify.ts) and
 * on a raw REQUEST body (json-bounds.ts). Unit: levels of array/object nesting (a scalar is 0).
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Max total node count in a raw REQUEST body — the root plus every array element and every object
 * member VALUE (object KEYS are not counted as nodes; their length is bounded separately). Bounds
 * the work a single structural walk performs on a CLIENT-authored body (small by construction).
 * Unit: nodes.
 */
export const MAX_JSON_NODE_COUNT = 10_000;

/**
 * Max total node count in a SERVER-authored RESPONSE body (same node semantics as MAX_JSON_NODE_COUNT).
 * Enforced at response admission (classify.ts) alongside the depth cap. A hostile/compromised server
 * can answer just UNDER MAX_RESPONSE_BYTES (16 MiB) with a FLAT, shallow body — e.g. an 8M-element
 * array — which sails past the depth-only cap; the parsed value then reaches the redaction walker
 * (redaction.ts) + native `JSON.stringify` sinks, whose iterative rewrite allocates O(width) live
 * tasks/closures and OOM-crashes the process. This bounds that width. DELIBERATELY generous vs any
 * legitimate response (a max-page list is ≤200 rows) so it never false-rejects real traffic, while
 * capping the walker's transient allocation ~40× below even a memory-constrained host's ceiling.
 * Unit: nodes.
 */
export const MAX_RESPONSE_JSON_NODE_COUNT = 200_000;

/** Max length of any object KEY. Unit: UTF-8 bytes. */
export const MAX_KEY_LENGTH = 1_024;

/** Max length of any individual JSON string VALUE. Unit: UTF-8 bytes. */
export const MAX_VALUE_LENGTH = 1_048_576; // 1 MiB

/** Max size of a raw REQUEST body the client will send (the raw door's `bodyBytes`). Unit: UTF-8 bytes. */
export const MAX_REQUEST_BYTES = 5_242_880; // 5 MiB

/**
 * Max size of a RESPONSE body the transport will read into memory. Enforced WHILE consuming the
 * stream (a lying or absent `Content-Length` cannot bypass it) — an over-cap response is truncated
 * and flagged, never parsed. Unit: decoded UTF-8 bytes.
 */
export const MAX_RESPONSE_BYTES = 16_777_216; // 16 MiB

/** Max number of query parameters a raw request may carry. Unit: key=value pairs. */
export const MAX_QUERY_PARAMS = 64;
