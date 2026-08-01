// T-226 S3b — the PER-CALL context assembly + the DEGRADED-AUTH taxonomy (plan §2 Auth, D0-f).
//
// An MCP server is long-lived and starts with NO credential (plan §2 Boot). Everything a `agkit`
// handler reads off `Ctx` — the typed client, the credential, the effective project — is therefore
// resolved PER TOOL CALL, not once at boot: a `agkit login` (or an `AGKIT_TOKEN` change, or a
// config edit) in the middle of a session must be visible to the NEXT call without restarting the
// server. The one thing that is memoized is the credential read WITHIN a single call: the chain can
// touch the OS keychain and (when configured) the credential helper, and one tool call must never
// pay for that twice — `ctx.credential`, the wire client's bearer and the auth verdict all come
// from ONE resolution.
//
// DEGRADED AUTH IS A RESULT, NOT A CRASH (D0-f). Every way the chain can fail — no credential at
// all, a keychain backend that is not there, a widened/malformed stored record, a helper that
// exits non-zero or times out — is caught HERE and turned into a TYPED failure class. The server
// keeps answering; the tool returns an `[auth_required]` result whose text names BOTH
// non-interactive remedies (`agkit login` for a human at a terminal, `AGKIT_TOKEN` for the server's
// own environment). A thrown `KeychainUnavailableError` escaping into the protocol shell would take
// the whole session down over a missing secret-service — the exact fail-open/fail-loud confusion
// this taxonomy exists to prevent.
//
// NO SUBPROCESS LIVES HERE (D0-f, narrowed ban): this module imports no `node:child_process` and
// spawns nothing. The ONE sanctioned exception — the bounded `AGKIT_CREDENTIAL_HELPER` execution —
// belongs to `core/auth`, behind the injected `resolveCredential` seam below, exactly where the
// CLI's own shell puts it.
import type { CliRuntime, Ctx, ManagementClient } from "../commands/types";
import { NO_PROJECT } from "../commands/types";
import type { ClientFlags } from "../core/client/flags";
import type { ResolvedContext } from "../core/config";
import type { OutputConfig } from "../core/output/config";
import { REDACTED, ratifiedValueSpans } from "../core/output/redaction";
// TYPE-ONLY, and therefore erased (`isolatedModules`): the JSON value model the scrub walks belongs
// to the chokepoint that owns serialization. `result.ts` imports the scrub back as VALUES, so this
// edge must stay type-only or the pair becomes a runtime cycle.
import type { JsonObject, JsonValue } from "./result";
import {
  InsecureFilePermissionsError,
  InsecureStorageRefusedError,
  KeychainUnavailableError,
  MalformedCredentialError,
  NO_CREDENTIAL,
  type ResolvedCredential,
} from "../core/auth";

/** Version-fence disposition for ONE call (run.ts `fenceModeFor`, per-tool here). */
export type McpFenceMode = "report" | "throw";

