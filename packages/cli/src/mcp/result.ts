// T-226 S3b / T-227 S1 — `toMcpResult`: THE single chokepoint from any handler result, thrown error
// or diagnostic to the MCP wire (plan §2 Redaction chokepoint / F5, D0-g; T-227 D0-B v2, D0-E v2,
// v3-2, v3-3, v4-3, v4-5).
//
// EVERY byte this server sends in a `tools/call` result is produced here. That is the whole design:
// the redaction pass, the display-safe bounding and the error taxonomy are ONE code path, so there
// is no second way for a handler's data, a server problem body, a thrown message or a stderr line
// to reach a frame. `dispatch.ts` and `tools.ts` never build a `CallToolResult` themselves.
//
// ── THE TWO TIERS (T-227 D0-B v2) ────────────────────────────────────────────────────────────────
// A failure result answers one of two questions, and MCP's `isError` is the only place to say which:
//
//   DOMAIN  (`isError` ABSENT — not `false`): the call happened and produced an outcome an agent is
//           expected to READ and ACT ON — a refused scope, a stale plan, a missing confirm, a
//           degraded credential. Hosts that surface `isError` as a failure banner must not bury
//           these, so the key is omitted entirely rather than set to `false`.
//   INFRA   (`isError: true`): the call did not produce a consumable outcome — a transport failure,
//           a 5xx, a cancellation, a bug in us. Nothing here is actionable from the agent's side.
//
// The partition is ONE table (`MCP_TIER_TABLE`, in the sibling `result-tiers.ts` and re-exported
// from here) with two namespaces — `wire` (the 24 vendored wire codes) and `local` (the closed
// `MCP_RESULT_CLASS_SET`). Two namespaces because the
// SAME NAME means different things on the two sides, and collapsing them would be a lie:
// `confirm_required` MINTED BY US is the local ceremony refusing to send an unconfirmed D/PR
// request (a domain outcome the agent fixes by reading the plan), while `confirm_required`
// ARRIVING FROM THE WIRE means our own adapter sent an unconfirmed request and the server caught it
// — implementation drift, never an agent-actionable outcome (v3-2). Same for `plan_required` and
// `idempotency_key_conflict`.
//
// ── ONE SAFE OBJECT (D0-E v2 + v4-3 + v4-5) ──────────────────────────────────────────────────────
// Every body — success envelope, wire problem, local refusal — goes through ONE constructor:
//   (a) NORMALIZE into inert JSON data: arrays + plain records only, own enumerable data
//       properties, finite numbers. An accessor, a symbol, an own `toJSON`, a cycle, an exotic
//       prototype, a BigInt or a non-finite number is a WIRING BUG (a management-plane body is
//       always plain data) and fails INFRA rather than being silently coerced by `JSON.stringify`.
//   (b) REDACT VALUES through the shared registry, which judges each value by its ORIGINAL key.
//   (c) RENAME secret-bearing KEYS — the half a value-keyed walk steps past — collision-safely, so
//       two secret-shaped sibling keys cannot collapse onto one another and silently drop a member.
//   (d) `JSON.stringify` ONCE (2-space).
//   (e) `structuredContent` = `JSON.parse` of THOSE EXACT BYTES.
// (e) is what makes the two representations identical BY CONSTRUCTION: there is no second
// serialization and no second redaction pass that could diverge from the text a client reads.
//
// (b) BEFORE (c), NEVER THE REVERSE — see `allocateKey`. The value registry decides "is this
// secret?" from the KEY NAME, and masking a secret-shaped key can EAT that name (`sk-` swallows a
// following `_password_`), so renaming first would un-mask the value underneath it.
//
// SECRET SUPPRESSION (T-227 S5, v2 D0-H finding 8). Every renderer takes a trailing `suppressed`
// view: THIS call's RESOLVED secrets, frozen, request-scoped (`ctx.ts` mints the registry and owns
// the pass — this file is at the 800-line cap). SPLIT BY POSITION: string VALUES are scrubbed on
// the PRISTINE tree ahead of (b) — redaction rewrites an embedded ratified token in place, which
// breaks the exact match and strands the secret's own prefix/suffix — KEYS between (b) and (c)
// (`scrubSecretJsonKeys` says why); free text BEFORE the cap. An empty view returns SAME objects.
//
// SCHEMA-VALIDITY IS LOAD-BEARING (mcp.ts file-head): the SDK validates OUR result against
// `CallToolResultSchema` and, on a mismatch, authors its OWN `-32602` error — which would travel to
// the client WITHOUT passing through this chokepoint. `structuredContent` is a member of that
// schema at SDK 1.30.0 (`z.record(z.string(), z.unknown())`, un-validated without an advertised
// `outputSchema` — D0-D, which is why no `outputSchema` is advertised); everything else stays the
// plainest possible valid shape: `{type:"text", text}` items plus `isError` on the infra path.
//
// TEXT ITEMS. A failure carries the one-line `[class] detail` summary an agent acts on, then — on a
// DOMAIN refusal that HAS a hint — a `Hint: <command>` line from the CLI's own classifier, then the
// machine body. The CANONICAL machine JSON is ALWAYS the LAST item (the `resultBody` convention).
// Success is one item: the JSON document.
//
// WHAT WE NEVER EMIT: the raw text of an UNEXPECTED exception (D0-g — an internal failure's message
// can carry a path, a stack fragment or an unredacted local value, and it is never actionable to
// the caller), and the embedded `plan` a `confirmation_required` halt carries (its `confirm_string`
// is the very challenge the apply gate is refusing to hand over — see `tools.ts`).
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CommandResult } from "../commands/types";
import { buildSuccessEnvelope } from "../core/output/envelope";
import { redact, redactText, containsSecretValue } from "../core/output/redaction";
import { displayCapped } from "../core/output/display";
import { classifyThrownError, safeErrorMessage, isWireCode } from "../core/errors";
import { CliLocalError, WireProblemError, PreClassifiedError } from "../core/errors";
import { NO_SUPPRESSION, scrubSecretJsonKeys, scrubSecretJsonValues, scrubSecretText } from "./ctx";
import type { SuppressedSecrets } from "./ctx";
import { UnknownFieldError } from "../core/output/project";
import { OutputFlagError } from "../core/output/config";
import {
  InsecureFilePermissionsError,
  InsecureStorageRefusedError,
  KeychainUnavailableError,
  MalformedCredentialError,
} from "../core/auth";

