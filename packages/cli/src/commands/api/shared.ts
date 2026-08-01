// The `api` raw-wire-door command family — shared surface (T-222 step 10c, L2-CLI-20). The five
// verbs (`agkit api get|post|put|patch|delete <path>`) forward an OPERATOR-controlled <method, path>
// through the SAME credential / guard / refresh / classification / version-fence / redaction pipeline
// as the typed client, via `ctx.client.raw` (the 10b raw door) — never a duplicate pipeline. This
// module holds what the verb files share: the M-ceremony preview + body assembly + `--field` query
// normalization + result mapping + the mutation-handler factory.
//
// SECRET CUSTODY (A1 / B1 / C1 — codex CRITICAL, SUPERSEDING the base body-overlay design): a
// management bearer rides these calls, so NO secret may enter argv/shell-history. The request BODY
// comes EXCLUSIVELY from `--input <file|->` (out-of-band JSON); `--field` sets QUERY parameters ONLY
// (never a body merge), restricted to the raw-query allowlist's CLOSED non-secret value validators
// (raw-query.ts). `--input` PATHS and every `--field` value are elided from any reconstructed
// invocation (`elideFlags`), and every error/preview line is STATIC w.r.t. values (a body byte or a
// query value could be a secret). GET carries no body and its query rides inline in `<path>`.
import { z } from "zod";
import type { CommandHandler, CommandResult, Ctx, RawResult } from "../types";
import { requireService } from "../command-seams";
import { CliLocalError } from "../../core/errors";
import { assertJsonWithinBounds } from "../../core/client/json-bounds";
import { MAX_JSON_NODE_COUNT } from "../../core/client/limits";

/** The concrete mutating methods the `api` verbs expose (GET is a separate SR verb; HEAD is not a command). */
export type ApiMutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Flags elided from every reconstructed invocation / hint (T-217 S3C; A1 defense-in-depth behind the
 * primary out-of-band control): the `--input` PATH and every `--field` value never reproduce in an
 * error, a hint, or a reconstructed command line.
 */
export const API_ELIDE_FLAGS: readonly string[] = ["input", "field"];

/**
 * The shared MUTATION args: a required positional `path`, an optional out-of-band body source
 * (`--input <file|->`), and repeatable non-secret query params (`--field k=v`). `.strict()` so a
 * stray flag is a usage_error. (A plain `ZodObject` — NOT a `.refine()` — so the registry's
 * `positional.key ∈ args.shape` load-check can read `.shape`.)
 */
export const apiMutationArgs = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Absolute management path, e.g. /v1/management/projects (an inline ?query is allowed)."),
    input: z
      .string()
      .min(1)
      .optional()
      .describe("Request body source: a file path, or '-' to read stdin. Bodies are out-of-band — never argv."),
    field: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("A query parameter key=value (repeatable). Allowlisted non-secret params only, e.g. limit=50."),
  })
  .strict();
export type ApiMutationInput = z.infer<typeof apiMutationArgs>;

/** Normalize the scalar-or-array `--field` input to an ordered string[] (T-217 `--extra-header` precedent). */
function normalizeFields(field: string | string[] | undefined): string[] {
  if (field === undefined) return [];
  return Array.isArray(field) ? field : [field];
}

/**
 * A `--field` entry's PREVIEW summary: its KEY name + its value BYTE-LENGTH — never the value (R-E).
 * A MALFORMED entry (no `=`) has no key/value split, so the whole token would otherwise print as a
 * "key"; it is summarized statically instead (never echoed) so the preview stays value-free even for
 * junk input — the entry is rejected by `parseRawQuery` before any send regardless. (The rendered
 * preview is also redact+displaySafe'd at the ceremony chokepoint; this is the belt behind that.)
 */
function fieldSummary(entry: string): string {
  const eq = entry.indexOf("=");
  if (eq === -1) return "(malformed --field: missing '=')";
  const key = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  return `${key} (${new TextEncoder().encode(value).length}-byte value)`;
}

/**
 * The PURE M-ceremony preview factory (R-C/R-E): derived ONLY from the parsed input (no wire call, no
 * file read). Shows the method + path + body PROVENANCE (`--input <path>`/stdin, rendered through the
 * ceremony's redact+displaySafe chokepoint) + `--field` KEY NAMES with value LENGTHS — never a body
 * byte, never a query value.
 */