/** What the per-call client is bound to: THIS call's credential memo, replay cell and fence. */
export interface McpClientBinding {
  readonly resolveCredential: () => Promise<ResolvedCredential>;
  readonly replayCell: { current: boolean };
  readonly fence: McpFenceMode;
  /** THIS call's cancellation signal (relay chunk-34): the client builder binds it into its fetch
   *  seam, so a wire request that is in flight when the MCP client cancels the call ABORTS instead
   *  of running to completion. Required (not optional) so a builder cannot forget it exists. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Bind ONE call's cancellation signal into a fetch seam (relay chunk-34). COMPOSED, never
 * replaced: a request that already carries its own signal (a client-internal timeout) keeps it —
 * `AbortSignal.any` fires on whichever aborts first. Pure composition; no I/O happens here.
 */
export function bindCallAbort(
  baseFetch: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): typeof globalThis.fetch {
  if (!signal) return baseFetch;
  return (input, init) =>
    baseFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * Bind ONE call's cancellation signal into a SLEEP seam (relay chunk-34, follow-up). The transport
 * translates an aborted fetch into a RETRYABLE network `TransportError`, so without this the retry
 * engine would re-send the request and wait through backoff AFTER the client already cancelled. An
 * aborted signal rejects the sleep at once — before it starts or mid-backoff — the rejection
 * escapes the retry loop, and the dispatch catch labels the call `[cancelled]`.
 */
export function bindCallSleep(
  baseSleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): (ms: number) => Promise<void> {
  if (!signal) return baseSleep;
  return (ms) => {
    if (signal.aborted) return Promise.reject(callAbortError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(callAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      void baseSleep(ms).then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, reject);
    });
  };
}

/** The platform's own abort shape, so every layer classifies a cancellation the same way. */
function callAbortError(): DOMException {
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * The I/O seams ONE tool call runs over. Everything here is injected so the whole dispatch path is
 * driven deterministically in tests over a recording fetch and a hermetic runtime — the production
 * bindings live in `session.ts`, which is the only module that touches the process.
 */
export interface McpCallSeams {
  /** env / homeDir / cwd / keyring / isTTY / stderr / flags — the local-config runtime seam. */
  readonly runtime: CliRuntime;
  /** The credential chain read. Called AT MOST ONCE per call (memoized below). MAY throw. */
  readonly resolveCredential: () => Promise<ResolvedCredential>;
  /** Build the typed management client for this call, bound to the call's credential memo. */
  readonly createClient: (binding: McpClientBinding) => ManagementClient;
  /** Best-effort REDACTED stderr diagnostics sink. MUST NOT throw. Never receives a raw secret. */
  readonly diagnostic: (text: string) => void;
  /** Wall clock (ms) — the ceremony's expiry boundary and the status probes read it. */
  readonly now: () => number;
  /** The effective profile/project/api_url resolution for this call. MAY throw on a broken config. */
  readonly effectiveContext: () => ResolvedContext;
}

/** The session seam the tool table holds: one `beginCall()` per `tools/call`. */
export interface McpSession {
  beginCall(): McpCallSeams;
}

// ── REQUEST-SCOPED SECRET SUPPRESSION (T-227 S5; plan v2 D0-H finding 8, v4-3) ───────────────────
//
// A tool call may RESOLVE a secret — the `SecretRef` indirection hands back the actual provider
// credential — and from that instant the value exists inside this process. Ticket req 7 is that it
// never appears on ANY surface the call renders: a summary line, a hint, a machine body,
// `structuredContent`, a plan diff, or a stderr diagnostic. The redaction registry cannot do that
// job alone — it recognizes RATIFIED FORMATS, and an arbitrary provider's credential can be any
// shape at all — so the value that was actually resolved rides along and the renderers subtract it
// from their own output.
//
// REQUEST-SCOPED means exactly what it says. There is NO module-level registry here: the set is
// minted by `openMcpCall`, closed over by ONE `SecretSuppression`, reachable only through the
// `McpCall` that call's frames hold, and garbage the moment they unwind. Two calls cannot see each
// other's values because there is no object they both hold, and nothing here is ever written to a
// file, a log, or a result — the ONLY copy is the transient array below.
//
// The renderers consume DATA (a frozen `readonly string[]`), never a callback. `result.ts` does the
// scrubbing with its OWN code, so no caller — not even a buggy one in this repo — can hand the
// chokepoint a "suppressor" that suppresses nothing.
//
// WHY THE PASS LIVES HERE and not beside its only production consumer: `result.ts` sits at the
// CLI's CI-enforced 800-line module cap (eslint `max-lines`, T-204) and this pass is ~90 lines. The
// edge is one-directional and cycle-free at runtime — `result.ts` imports these functions; this
// module imports only the `JsonValue`/`JsonObject` TYPES back, which `isolatedModules` erases.

/**
 * The floor on a suppressible secret, in UTF-8 BYTES (plan v4 item 3). An MCP-resolved secret
 * shorter than this is refused `[validation_failed]` BEFORE the wire, upstream of here, so nothing
 * this short can legitimately reach registration.
 *
 * WHY REGISTERING ONE IS A LOUD FAILURE rather than a quiet acceptance: suppression is a blind
 * substring substitution over every rendered surface. Registering a short, common value ("secret",
 * "1234", "password") would shred unrelated output into `(sensitive)` confetti and destroy the
 * meaning of an answer the caller then acts on — a corrupted result that still reads as an answer.
 * A throw is the honest alternative: the call renders as `[internal_error]` with the detail
 * withheld and a redacted stderr diagnostic, which is a bug report, not a wrong answer (§B-9,
 * honor-or-reject). The bound is on BYTES, matching the wire-side refusal and `result.ts`'s own
 * byte-counted bounds — a char count would let a 6-character multi-byte value through.
 */
export const MIN_SUPPRESSED_SECRET_BYTES = 16;

/**
 * Registration below the floor. Deliberately NOT a member of `result.ts`'s `isDomainError` set: it
 * is a wiring bug in this server, never an agent-actionable outcome, so it renders through the
 * unexpected-exception path. The message names the LENGTH and never the value; a non-string
 * registration (only reachable from untyped JS) reports as 0 bytes.
 */
export class SuppressedSecretTooShortError extends Error {
  override name = "SuppressedSecretTooShortError";
  constructor(bytes: number) {
    super(
      `a resolved secret of ${bytes} UTF-8 bytes cannot be suppressed: the floor is ` +
        `${MIN_SUPPRESSED_SECRET_BYTES} bytes, and a shorter value must be refused upstream before ` +
        `it is resolved (the value itself is withheld)`,
    );
  }
}

/** The IMMUTABLE view a renderer consumes: this call's resolved secrets, in registration order. */
export type SuppressedSecrets = readonly string[];

/**
 * The empty view — shared and frozen, so the zero-secret call (every call today, and the
 * overwhelming majority forever) allocates nothing and every scrub short-circuits on it.
 */
export const NO_SUPPRESSION: SuppressedSecrets = Object.freeze([]);

/** ONE call's registry: register while the call runs, snapshot when it renders. */
export interface SecretSuppression {
  /**
   * Register a resolved secret value. Idempotent (a repeat registration is dropped, keeping the
   * per-secret index stable). THROWS `SuppressedSecretTooShortError` below the floor.
   */
  register(value: string): void;
  /** The frozen view the renderers take. Read AT RENDER TIME — a value registered later is in it. */
  suppressed(): SuppressedSecrets;
}

/** Mint ONE call's suppression registry. Called once per `openMcpCall`, never at module scope. */
export function createSecretSuppression(): SecretSuppression {
  const values: string[] = [];
  let view: SuppressedSecrets = NO_SUPPRESSION;
  return {
    register(value: string): void {
      const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
      if (typeof value !== "string" || bytes < MIN_SUPPRESSED_SECRET_BYTES) {
        throw new SuppressedSecretTooShortError(bytes);
      }
      if (values.includes(value)) return;
      values.push(value);
      // Re-frozen on every registration, never mutated in place: a renderer mid-render keeps the
      // exact array it was handed, and no later registration can change what it is scrubbing by.
      view = Object.freeze([...values]);
    },
    suppressed: () => view,
  };
}

/**
 * Mirrors `result.ts`'s `KEY_COLLISION_MARK` — one visibly-synthetic ordinal convention across the
 * whole chokepoint. Duplicated deliberately: importing a VALUE from `result.ts` would turn the
 * ctx↔result edge into a runtime cycle (`result.ts` imports THIS module for the scrub), and the
 * same trade is already made for `setOwn`, which `redaction.ts` and `result.ts` each hold privately.
 */
const KEY_ORDINAL_MARK = "#";

/**
 * The replacement for a suppressed KEY. `REDACTED` alone is not enough in a key position: two
 * DISTINCT secrets appearing as sibling keys would both become `(sensitive)` and one would silently
 * overwrite the other — the member-eating collision `result.ts`'s `allocateKey` exists to prevent.
 * The suffix is the secret's REGISTRATION INDEX, so it is deterministic, stable for a given result,
 * identical everywhere that secret appears, and says nothing about the value. VALUES keep the bare
 * `REDACTED`: distinguishing them buys nothing and would leak which secret landed where.
 */
function suppressedKeyMark(index: number): string {
  return `${REDACTED}${KEY_ORDINAL_MARK}${index + 1}`;
}

/** One maximal run of secret-covered text in the ORIGINAL string (`end` exclusive). */
interface SecretSpan {
  start: number;
  end: number;
  /** Registration index of the span's earliest-starting occurrence (ties: lowest index). */
  index: number;
}

/**
 * Every occurrence of every registered secret in `text`, merged into maximal non-overlapping
 * spans. The scan runs over the PRISTINE input — never over partially-substituted text — because
 * sequential replacement is exactly what leaks (S8 relay fold, chunk 24): two secrets that OVERLAP
 * without containment (`AAAA…x` then `xBBBB…`) share bytes, so substituting the first destroys the
 * second's only match and strands all but its overlapped bytes on the surface. Merged spans remove
 * the ordering question entirely — containment, self-overlap (a periodic secret matching itself)
 * and boundary overlap all collapse into one covered range, replaced once.
 *
 * STREAMING, NEVER MATERIALIZED. This runs BEFORE the caps (scrub-then-cap is the leak-safety
 * order), so `text` can be arbitrarily long and both it and the secrets are data we did not
 * author. Collecting every occurrence and sorting would allocate one record per input position on
 * a periodic input — an amplification a hostile body should not be able to buy. Instead each
 * secret keeps ONE cursor (its next pending occurrence); each round consumes the globally earliest
 * pending occurrence (ties: lowest registration index), which either extends the open span in
 * place or starts a new one — so consumption is position-ordered by construction and merging only
 * ever touches the LAST span. Memory is O(merged spans + secrets); there is no sort.
 *
 * The cursor jump is what keeps a periodic run cheap: after consuming an occurrence, the next one
 * that could matter must END beyond the covered end — anything starting at or before
 * `coveredEnd − length` lies wholly inside the covered span and is skipped without being visited.
 * An occurrence found past that bound either extends the span (start < coveredEnd) or begins a
 * new one, so each secret makes at most one no-op pick per span.
 */
function suppressionSpans(text: string, suppressed: SuppressedSecrets): SecretSpan[] {
  const next: number[] = suppressed.map((secret) => text.indexOf(secret));
  const spans: SecretSpan[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i]! !== -1 && (pick === -1 || next[i]! < next[pick]!)) pick = i;
    }
    if (pick === -1) return spans;
    const secret = suppressed[pick]!;
    const start = next[pick]!;
    const end = start + secret.length;
    const last = spans[spans.length - 1];
    if (last !== undefined && start < last.end) {
      if (end > last.end) last.end = end;
    } else {
      spans.push({ start, end, index: pick });
    }
    const coveredEnd = spans[spans.length - 1]!.end;
    next[pick] = text.indexOf(secret, Math.max(start + 1, coveredEnd - secret.length + 1));
  }
}