/** Bound on the one-line summary. Escaping grows a string, so the cap is applied AFTER it. */
export const MAX_SUMMARY_CHARS = 512;
/**
 * Bound on the JSON body, in UTF-8 BYTES. A management page is comfortably inside it; anything
 * larger is refused WHOLE (below) rather than truncated — half a JSON document is not a smaller
 * answer, it is an unparseable one, and the transport's own 1 MiB frame cap is not a content policy.
 *
 * BYTES, not `String.length` (S1 review, leak lens). The two differ by up to 3x on non-BMP text, so
 * a char-counted bound would let a body of emoji reach ~1 MiB on the wire while reporting "262144
 * bytes" to the caller — both a real overrun of the S2 frame budget and a §B-9 label-by-reality
 * violation, since the refusal text quotes the number as a byte count.
 */
export const MAX_BODY_BYTES = 262_144;

/** The body's size as the wire will actually carry it. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ── the ratified vocabulary + tier partition ─────────────────────────────────────────────────────
// Split into `result-tiers.ts` (T-204 800-line cap). RE-EXPORTED here so every consumer keeps
// importing the taxonomy from `./result` — the split moved bytes, not the public surface.
import {
  AUTH_REQUIRED,
  CLI_LOCAL_ABSORPTIONS,
  INTERNAL_ERROR,
  MCP_TIER_TABLE,
  RESPONSE_TOO_LARGE,
  isMcpResultClass,
  type McpResultClass,
  type McpTier,
} from "./result-tiers";

export {
  MCP_RESULT_CLASS_SET,
  isMcpResultClass,
  AUTH_REQUIRED,
  CANCELLED,
  CONFIRM_REQUIRED,
  CONFIRM_MISMATCH,
  PLAN_STALE,
  CLIENT_UPGRADE_REQUIRED,
  INTERNAL_ERROR,
  RESPONSE_TOO_LARGE,
  MCP_TIER_TABLE,
  CLI_LOCAL_ABSORPTIONS,
  type McpResultClass,
  type McpTier,
  type McpTierSpec,
} from "./result-tiers";

// ── the safe-object constructor (D0-E v2 + v4-3 + v4-5) ──────────────────────────────────────────

/** A JSON body value — what the canonical machine text item serializes. */
export type ResultBody = Record<string, unknown>;

/** The closed JSON value model the safe object is normalized into. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object — the only shape a `structuredContent` may take. */
export type JsonObject = { [key: string]: JsonValue };

/** The bytes + the parsed-back object, produced together and never separately. */
interface SafeJson {
  readonly text: string;
  readonly object: JsonObject;
}