export function makeApiMutationPreview(
  method: ApiMutationMethod,
): (input: unknown) => { title: string; lines: readonly string[] } {
  return (input) => {
    const i = (input ?? {}) as { path?: string; input?: string; field?: string | string[] };
    const path = typeof i.path === "string" ? i.path : "?";
    const bodyLine =
      i.input === undefined
        ? "body: none"
        : i.input === "-"
          ? "body: read from stdin (--input -)"
          : `body: read from the file at --input ${i.input}`;
    const fields = normalizeFields(i.field);
    const queryLine =
      fields.length === 0 ? "query (--field): none" : `query (--field): ${fields.map(fieldSummary).join(", ")}`;
    return {
      title: `api ${method.toLowerCase()}`,
      lines: [`${method} ${path}`, bodyLine, queryLine, "sent through the raw management door — the server owns real plan/apply/confirm gating"],
    };
  };
}

/** Is `v` a JSON container (array or non-null object)? Scalars (string/number/bool/null) are not. */
function isJsonContainer(v: unknown): v is unknown[] | Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/**
 * Would this value LOSE ITS IDENTITY on the canonical re-serialization? `JSON.parse` → IEEE-754
 * double → `JSON.stringify` is lossy at two edges, and both ship SILENTLY REWRITTEN bytes:
 *   • NON-FINITE — an overflow literal (`1e999`) parses to `Infinity`, which `JSON.stringify` emits
 *     as `null`: a different VALUE *and* a different TYPE than the operator wrote;
 *   • UNSAFE INTEGER — above `Number.MAX_SAFE_INTEGER` the double no longer distinguishes adjacent
 *     integers (`9007199254740993` re-serializes as `…992`), so the wire may carry a NEIGHBOURING
 *     number. Every JS double at that magnitude is integer-valued (`Number.isInteger` is true for
 *     `1e308`), so this refuses the whole out-of-safe-range band rather than the digit-spelled part
 *     of it: fidelity is UNPROVABLE from the parsed value alone, and honor-or-reject makes an
 *     unprovable value a loud refusal, never a quiet substitution. Management bodies carry no
 *     legitimate number that large, so nothing real is false-rejected.
 */
function isLossyJsonNumber(value: unknown): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isFinite(value)) return true;
  return Number.isInteger(value) && !Number.isSafeInteger(value);
}

/** STATIC, value-free refusal: the offending NUMBER never appears (a body byte could be a secret). */
function rejectLossyNumber(): never {
  throw new CliLocalError("usage_error", {
    detail: "a JSON number in the --input body cannot be transmitted without loss of precision",
    hint: "express such a value as a JSON string so the exact digits survive the wire",
  });
}

/**
 * Reject a body carrying a number the canonical re-serialization would rewrite, instead of shipping
 * the rewrite (Principle 9 — honor-or-reject; never silently substitute). The re-serialization below
 * is deliberate and load-bearing (the D4 bounds are enforced on the PARSED structure, so that same
 * structure must be what goes on the wire), which is exactly why the lossy number edges have to be
 * refused HERE — neither `JSON.parse` nor `assertJsonWithinBounds` looks at number fidelity.
 *
 * ITERATIVE (explicit stack, never recursion), like the bounds walk it follows: an operator-supplied
 * body can be arbitrarily deep and the checker must not overflow on the very input it exists to
 * reject. It bounds its own work at MAX_JSON_NODE_COUNT — the SAME node cap `assertJsonWithinBounds`
 * enforces, with the same node semantics (the root is 1 node; every array element and every object
 * member VALUE is a node; object KEYS are not) — so it can never become a second unbounded
 * traversal. Callers run the bounds assertion FIRST, so that cap is an unreachable fail-closed
 * backstop rather than a verdict any accepted body meets.
 */
function assertJsonNumbersTransmitLossless(value: unknown): void {
  if (isLossyJsonNumber(value)) rejectLossyNumber(); // a bare number at the root
  if (!isJsonContainer(value)) return;
  let nodeCount = 1; // the root
  const stack: Array<unknown[] | Record<string, unknown>> = [value];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Array.isArray(node)) {
      for (const el of node) {
        nodeCount += 1;
        if (nodeCount > MAX_JSON_NODE_COUNT) breachNodeCount();
        if (isLossyJsonNumber(el)) rejectLossyNumber();
        if (isJsonContainer(el)) stack.push(el);
      }
    } else {
      // Own-property iteration, never `Object.values`: that snapshots every member VALUE of a
      // flat-but-huge body up front — the O(width) allocation the node cap exists to bound — and it
      // does so before the cap has any chance to stop the walk.
      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        nodeCount += 1;
        if (nodeCount > MAX_JSON_NODE_COUNT) breachNodeCount();
        const child = node[k];
        if (isLossyJsonNumber(child)) rejectLossyNumber();
        if (isJsonContainer(child)) stack.push(child);
      }
    }
  }
}