/**
 * The FINAL replaced regions: registered-secret occurrences UNIONED with every ratified-format
 * span they touch, transitively (S8 relay, chunk 31 round 2).
 *
 * The two match families can overlap in either direction. A registered secret EMBEDDING a
 * `mgmt_*` run is handled by scrubbing before redaction — but a registered value that is a
 * SUBSTRING of a full ratified token would then break THAT token's pattern before `redactText`
 * could see it, stranding the token's own prefix and suffix. Neither pass may fragment the
 * other's match, so any ratified span connected to a registered occurrence (through overlap
 * chains — two ratified spans can overlap each other) joins ONE replaced region. Ratified spans
 * touching NO registered secret are dropped here and left to the redaction registry, which keeps
 * its own affordances (the Authorization partial mask, shown-once) intact everywhere the hazard
 * does not exist.
 *
 * The sweep is a sorted interval merge over two already-bounded lists (merged suppression spans +
 * non-overlapping-per-pattern ratified matches) — no per-position blowup (the chunk-24 bound).
 */
function secretSpans(text: string, suppressed: SuppressedSecrets): SecretSpan[] {
  const secrets = suppressionSpans(text, suppressed);
  if (secrets.length === 0) return secrets;
  const ratified = ratifiedValueSpans(text);
  if (ratified.length === 0) return secrets;

  const tagged = [
    ...secrets.map((span) => ({ ...span, secret: true })),
    ...ratified.map((span) => ({ start: span.start, end: span.end, index: -1, secret: false })),
  ].sort((a, b) => a.start - b.start || Number(b.secret) - Number(a.secret));

  const out: SecretSpan[] = [];
  let open: { start: number; end: number; index: number; hasSecret: boolean } | null = null;
  const flush = (): void => {
    if (open !== null && open.hasSecret) out.push({ start: open.start, end: open.end, index: open.index });
  };
  for (const span of tagged) {
    if (open !== null && span.start < open.end) {
      if (span.end > open.end) open.end = span.end;
      if (span.secret && !open.hasSecret) {
        // The component's mark: its earliest-starting registered secret (ties already broken).
        open.hasSecret = true;
        open.index = span.index;
      }
    } else {
      flush();
      open = { start: span.start, end: span.end, index: span.index, hasSecret: span.secret };
    }
  }
  flush();
  return out;
}