/**
 * The value was not inert JSON data. v4-3 ratifies this as an INFRA failure: a management-plane
 * envelope is always plain data, so an exotic value is a WIRING BUG, and coercing it (as
 * `JSON.stringify` silently would — `NaN`→`null`, a `toJSON` rewrite, an array hole→`null`) would
 * publish bytes nobody authored.
 */
class InertValueError extends Error {
  override name = "InertValueError";
  constructor(reason: string) {
    super(`the result value is not inert JSON data: ${reason}`);
  }
}

/**
 * The per-value inertness policy. `{handled:true}` for a value decided in place; `{handled:false}`
 * for a plain container the walk must descend into. THROWS for anything that is not inert.
 */
function inertLeaf(value: unknown): { handled: true; value: JsonValue } | { handled: false } {
  if (value === null) return { handled: true, value: null };
  switch (typeof value) {
    case "string":
      return { handled: true, value };
    case "boolean":
      return { handled: true, value };
    case "number":
      if (!Number.isFinite(value)) throw new InertValueError("a non-finite number");
      return { handled: true, value };
    case "bigint":
      throw new InertValueError("a BigInt");
    case "symbol":
      throw new InertValueError("a symbol");
    case "function":
      throw new InertValueError("a function");
    case "undefined":
      throw new InertValueError("an undefined array element");
    default:
      break;
  }
  const object = value as object;
  const proto: unknown = Object.getPrototypeOf(object);
  const isArray = Array.isArray(object);
  if (isArray) {
    if (proto !== Array.prototype) throw new InertValueError("an exotic array prototype");
    // A sparse array, or an array carrying own non-index properties: `JSON.stringify` would drop
    // the properties and turn every hole into `null`. Both are silent rewrites — refuse instead.
    if (Object.keys(object).length !== (object as unknown[]).length) {
      throw new InertValueError("a sparse or property-bearing array");
    }
  } else if (proto !== Object.prototype && proto !== null) {
    throw new InertValueError("an exotic prototype");
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw new InertValueError("own symbol properties");
  }
  if (Object.prototype.hasOwnProperty.call(object, "toJSON")) {
    throw new InertValueError("an own toJSON");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      throw new InertValueError("an accessor property");
    }
  }
  return { handled: false };
}

/**
 * Create an own enumerable data property (after-S2 relay finding). Plain assignment would invoke
 * the inherited `__proto__` ACCESSOR for a key of that name — silently DROPPING the member from
 * the output and rewriting the fresh record's prototype with caller-controlled data. `JSON.parse`
 * creates `__proto__` as an ordinary own key (CreateDataProperty), so a server body can
 * legitimately carry one, and the no-silent-rewrite guarantee covers it like any other member.
 * Every record rebuild in this file writes through here; array index writes are unaffected.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The key-collision mark. Redaction can map two DISTINCT sibling keys onto the same masked name;
 * writing both would silently drop one (last write wins), so the second and later get a stable
 * ordinal suffix. Chosen to be visibly synthetic — a real management field never contains it.
 */
const KEY_COLLISION_MARK = "#";

/**
 * Allocate this member's key in the output record: the redacted form of the key (a secret can
 * arrive in a KEY position exactly as it can in a value), made collision-safe against every key
 * already written to the SAME record.
 *
 * ORDERING IS LOAD-BEARING (S1 review, leak lens). This runs AFTER value redaction, never before.
 * `redact` decides whether a value is secret by testing its KEY against `FIELD_NAME_PATTERN`, and
 * `redactText` can DESTROY that signal: the provider-key pattern is `sk-[A-Za-z0-9_-]{20,}`, whose
 * class contains `_`, so a key like `sk-abcdefghij_password_klmnopqrst` collapses WHOLE to
 * `(sensitive)` — the `password` that would have masked the value is eaten by the mask. Rewriting
 * first therefore un-masks the value under that key. Redact on the ORIGINAL keys, rename after.
 */