/** The walk's own fail-closed backstop, worded exactly as the D4 node cap it mirrors (still static). */
function breachNodeCount(): never {
  throw new CliLocalError("usage_error", { detail: "the request body exceeds the maximum JSON node count" });
}

/**
 * Assemble the raw request body from `--input` ONLY (C1: `--field` never merges into the body). Reads
 * the out-of-band source through the bounded `readInput` seam (byte-capped), parses it as JSON, and
 * enforces the D4 structural bounds (depth / node-count / key-length / value-length) plus number
 * transmission fidelity BEFORE it is sent — a breach is a static usage_error (the CONTENT never
 * appears in the message). Re-serializes canonically so the bounded, validated structure is EXACTLY
 * what goes on the wire; the fidelity gate is what keeps that canonical form from quietly rewriting
 * an operator's number on the way out (honor-or-reject). Null when no body.
 */
async function assembleApiBody(ctx: Ctx, input: ApiMutationInput): Promise<string | null> {
  if (input.input === undefined) return null;
  const service = requireService(ctx);
  const raw = await service.readInput(input.input); // bounded to MAX_REQUEST_BYTES; missing/oversized → usage_error
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // STATIC: the body CONTENT never appears (a body byte could be a secret).
    throw new CliLocalError("usage_error", {
      detail: "the --input body is not valid JSON",
      hint: "provide a JSON document via --input <file> or --input - (stdin)",
    });
  }
  assertJsonWithinBounds(parsed); // D4 structural caps → static usage_error on breach (never a body byte)
  assertJsonNumbersTransmitLossless(parsed); // honor-or-reject: refuse, never ship, a rewritten number
  return JSON.stringify(parsed);
}

/**
 * Map a raw-door result to the command envelope. A tolerated non-JSON 2xx surfaces its VERBATIM text
 * under `raw_body` + a warning (never re-parsed — C2-b); every other settled send surfaces the
 * classified JSON `body` (null for a 204/empty). The transport `status` rides in `meta`.
 */
export function mapRawResult(result: RawResult): CommandResult {
  if (result.bodyText !== null) {
    return {
      data: { raw_body: result.bodyText },
      meta: { status: result.status },
      warnings: ["the server returned a non-JSON response body; it is shown verbatim under raw_body"],
    };
  }
  return { data: result.body, meta: { status: result.status } };
}

/** Fail closed if the raw wire door is not wired onto this client (a mis-wired shell — requireRuntime peer). */
export function requireRawDoor(ctx: Ctx): NonNullable<Ctx["client"]["raw"]> {
  if (!ctx.client.raw) {
    throw new Error("agkit: internal — this command requires the raw wire door but the client does not provide it");
  }
  return ctx.client.raw;
}

/**
 * The mutation-handler factory. Each of post/put/patch/delete is this handler bound to its method: it
 * asserts the M-direct ceremony pass ran (Seam-1.6), assembles the `--input` body + the `--field`
 * query params, then issues EXACTLY ONE `ctx.client.raw` — no confirm member is ever injected into
 * the request bytes (R57: the server owns real gating), and the Idempotency-Key rides ONLY from the
 * client-wide `--idempotency-key` override (never auto-generated for a raw mutation).
 */
export function makeApiMutationHandler(method: ApiMutationMethod): CommandHandler<ApiMutationInput> {
  return async (ctx, input) => {
    if (ctx.ceremony?.kind !== "proceed") {
      throw new Error(
        `agkit: internal — the api ${method.toLowerCase()} ceremony pass is missing (dispatch hook did not run?)`,
      );
    }
    const raw = requireRawDoor(ctx);
    const bodyBytes = await assembleApiBody(ctx, input);
    const queryFields = normalizeFields(input.field);
    const result = await raw({ method, path: input.path, bodyBytes, queryFields });
    return mapRawResult(result);
  };
}