/**
 * Substitute every secret-covered span out of ONE string. Plain index arithmetic over the original
 * text, never a `RegExp` built from the needle: that needle is data we did not author, so a pattern
 * from it would be both wrong (metacharacters) and a ReDoS surface. A merged span takes ONE mark —
 * in keyed mode the mark of its earliest-starting secret, which is deterministic and reveals
 * nothing about how many secrets the span covered.
 */
function substitute(text: string, suppressed: SuppressedSecrets, keyed: boolean): string {
  const spans = secretSpans(text, suppressed);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + (keyed ? suppressedKeyMark(span.index) : REDACTED);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Scrub one caller-visible STRING — a summary line, a hint, a stderr diagnostic.
 *
 * Callers MUST apply this BEFORE escaping and capping. `displayCapped` truncates, and truncating a
 * string that still holds a secret leaves a PREFIX of it on the surface that no later exact-match
 * pass could ever find; escaping rewrites control bytes, which would break the match the same way.
 */
export function scrubSecretText(text: string, suppressed: SuppressedSecrets): string {
  if (suppressed.length === 0) return text;
  return substitute(text, suppressed, false);
}

/**
 * Scrub one JSON tree's string VALUES — at any depth, substrings inside longer values — returning
 * a new tree with every KEY verbatim.
 *
 * POSITION IS LOAD-BEARING (S8 relay, chunk 31). This runs on the PRISTINE tree, BEFORE value
 * redaction: `redactText` rewrites ratified-format substrings in place, and a resolved secret that
 * happens to EMBED one (`mgmt_*` needs no boundary at all) would come out of redaction with its
 * middle already replaced — the exact match here then fails and the secret's own prefix and suffix
 * ride to the surface. Same order every text surface already uses (`scrubSecretText` before
 * `redactText`/`displayCapped`): suppression always sees bytes nobody else has rewritten. The KEY
 * half deliberately cannot ride along — `scrubSecretJsonKeys` says why it must run later.
 *
 * EMPTY SET ⇒ THE SAME OBJECT, by reference (`===`). Every call today registers nothing, so the
 * common path must not rebuild, clone or re-key anything: `result.ts` serializes the returned tree
 * ONCE and parses `structuredContent` back out of exactly those bytes, and the CLI/MCP byte-identity
 * golden compares those bytes to the CLI's own. A rebuild on the empty path would put a second
 * document in the middle of that identity for no benefit at all.
 */
export function scrubSecretJsonValues(value: JsonValue, suppressed: SuppressedSecrets): JsonValue {
  if (suppressed.length === 0) return value;
  return scrubTree(value, suppressed, false);
}

/**
 * Scrub one JSON tree's KEYS — collision-safe by registration-index marks — leaving every string
 * VALUE untouched (`scrubSecretJsonValues` already handled those, pristine).
 *
 * POSITION IS LOAD-BEARING, both bounds. AFTER value redaction: `redact` decides whether a value
 * is secret from its KEY NAME (`allocateKey`'s note), so no pass may rewrite keys ahead of it.
 * BEFORE `maskSecretKeys`: that pass rewrites ratified-format substrings inside key names, which
 * would fragment a registered secret in a key position exactly as redaction would in a value
 * position — the scrubbed marks it leaves behind match no ratified format, so running first costs
 * the key-masker nothing.
 *
 * EMPTY SET ⇒ THE SAME OBJECT (see `scrubSecretJsonValues`).
 */
export function scrubSecretJsonKeys(value: JsonValue, suppressed: SuppressedSecrets): JsonValue {
  if (suppressed.length === 0) return value;
  return scrubTree(value, suppressed, true);
}

/**
 * The one walker under both halves. ITERATIVE (the `redaction.ts` / `maskSecretKeys` idiom) — a
 * security pass may never overflow the stack on a pathologically deep body. Its input is already
 * inert JSON data, so there is nothing exotic to guard against and no cycle to detect.
 */
function scrubTree(value: JsonValue, suppressed: SuppressedSecrets, scrubKeys: boolean): JsonValue {
  const holder: { value: JsonValue } = { value: null };
  const stack: Array<{ source: JsonValue; assign: (scrubbed: JsonValue) => void }> = [
    { source: value, assign: (scrubbed) => (holder.value = scrubbed) },
  ];

  while (stack.length > 0) {
    const { source, assign } = stack.pop()!;
    if (typeof source === "string") {
      assign(scrubKeys ? source : substitute(source, suppressed, false));
      continue;
    }
    if (source === null || typeof source !== "object") {
      assign(source);
      continue;
    }
    if (Array.isArray(source)) {
      const out: JsonValue[] = new Array<JsonValue>(source.length);
      assign(out);
      for (let i = source.length - 1; i >= 0; i--) {
        const index = i;
        stack.push({ source: source[i]!, assign: (scrubbed) => (out[index] = scrubbed) });
      }
      continue;
    }
    const out: JsonObject = {};
    assign(out);
    // Keys allocated in FORWARD order (so a collision ordinal lands on the LATER sibling), tasks
    // pushed in REVERSE so they pop front-to-back and the first assignment fixes key order — the
    // `maskSecretKeys` idiom, for the same byte-ordering reason.
    const used = new Set<string>();
    const pairs = Object.entries(source).map(
      ([key, member]) => [scrubKeys ? allocateScrubbedKey(key, suppressed, used) : key, member] as const,
    );
    for (let i = pairs.length - 1; i >= 0; i--) {
      const [outKey, member] = pairs[i]!;
      stack.push({ source: member, assign: (scrubbed) => setOwn(out, outKey, scrubbed) });
    }
  }

  return holder.value;
}

/**
 * This member's key in the scrubbed record: secrets substituted for their indexed marks, then made
 * unique against every key already written to the SAME record. Two secrets that are siblings stay
 * DISTINCT by their marks alone; the ordinal is the backstop for the residual collisions (a literal
 * key that already equals a mark, or two keys whose surrounding text is identical).
 */
function allocateScrubbedKey(key: string, suppressed: SuppressedSecrets, used: Set<string>): string {
  const base = substitute(key, suppressed, true);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${KEY_ORDINAL_MARK}${n}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Create an own enumerable data property — the `result.ts` / `redaction.ts` discipline. Plain
 * assignment would invoke the inherited `__proto__` ACCESSOR for a key of that name, silently
 * DROPPING the member and rewriting the fresh record's prototype with data we did not author.
 * Scrubbed keys are derived from body data, so they take exactly that path.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * WHY the credential could not be used, as a closed vocabulary. The MCP consumer branches on the
 * class; the prose is ours. `no_credential` is the honest "nothing is stored" — every other member
 * means a source EXISTS but could not be read, which is a different remedy.
 */
export type AuthFailureClass =
  | "no_credential"
  | "keychain_unavailable"
  | "insecure_file_permissions"
  | "insecure_storage_refused"
  | "malformed_credential"
  | "credential_source_failed";

export interface AuthResolved {
  readonly ok: true;
  readonly credential: ResolvedCredential;
}
export interface AuthUnavailable {
  readonly ok: false;
  readonly failure: AuthFailureClass;
}
export type AuthState = AuthResolved | AuthUnavailable;

/** One assembled call: the handler context, the auth verdict, and the call's own seams. */
export interface McpCall {
  readonly ctx: Ctx;
  readonly auth: AuthState;
  readonly seams: McpCallSeams;
  /** The replay cell the wire client records `Idempotency-Replayed` into (plan §2 Replay). */
  readonly replay: { current: boolean };
  /**
   * THIS call's secret-suppression registry (T-227 S5). Anything that RESOLVES a secret on this
   * call registers the value here; every renderer takes `secrets.suppressed()` and subtracts it
   * from what it emits. Per-call by construction — see `createSecretSuppression`.
   */
  readonly secrets: SecretSuppression;
}

/** The interactive remedy. A LITERAL of the `[auth_required]` text (plan §2 Auth). */
export const AUTH_LOGIN_LITERAL = "agkit login";
/** The non-interactive remedy — the one an MCP host can actually set. Also a required literal. */
export const AUTH_ENV_LITERAL = "AGKIT_TOKEN";

/** Per-class cause copy. Never carries a path, a token, or any bytes read from a stored record. */
const AUTH_FAILURE_CAUSE: Record<AuthFailureClass, string> = {
  no_credential: "this MCP server has no agkit credential",
  keychain_unavailable: "the OS keychain backend is unavailable, and no other credential source answered",
  insecure_file_permissions: "the stored plaintext credentials file is not 0600-private, so it was refused",
  insecure_storage_refused: "the plaintext credential path is not permitted in this environment",
  malformed_credential: "the stored credential record could not be parsed",
  credential_source_failed: "the credential source failed to produce a credential",
};

/**
 * The `[auth_required]` detail. It MUST carry BOTH literals — a host that cannot run an interactive
 * `agkit login` needs the environment remedy named in the same breath, and an agent reading only
 * this line is the whole audience.
 */
export function authRequiredDetail(failure: AuthFailureClass): string {
  return (
    `${AUTH_FAILURE_CAUSE[failure]}. Run \`${AUTH_LOGIN_LITERAL}\` in a terminal, ` +
    `or set ${AUTH_ENV_LITERAL} in this server's environment and restart it.`
  );
}

/**
 * The output configuration handlers see. `mcp serve` has no stdout envelope to shape (the frames
 * are the protocol's), so this is a fixed, non-interactive, non-color JSON config — and its
 * `shownOnceSecrets` is EMPTY and stays empty: the shown-once disclosure path exists for a human
 * reading one terminal render, never for a tool result that a host may log verbatim.
 */
const MCP_OUTPUT_CONFIG: OutputConfig = Object.freeze({
  mode: "json",
  compact: false,
  color: false,
  verbose: false,
  isTTY: false,
  shownOnceSecrets: [],
});

/** No global client flags ride an MCP call by default; the apply/plan adapters set their own. */
const NO_CLIENT_FLAGS: ClientFlags = Object.freeze({});

/** Classify one credential read. NEVER throws — every failure becomes a typed class. */
async function resolveAuthState(seams: McpCallSeams): Promise<AuthState> {
  let credential: ResolvedCredential;
  try {
    credential = await seams.resolveCredential();
  } catch (err) {
    return { ok: false, failure: classifyCredentialError(err) };
  }
  // An honest "nothing stored" — the chain's own `NO_CREDENTIAL` sentinel, not an error.
  if (credential.source === "none" || credential.token === null || credential.token.length === 0) {
    return { ok: false, failure: "no_credential" };
  }
  return { ok: true, credential };
}

/** Thrown credential-chain failure → its class. The catch-all is deliberate: a source that fails in
 *  a way we have not enumerated is still a degraded session, never a dead server. */
function classifyCredentialError(err: unknown): AuthFailureClass {
  if (err instanceof KeychainUnavailableError) return "keychain_unavailable";
  if (err instanceof InsecureFilePermissionsError) return "insecure_file_permissions";
  if (err instanceof InsecureStorageRefusedError) return "insecure_storage_refused";
  if (err instanceof MalformedCredentialError) return "malformed_credential";
  return "credential_source_failed";
}

/**
 * Assemble ONE call's context. Resolves the credential exactly once, binds the client to that same
 * memo, and reads the effective project from ONE context snapshot.
 *
 * The client is built BEFORE the auth verdict is awaited and is bound to the memo rather than to a
 * resolved value, so a degraded call still has a usable client for the public probes `agkit_status`
 * runs (a `discovery.get` needs no bearer) — with an empty token, never a stale one.
 *
 * NEVER THROWS. A broken config file degrades `ctx.project` to `NO_PROJECT` (the handler that needs
 * one then teaches through `requireProject`); a broken credential source degrades to an auth
 * failure. Both are results.
 */
export async function openMcpCall(
  session: McpSession,
  options: { readonly fence: McpFenceMode; readonly signal?: AbortSignal },
): Promise<McpCall> {
  const seams = session.beginCall();
  let authMemo: Promise<AuthState> | null = null;
  const authOnce = (): Promise<AuthState> => (authMemo ??= resolveAuthState(seams));

  const replay = { current: false };
  const client = seams.createClient({
    // The client's bearer comes from the SAME memo the verdict does — one read, one identity. A
    // degraded call yields `NO_CREDENTIAL`, so the client sends no Authorization header at all.
    resolveCredential: async (): Promise<ResolvedCredential> => {
      const state = await authOnce();
      return state.ok ? state.credential : NO_CREDENTIAL;
    },
    replayCell: replay,
    fence: options.fence,
    signal: options.signal,
  });

  const auth = await authOnce();
  const ctx: Ctx = {
    client,
    output: MCP_OUTPUT_CONFIG,
    credential: auth.ok ? auth.credential : NO_CREDENTIAL,
    project: readProject(seams),
    clientFlags: NO_CLIENT_FLAGS,
    runtime: seams.runtime,
    replay,
  };
  // A FRESH registry per call — the whole request-scoping guarantee in one line. Nothing outside
  // this returned object holds a reference to it, so it cannot outlive the call or reach the next.
  return { ctx, auth, seams, replay, secrets: createSecretSuppression() };
}

/** The effective project for this call, or `NO_PROJECT` when the context cannot be resolved. */
function readProject(seams: McpCallSeams): Ctx["project"] {
  try {
    return seams.effectiveContext().project;
  } catch {
    // A malformed config must not kill the server: the project reads as unset, and any handler
    // that needs one raises the same teachable `requireProject` refusal it would on the CLI.
    return NO_PROJECT;
  }
}