function allocateKey(key: string, used: Set<string>): string {
  const base = containsSecretValue(key) ? redactText(key) : key;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${KEY_COLLISION_MARK}${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** One container frame of the normalization walk. */
interface InertFrame {
  readonly source: object;
  readonly isArray: boolean;
  /** Own enumerable string keys, in insertion order (records only). */
  readonly keys: readonly string[];
  readonly outArray: JsonValue[] | null;
  readonly outRecord: JsonObject | null;
  index: number;
}

/**
 * Step (a): normalize `root` into inert JSON data, keeping every key VERBATIM (secret-bearing keys
 * are renamed later — see `allocateKey`'s ordering note). ITERATIVE (the `redaction.ts` idiom) — a
 * security chokepoint may never overflow the stack on a pathologically deep body. Cycles are
 * detected with an explicit ancestor set, so a DAG (the same object referenced twice,
 * non-cyclically) is fine and only a true back-edge fails.
 */
function normalizeInert(root: unknown): JsonValue {
  const rootLeaf = inertLeaf(root);
  if (rootLeaf.handled) return rootLeaf.value;

  const ancestors = new Set<object>();
  const stack: InertFrame[] = [];
  const holder: { value: JsonValue } = { value: null };

  const descend = (source: object, assign: (value: JsonValue) => void): void => {
    if (ancestors.has(source)) throw new InertValueError("a cycle");
    ancestors.add(source);
    if (Array.isArray(source)) {
      const out: JsonValue[] = [];
      assign(out);
      stack.push({ source, isArray: true, keys: [], outArray: out, outRecord: null, index: 0 });
      return;
    }
    const out: JsonObject = {};
    assign(out);
    stack.push({
      source,
      isArray: false,
      keys: Object.keys(source as Record<string, unknown>),
      outArray: null,
      outRecord: out,
      index: 0,
    });
  };

  descend(root as object, (value) => {
    holder.value = value;
  });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const length = frame.isArray ? (frame.source as unknown[]).length : frame.keys.length;
    if (frame.index >= length) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const i = frame.index;
    frame.index += 1;

    if (frame.isArray) {
      const raw = (frame.source as unknown[])[i];
      const leaf = inertLeaf(raw);
      if (leaf.handled) {
        frame.outArray![i] = leaf.value;
        continue;
      }
      descend(raw as object, (value) => {
        frame.outArray![i] = value;
      });
      continue;
    }

    const key = frame.keys[i]!;
    const raw = (frame.source as Record<string, unknown>)[key];
    // An own member whose value is `undefined` is ABSENT in JSON — dropping it is exactly what
    // `JSON.stringify` does, so this is a normalization, not a silent rewrite.
    if (raw === undefined) continue;
    const leaf = inertLeaf(raw);
    if (leaf.handled) {
      setOwn(frame.outRecord!, key, leaf.value);
      continue;
    }
    descend(raw as object, (value) => {
      setOwn(frame.outRecord!, key, value);
    });
  }

  return holder.value;
}

/**
 * The KEY half of (b), run AFTER value redaction (see `allocateKey`). Rebuilds every record with
 * its keys redacted and made collision-safe, preserving insertion order. Iterative for the same
 * reason the normalizer is; the input is already inert JSON data, so there is nothing exotic to
 * guard against and no cycle to detect.
 */
function maskSecretKeys(root: JsonValue): JsonValue {
  if (root === null || typeof root !== "object") return root;

  const holder: { value: JsonValue } = { value: null };
  const stack: Array<{ source: JsonValue; assign: (value: JsonValue) => void }> = [
    { source: root, assign: (value) => (holder.value = value) },
  ];

  while (stack.length > 0) {
    const { source, assign } = stack.pop()!;
    if (source === null || typeof source !== "object") {
      assign(source);
      continue;
    }
    if (Array.isArray(source)) {
      const out: JsonValue[] = new Array<JsonValue>(source.length);
      assign(out);
      for (let i = source.length - 1; i >= 0; i--) {
        const index = i;
        stack.push({ source: source[i]!, assign: (value) => (out[index] = value) });
      }
      continue;
    }
    const out: JsonObject = {};
    assign(out);
    // Keys are allocated in FORWARD order, so a collision ordinal (`#2`) always lands on the LATER
    // sibling. Tasks are then pushed in REVERSE so they pop front-to-back and the first ASSIGNMENT
    // to `out` fixes byte-identical key ordering — the `redactNode` idiom, for the same reason.
    const used = new Set<string>();
    const pairs = Object.entries(source).map(([key, value]) => [allocateKey(key, used), value] as const);
    for (let i = pairs.length - 1; i >= 0; i--) {
      const [outKey, value] = pairs[i]!;
      stack.push({ source: value, assign: (redacted) => setOwn(out, outKey, redacted) });
    }
  }

  return holder.value;
}

/**
 * THE safe-object constructor. Normalize (keys verbatim) → subtract resolved secrets from string
 * VALUES, pristine (redaction would fragment an embedded ratified token first) → redact VALUES via
 * the one shared registry, judging each value by its ORIGINAL key → subtract resolved secrets from
 * KEYS → rename secret-bearing KEYS → stringify ONCE → parse THOSE BYTES back. `text` and `object`
 * are one document by construction; no step may reorder (`allocateKey`/`scrubSecretJsonKeys`). */
function safeJson(value: ResultBody, suppressed: SuppressedSecrets): SafeJson {
  const inert = scrubSecretJsonValues(normalizeInert(value), suppressed);
  const redacted = maskSecretKeys(scrubSecretJsonKeys(redact(inert) as JsonValue, suppressed));
  const text = JSON.stringify(redacted, null, 2);
  if (typeof text !== "string") throw new InertValueError("the value did not serialize");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InertValueError("the body is not a JSON object");
  }
  return { text, object: parsed as JsonObject };
}

