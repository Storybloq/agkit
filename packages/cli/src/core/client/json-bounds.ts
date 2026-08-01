// Iterative (stack-based, NON-recursive) JSON structural bounds (T-222 step 10b, D4). Two consumers:
//   • `assertJsonWithinBounds` — enforces ALL of {depth, node-count, key-length, value-length} on a
//     raw REQUEST body before it is sent (the `agkit api …` `--input`/`--field` body, step 10c).
//   • `jsonDepth` — the depth-only measurement the RESPONSE-admission cap (classify.ts) uses to keep
//     a hostile server body from overflowing the native recursive `JSON.stringify` + redaction sinks.
//
// Both walk with an EXPLICIT stack (never recursion) so the bounds-checker itself can never overflow
// on the very input it is meant to reject. `jsonDepth` returns a number (pure); `assertJsonWithinBounds`
// throws the existing closed-set `usage_error` (no new code) with a STATIC cap-naming detail — it NEVER
// interpolates a key or a value into the message (a body byte could be a secret).
import { CliLocalError } from "../errors";
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODE_COUNT,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
} from "./limits";

/** Is `v` a JSON container (array or non-null plain object)? Scalars (string/number/bool/null) are not. */
function isContainer(v: unknown): v is unknown[] | Record<string, unknown> {
  return v !== null && typeof v === "object";
}

const encoder = new TextEncoder();

/**
 * The caps a MEASURING caller already intends to enforce, handed to `measureJsonStructure` so the walk
 * may stop at the first breach instead of measuring a body it has already decided to reject. Both are
 * exclusive ceilings, matching every caller's `> cap` test.
 */
export interface JsonStructureCaps {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

/**
 * The maximum container-nesting depth AND total node count of `value`, computed in ONE explicit-stack
 * walk (never recursion) so a pathological input measures without a stack overflow. Node semantics
 * match `assertJsonWithinBounds`: the root is 1 node, every array element and every object member
 * VALUE is a node, object KEYS are not. The response-admission cap (classify.ts) uses BOTH numbers —
 * depth guards the downstream recursive `JSON.stringify` sink; node count guards the iterative
 * redaction walker's O(width) transient allocation on a flat-but-huge hostile body.
 *
 * Without `caps` the measurement is EXACT (depth-only callers and the boundary tests pin the exact
 * numbers). With `caps` the walk stops at the FIRST breach and returns that measurement SATURATED —
 * strictly greater than the cap it broke, the other value a lower bound — which leaves every `> cap`
 * verdict identical while refusing to spend the whole document's worth of work on a body that is
 * already provably over the line. A hostile server may answer just under the streaming byte cap, so
 * the measurement itself must not be the attacker's lever. Breach precedence follows the pop order of
 * `assertJsonWithinBounds` (a frame's depth is tested before its children are counted), so a deep body
 * still reports depth first.
 */
export function measureJsonStructure(
  value: unknown,
  caps?: JsonStructureCaps,
): { depth: number; nodeCount: number } {
  let nodeCount = 1; // the root always counts as one node (even a scalar).
  if (!isContainer(value)) return { depth: 0, nodeCount };
  let maxDepth = 0;
  // An absent cap is an infinite one: one code path, no per-node branch on `caps` being present.
  const depthCap = caps?.maxDepth ?? Number.POSITIVE_INFINITY;
  const nodeCap = caps?.maxNodes ?? Number.POSITIVE_INFINITY;
  // Each frame is a container and the depth AT which it sits (root container = 1).
  const stack: Array<{ node: unknown[] | Record<string, unknown>; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    // Nothing below an already-over-deep frame can lower the verdict, so stop here.
    if (depth > depthCap) return { depth: maxDepth, nodeCount };
    if (Array.isArray(node)) {
      for (const el of node) {
        nodeCount += 1; // each element / member value is one node (keys are not counted).
        if (nodeCount > nodeCap) return { depth: maxDepth, nodeCount };
        if (isContainer(el)) stack.push({ node: el, depth: depth + 1 });
      }
    } else {
      // Own-property iteration, never `Object.values`: that snapshots every member VALUE of a
      // flat-but-huge body up front — the O(width) allocation this measurement exists to bound —
      // and it does so before the cap has any chance to stop the walk.
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        nodeCount += 1;
        if (nodeCount > nodeCap) return { depth: maxDepth, nodeCount };
        const child = node[key];
        if (isContainer(child)) stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return { depth: maxDepth, nodeCount };
}

/**
 * The maximum container-nesting depth of `value` (a scalar is 0, `[]`/`{}` is 1, `[[1]]` is 2 …).
 * A thin projection of `measureJsonStructure` kept for depth-only callers.
 */
export function jsonDepth(value: unknown): number {
  return measureJsonStructure(value).depth;
}

/** Throw the closed-set `usage_error` with a STATIC detail naming the breached cap (never a body byte). */
function breach(detail: string): never {
  throw new CliLocalError("usage_error", { detail });
}

/**
 * Assert `value` is within ALL structural bounds (depth, node count, key length, value length), or
 * throw `usage_error` with a static cap-naming message. Walks with an explicit stack (never recursion).
 * D4 node semantics: the root counts as 1 node; every array element and every object member VALUE is a
 * node; object KEYS are NOT nodes (their length is bounded on its own). Key/value lengths are UTF-8 bytes.
 */
export function assertJsonWithinBounds(value: unknown): void {
  // The root scalar's own value-length still counts (a 2 GiB string at the root is out of bounds).
  if (typeof value === "string" && encoder.encode(value).length > MAX_VALUE_LENGTH) {
    breach("a JSON string value exceeds the maximum length");
  }
  let nodeCount = 1; // the root
  if (!isContainer(value)) return;
  const stack: Array<{ node: unknown[] | Record<string, unknown>; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_JSON_DEPTH) breach("the request body exceeds the maximum JSON nesting depth");
    if (Array.isArray(node)) {
      for (const el of node) {
        nodeCount += 1;
        if (nodeCount > MAX_JSON_NODE_COUNT) breach("the request body exceeds the maximum JSON node count");
        checkChild(el, depth, stack);
      }
    } else {
      // Own-property iteration, never `Object.entries`: the pair array would materialize EVERY member
      // of a flat-but-huge body before the node cap could reject it, which is the allocation the cap
      // is here to prevent. Checks stay in cap order — key length, then node count, then the value.
      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        if (encoder.encode(k).length > MAX_KEY_LENGTH) breach("a JSON object key exceeds the maximum length");
        nodeCount += 1;
        if (nodeCount > MAX_JSON_NODE_COUNT) breach("the request body exceeds the maximum JSON node count");
        checkChild(node[k], depth, stack);
      }
    }
  }
}

/** Bound a scalar child's value length, or push a container child for the next iteration. */
function checkChild(
  child: unknown,
  depth: number,
  stack: Array<{ node: unknown[] | Record<string, unknown>; depth: number }>,
): void {
  if (typeof child === "string") {
    if (encoder.encode(child).length > MAX_VALUE_LENGTH) breach("a JSON string value exceeds the maximum length");
  } else if (isContainer(child)) {
    stack.push({ node: child, depth: depth + 1 });
  }
}