/** `safeJson`, or `null` when the value is not inert (the caller degrades to an INFRA result). */
function trySafeJson(value: ResultBody, suppressed: SuppressedSecrets): SafeJson | null {
  try {
    return safeJson(value, suppressed);
  } catch {
    return null;
  }
}

// ── result rendering ─────────────────────────────────────────────────────────────────────────────

/** The SDK-schema-valid text item. The one content shape this module emits. */
function textItem(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Suppress + redact + escape + bound a caller-visible string. Suppression FIRST — a cap strands a
 *  prefix of any secret still in it, and a prefix is exactly what no exact-match pass can find. */
function bounded(text: string, suppressed: SuppressedSecrets): string {
  return displayCapped(redactText(scrubSecretText(text, suppressed)), MAX_SUMMARY_CHARS);
}

/**
 * The LAST-RESORT infra result: the body could not be normalized into inert JSON data (v4-3). Its
 * own bytes are a module-load constant over a static, secret-free literal, so this path cannot
 * itself fail the thing it is reporting.
 */
const INERT_FAILURE_DETAIL =
  "the tool produced a result value that is not inert JSON data (an exotic prototype, an accessor, an own toJSON, a cycle, a BigInt or a non-finite number); it was discarded rather than serialized — this is a wiring bug in this server";
const INERT_FAILURE_BODY_TEXT = JSON.stringify(
  { code: INTERNAL_ERROR, detail: INERT_FAILURE_DETAIL },
  null,
  2,
);

function inertFailureResult(): CallToolResult {
  return {
    content: [
      textItem(`[${INTERNAL_ERROR}] ${INERT_FAILURE_DETAIL}`),
      textItem(INERT_FAILURE_BODY_TEXT),
    ],
    isError: true,
  };
}

/**
 * Render ONE refusal. `detail` is already bounded; `body` is the FINAL machine body. The tier
 * decides the two things that differ between the sides: whether `isError` exists at all, and
 * whether `structuredContent` rides along.
 */
function renderRefusal(
  label: string,
  tier: McpTier,
  detail: string,
  hint: string | undefined,
  body: ResultBody,
  suppressed: SuppressedSecrets,
): CallToolResult {
  let safe = trySafeJson(body, suppressed);
  if (safe !== null && utf8Bytes(safe.text) > MAX_BODY_BYTES) {
    // Degrade to a minimal body rather than emit an over-bound frame. Whole, not truncated:
    // half a JSON document is not a smaller answer, it is an unparseable one.
    safe = trySafeJson({
      code: label,
      detail,
      truncated: true,
      bytes: utf8Bytes(safe.text),
      limit: MAX_BODY_BYTES,
    }, suppressed);
  }
  if (safe === null) return inertFailureResult();

  const content = [textItem(`[${label}] ${detail}`)];
  // The Hint line is a DOMAIN affordance: it names the next command. An infra failure has no
  // caller-side recovery to name, so it gets no line rather than a misleading one.
  if (tier === "domain" && hint !== undefined && hint.length > 0) {
    content.push(textItem(`Hint: ${bounded(hint, suppressed)}`));
  }
  content.push(textItem(safe.text));

  // DOMAIN: `isError` is ABSENT, not `false` (D0-B v2) — the key never appears on the object.
  return tier === "domain"
    ? { content, structuredContent: safe.object }
    : { content, isError: true };
}

/**
 * A SUCCESS result: the handler's `CommandResult` in the CLI's own success-envelope shape
 * (`{version, data, …}`), redacted and bounded. Reusing `buildSuccessEnvelope` is deliberate — the
 * MCP surface and the CLI surface then describe a result identically, and the shown-once marker is
 * stripped by that same builder (this server never discloses a shown-once secret).
 * `suppressed` (all three entry points) is THIS call's frozen view, `McpCall.secrets.suppressed()`
 * — a trailing SECURITY parameter, never an option member, so no caller object can shadow it. */
export function mcpSuccess(result: CommandResult, suppressed = NO_SUPPRESSION): CallToolResult {
  const safe = trySafeJson(buildSuccessEnvelope(result) as unknown as ResultBody, suppressed);
  if (safe === null) return inertFailureResult();
  const bytes = utf8Bytes(safe.text);
  if (bytes > MAX_BODY_BYTES) {
    return mcpRefusal({
      class: RESPONSE_TOO_LARGE,
      detail: `the result is ${bytes} bytes, over this server's ${MAX_BODY_BYTES}-byte tool-result bound — narrow the request (a smaller page, a single resource) and retry`,
      body: { bytes, limit: MAX_BODY_BYTES },
    }, suppressed);
  }
  return { content: [textItem(safe.text)], structuredContent: safe.object };
}

/** A LOCAL refusal: a class from the CLOSED set, plus the members that class documents. */
export interface LocalRefusalInput {
  /** The MCP-side class. CLOSED — an arbitrary string label can no longer reach a result. */
  readonly class: McpResultClass;
  readonly detail: string;
  /** Extra body members, merged UNDER the `{code, detail}` head. */
  readonly body?: ResultBody;
  /** A runnable recovery command — surfaced as the `Hint:` line on a domain refusal. */
  readonly hint?: string;
}

/**
 * A LOCAL refusal authored by us (auth, the apply gate, a bound, a cancellation) or absorbed from
 * the CLI taxonomy. The body is the documented problem-COMPATIBLE shape `{code, detail, …class
 * body}` (D0-E v2) — distinct from a wire refusal's body, which is the server's own problem.
 */
export function mcpRefusal(opts: LocalRefusalInput, suppressed = NO_SUPPRESSION): CallToolResult {
  const detail = bounded(opts.detail, suppressed);
  // The head is AUTHORITATIVE (relay chunk-24 finding): the summary line and the tier are already
  // derived from `opts.class`, so a body member named `code` or `detail` overwriting the head would
  // make the machine body silently disagree with the text summary — and let an arbitrary string
  // reach the closed `code` slot that `McpResultClass` exists to seal. Head first (the documented
  // key order), extras after, colliding names dropped in the head's favor.
  const body = mergeBody({ code: opts.class, detail }, opts.body);
  if (body === null) return inertFailureResult();
  return renderRefusal(opts.class, MCP_TIER_TABLE.local[opts.class].tier, detail, opts.hint, body, suppressed);
}

/**
 * Merge caller-supplied extra members into a refusal body, SAFELY (relay chunk-25 finding). A
 * bare `Object.entries`/spread over the extras would EVALUATE any enumerable getter before the
 * inert-data guard could inspect it — a throwing getter would escape the refusal path entirely,
 * and a returning one would be silently coerced to its value — and `Object.entries` would DROP
 * own symbols where v4-3 promises a refusal. So the extras are normalized FIRST: `inertLeaf`
 * judges every container by its property DESCRIPTORS before one member is read, which detects an
 * accessor without ever invoking it and refuses symbols/exotics outright. Only the resulting
 * inert record is merged, through `setOwn`. Returns `null` when the extras are not inert — the
 * caller degrades to the last-resort INFRA result, because a body that cannot be merged honestly
 * cannot be emitted at all.
 */
function mergeBody(head: ResultBody, extras: ResultBody | undefined): ResultBody | null {
  if (extras === undefined) return head;
  let inert: JsonValue;
  try {
    inert = normalizeInert(extras);
  } catch {
    return null;
  }
  if (inert === null || typeof inert !== "object" || Array.isArray(inert)) return null;
  for (const [key, value] of Object.entries(inert)) {
    if (key === "code" || key === "detail") continue;
    setOwn(head, key, value);
  }
  return head;
}

/**
 * A WIRE refusal: the server's own problem document rides as the machine body, VERBATIM (redacted),
 * because the RFC 9457 extension members — the exact missing scopes on a 403, the drifted paths on
 * a 409 — are the one thing that fixes the call, and a closed envelope would drop them.
 */
function mcpWireRefusal(
  code: string,
  detail: string,
  hint: string | undefined,
  problem: ResultBody,
  suppressed: SuppressedSecrets,
): CallToolResult {
  const spec = MCP_TIER_TABLE.wire[code];
  const safeDetail = bounded(detail, suppressed);
  // An unplaced wire code is a vendored-table drift the exhaustiveness test exists to prevent; if
  // one ever reaches here at runtime it is NOT a consumable outcome.
  if (spec === undefined) return renderRefusal(code, "infra", safeDetail, hint, problem, suppressed);
  // The classifier's hint wins; the table's is the fallback for rows it has none for (see `hint`).
  return renderRefusal(spec.surfacesAs ?? code, spec.tier, safeDetail, hint ?? spec.hint, problem, suppressed);
}

/**
 * Is this a failure the taxonomy KNOWS — a CLI-local refusal, a server problem, a credential-chain
 * fault, a retry-exhausted transport failure? Those are the caller's business and are rendered with
 * their own teachable detail. Anything else is a bug in us: `mcpThrown` withholds its text (D0-g).
 * `RetryableTransportError` is duck-typed by name exactly as `classifyThrownError` does it (the
 * class lives under `core/client`, which must not be imported from here).
 */
export function isDomainError(err: unknown): boolean {
  return (
    err instanceof CliLocalError ||
    err instanceof WireProblemError ||
    err instanceof PreClassifiedError ||
    err instanceof UnknownFieldError ||
    err instanceof OutputFlagError ||
    err instanceof KeychainUnavailableError ||
    err instanceof InsecureStorageRefusedError ||
    err instanceof InsecureFilePermissionsError ||
    err instanceof MalformedCredentialError ||
    (err instanceof Error && err.name === "RetryableTransportError")
  );
}

/** Options for rendering a thrown value. */
export interface ThrownOptions {
  /**
   * Force a LOCAL class (the apply gate's typed translation supplies its own). CLOSED — the caller
   * may only name a member of `MCP_RESULT_CLASS_SET`.
   */
  readonly classOverride?: McpResultClass;
  /** Extra body members (a plan summary, a challenge) merged over the classified error. */
  readonly body?: ResultBody;
  /** Redacted stderr sink for the internal-error diagnostic. MUST NOT throw. */
  readonly diagnostic?: (text: string) => void;
  /**
   * The scopes the RESOLVED dispatch entry declares. Used ONLY when the server refuses with
   * `scope_insufficient` and does NOT enumerate `missing_scopes` — see `problemBody`.
   */
  readonly expectedScopes?: readonly string[];
}

/**
 * A THROWN failure → a result. The classification is the CLI's own dispatcher, so an MCP consumer
 * and a CLI operator are told the same thing about the same failure, with the same vendored code
 * and hint — the LABEL is that code (or its ratified MCP class), never a re-derived guess.
 *
 * An UNEXPECTED exception (not in the taxonomy) never surfaces its message: the caller gets a
 * bounded `[internal_error]` with the detail withheld, and the operator gets a redacted stderr
 * diagnostic that never rides the wire.
 */
export function mcpThrown(err: unknown, opts: ThrownOptions = {}, suppressed = NO_SUPPRESSION): CallToolResult {
  if (!isDomainError(err)) {
    opts.diagnostic?.(internalDiagnostic(err, suppressed));
    return mcpRefusal({
      class: INTERNAL_ERROR,
      detail:
        "the tool failed with an unexpected internal error; the detail is withheld and was written to this server's stderr",
      body: opts.body,
    }, suppressed);
  }
  const { envelope } = classifyThrownError(err);
  const error = strippedError(envelope.error);
  const detail = typeof error["detail"] === "string" ? error["detail"] : envelope.error.message;
  const hint = typeof error["hint"] === "string" ? error["hint"] : undefined;
  const envelopeCode = envelope.error.code;

  // A caller-supplied class is a TYPED translation of an outcome the caller understands better than
  // the taxonomy does (the apply gate's `plan_stale` / `confirm_*`) — it always renders LOCAL. The
  // classified-error member + the caller's extras go through the SAME safe merge the refusal itself
  // uses (relay chunk-25 finding) — never a bare spread, which would evaluate getters and drop
  // symbols before the inert guard could refuse them. The WIRE path below is untouched: its machine
  // body is the server's problem document, and `opts.body` never rode it.
  if (opts.classOverride !== undefined) {
    const body = mergeBody({ error }, opts.body);
    if (body === null) return inertFailureResult();
    return mcpRefusal({ class: opts.classOverride, detail, hint, body }, suppressed);
  }

  const wireCode = wireCodeOf(err, envelopeCode);
  if (wireCode !== null) {
    const problem = problemBody(err, error, wireCode, opts.expectedScopes);
    return mcpWireRefusal(wireCode, detail, hint, problem, suppressed);
  }
  const body = mergeBody({ error }, opts.body);
  if (body === null) return inertFailureResult();
  return mcpRefusal({ class: localClassFor(envelopeCode), detail, hint, body }, suppressed);
}

/**
 * The VENDORED wire code this failure carries, or null when it is a local one. The PROBLEM's own
 * code wins over the classified envelope's: the `version_unsupported` → `version_skew` translation
 * (problem.ts) rewrites the envelope code, and the MCP tier/label is a property of what the SERVER
 * said, not of how the CLI renderer re-teaches it.
 */
function wireCodeOf(err: unknown, envelopeCode: string): string | null {
  if (err instanceof WireProblemError) {
    const code = err.problem.code;
    if (typeof code === "string" && isWireCode(code)) return code;
  }
  // A `PreClassifiedError` (the allowlisted server-string-dropping rebuild) carries a classified
  // wire code with NO problem document — it is still a wire outcome and takes the wire tier.
  return isWireCode(envelopeCode) ? envelopeCode : null;
}

/** Does the server's problem already enumerate the scopes the caller is missing? */
function enumeratesScopes(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * The machine body of a WIRE refusal: the server's problem document (or, for the allowlisted
 * rebuild that DROPS server strings, the classified error member — which is problem-compatible).
 *
 * ONE addition, on `scope_insufficient` only. The server's `missing_scopes` ride VERBATIM whenever
 * it sends them. When it does not, the caller is otherwise told "insufficient scope" with no way to
 * know which — so the resolved command's OWN declared scopes ride instead, under the deliberately
 * different name `expected_scopes`: it is client-side knowledge of what this operation needs, NOT
 * the server's enumeration of what is missing, and the name must not pretend otherwise (§B-9).
 */
function problemBody(
  err: unknown,
  error: Record<string, unknown>,
  code: string,
  expectedScopes: readonly string[] | undefined,
): ResultBody {
  const body: ResultBody =
    err instanceof WireProblemError ? { ...(err.problem as Record<string, unknown>) } : { ...error };
  if (
    code === "scope_insufficient" &&
    !enumeratesScopes(body["missing_scopes"]) &&
    // The server's document rides VERBATIM. If it authored `expected_scopes` ITSELF, that is the
    // server speaking and our client-side guess must not overwrite it — silently replacing a server
    // statement with a local one is exactly the §B-9 dishonesty the distinct name exists to avoid.
    !Object.prototype.hasOwnProperty.call(body, "expected_scopes") &&
    expectedScopes !== undefined &&
    expectedScopes.length > 0
  ) {
    body["expected_scopes"] = [...expectedScopes];
  }
  return body;
}

/**
 * A LOCAL (non-wire) classified code → its MCP class. A member of the closed set passes through; a
 * CLI-local code that the ratified partition ABSORBS is mapped; anything else is an unmapped code,
 * which means the taxonomy grew a member nobody placed — INFRA, never a domain answer.
 */
function localClassFor(code: string): McpResultClass {
  if (isMcpResultClass(code)) return code;
  const absorbed = CLI_LOCAL_ABSORPTIONS[code];
  if (absorbed !== undefined && absorbed !== null) return absorbed;
  return INTERNAL_ERROR;
}

/**
 * The classified error member, MINUS `plan`. A `confirmation_required` halt embeds the whole plan
 * (that is right for a CLI render, which shows the operator the confirm string they must type), but
 * over MCP the apply gate is REFUSING to disclose that challenge on this leg — dumping the embedded
 * plan would hand it back through the error body and defeat the gate. The apply adapter re-adds a
 * curated, confirm-string-free summary.
 */
function strippedError(error: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "plan") continue;
    setOwn(out, key, value);
  }
  return out;
}

/** The stderr line for an internal error: the class name + a suppressed, redacted, bounded message.
 *  An exception's message is exactly where a resolved secret leaks by accident (an interpolated
 *  request, a parser echo), and stderr is a surface req 7 names — so it is scrubbed here too. */
function internalDiagnostic(err: unknown, suppressed: SuppressedSecrets): string {
  const name = scrubSecretText(err instanceof Error ? err.name : typeof err, suppressed);
  return `agkit mcp: internal error (${displayCapped(redactText(name), 64)}): ${displayCapped(
    redactText(scrubSecretText(safeErrorMessage(err), suppressed)),
    MAX_SUMMARY_CHARS,
  )}\n`;
}

/**
 * A PROTOCOL-level invalid-params fault (D0-g): input that does not satisfy the advertised branch
 * schema. It is an `McpError`, not a result — the call never happened, so there is nothing to
 * report as a tool outcome. The message is redacted + bounded like every other byte we emit,
 * because it echoes attacker-controlled input.
 */
export function invalidParams(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, displayCapped(redactText(message), MAX_SUMMARY_CHARS));
}

/** The unknown-tool fault — the same shape the SDK's own tool host uses (mcp.ts precedent). */
export function unknownTool(name: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `Tool ${displayCapped(redactText(name), 64)} not found`);
}
