// THE redaction registry (T-205, canonical L2-CLI-03, deliverable 6) — the
// security core of the serializer chokepoint. It runs ONCE, upstream of EVERY
// formatter (json / jq / template / human / verbose), so there is no path by
// which a formatter can observe raw data. A bug here leaks a secret, so the
// registry is deliberately conservative: it fails SAFE (over-masks) rather than
// risk under-masking.
//
// Two orthogonal detectors:
//   1. field-NAME patterns  — mask a value because its KEY names a secret.
//   2. secret-VALUE patterns — mask a value (or a substring of it) because the
//      value ITSELF looks like a concrete secret, regardless of key name. This
//      is what catches a management token — or a provider credential (T-226 D0-j:
//      `sk-ant-*`, `sk-*`, `AIza*`, the formats RULES.md line 7 ratifies) — dropped
//      into an arbitrary field.
//
// One contract-ratified exemption: `ak_pk_live_*` publishable keys are NON-secret
// (printable, writable to app config) and are NEVER masked. One escape hatch: the
// shown-once path (token/publishable-key create) may pass the freshly-minted
// `mgmt_*` value unredacted for exactly one render, gated by an explicit opt-in.

/** The mask marker substituted for a redacted value. */
export const REDACTED = "(sensitive)";

// T-212 D5: the server pre-masks secret-valued plan-diff LEAVES to this exact value
// string before a Plan ever reaches the wire (management-plan.schema.json — diff
// secrets are "(secret)"). It is a VALUE, not a secret-NAMED field, so
// FIELD_NAME_PATTERN never catches it. D5 requires EVERY output mode (json / jq /
// template / human / verbose / error-embedded) to show ONE consistent mask, so the
// chokepoint normalizes the server sentinel to the CLI's own `REDACTED` marker.
export const SERVER_SECRET_SENTINEL = "(secret)";

// deliverable 6: field-NAME patterns. A substring, case-insensitive match — a key
// like `token_count` or `api-key` matches. Over-inclusive ON PURPOSE (fails safe).
//
// T-227 S7 (req 8): the original five name the credential IN FLIGHT. A management body can also
// carry the AT-REST derivatives of one — the `key_hash` a key is stored under, an `encrypted_*`
// envelope, a raw `ciphertext`. None of those is presentable as a credential, but each is
// offline-attackable material (a hash is a verification oracle, a ciphertext is a target), so the
// registry's conservative bias covers them. A MASK-STRENGTHENING addition: three alternatives are
// appended, none of the original five is touched, so the pattern only ever GROWS.
//
// Each addition was probed against the pre-extension pattern first, and only the genuine gaps were
// added: `token_hash` already matched via `token` and is deliberately ABSENT from the new group
// (redaction.test.ts pins it as the negative control). `key[_-]?hash` covers `key_hash` /
// `key-hash` / `keyHash` / `publishable_key_hash`; `encrypted` covers the whole `encrypted_*`
// family (and over-masks an `is_encrypted` boolean — the stated fail-safe bias).
const FIELD_NAME_PATTERN = /secret|token|api[_-]?key|password|authorization|encrypted|ciphertext|key[_-]?hash/i;

/**
 * The shared secret-field-NAME policy (T-212 review round F-D4): does this KEY name a
 * secret? Exported so every value-eliding surface (the argv→shell reconstruction encoder,
 * future preview builders) applies the SAME policy this registry masks by — one pattern,
 * no drift.
 */
export function isSecretFieldName(key: string): boolean {
  return FIELD_NAME_PATTERN.test(key);
}

// deliverable 6: concrete secret-VALUE patterns. `mgmt_` + 43 base62 chars is the
// management-token format. Extend this array as new concrete formats are ratified.
const MGMT_TOKEN_PATTERN = /mgmt_[A-Za-z0-9]{43}/;
// The class-prefixed management tokens (`mgmt_ci_` / `mgmt_at_` / `mgmt_rt_` — an 8-char
// prefix + a 43 base62 body, total 51). The trailing underscore in the prefix breaks the
// legacy pattern's contiguous base62 run, so they would otherwise slip past unmasked
// (mask-STRENGTHENING addition, not a modification of the legacy pattern above).
const MGMT_CLASS_TOKEN_PATTERN = /mgmt_(?:ci|at|rt)_[A-Za-z0-9]{43}/;
/**
 * The MANAGEMENT-token formats ALONE. Kept as its own list because two consumers are about
 * OUR credential specifically, not "any secret": `isMgmtToken` (the token commands' FRESH-mint
 * grammar check) and `maskAuthorization` (whose operator-correlation suffix mask is ratified for
 * management tokens only — every other credential fails safe to a whole-value mask).
 */
const MGMT_VALUE_PATTERNS: readonly RegExp[] = [MGMT_TOKEN_PATTERN, MGMT_CLASS_TOKEN_PATTERN];

// T-226 D0-j: the PROVIDER credential formats RULES.md line 7 ratifies (`sk-ant-*`, `sk-*`) plus
// Google's fixed `AIza` shape. Mask-STRENGTHENING additions to the SAME array every `redact` /
// `redactText` caller already runs through — one policy, no second detector.
//
// Two bounds keep the generic `sk-` entry from eating prose. (i) A MIN-LENGTH body: a bare "sk-"
// or a short id can never match. (ii) A LEFT BOUNDARY: without it every hyphenated word ending in
// `sk` ("task-", "risk-", "disk-") would open a match and mask an operator's own text — a real
// key always starts at a boundary, so the bound costs no coverage. `AIza` needs neither: its
// 4-char prefix + EXACT 35-char body is already unambiguous.
//
// ORDER MATTERS: the `sk-ant-` entry is listed BEFORE the generic `sk-` entry so the most specific
// ratified format is the one that fires, never a leftover of a broader pass.
const ANTHROPIC_KEY_PATTERN = /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/;
const PROVIDER_SK_KEY_PATTERN = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/;
const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/;

const VALUE_PATTERNS: readonly RegExp[] = [
  ...MGMT_VALUE_PATTERNS,
  ANTHROPIC_KEY_PATTERN,
  PROVIDER_SK_KEY_PATTERN,
  GOOGLE_API_KEY_PATTERN,
];

// deliverable 6: `ak_pk_live_*` is a contract-ratified NON-secret — EXEMPT.
const PUBLISHABLE_EXEMPT = /^ak_pk_live_[A-Za-z0-9]+$/;

// Authorization headers get an operator-friendly PARTIAL mask (a short suffix) so
// a `--verbose` trace can correlate which token was used without disclosing it.
const AUTHORIZATION_KEY = /authorization/i;

export interface RedactOptions {
  /**
   * Shown-once allowlist: the EXACT freshly-minted secret value(s) that may pass
   * UNREDACTED for this ONE render (the `token create` / `publishable-key create`
   * path). Redaction is relaxed ONLY for a value that `===` an entry here — every
   * OTHER secret, INCLUDING a different `mgmt_*` token elsewhere in the same
   * envelope, is still masked. Empty/undefined everywhere except that one render.
   */
  shownOnceSecrets?: readonly string[];
}

/** Is `value` an exact freshly-minted secret the caller allowlisted for this render? */
function isShownOnce(value: string, opts: RedactOptions): boolean {
  return opts.shownOnceSecrets?.includes(value) ?? false;
}

/** Is this value a contract-ratified, printable publishable key? */
export function isPublishableExempt(value: string): boolean {
  return PUBLISHABLE_EXEMPT.test(value);
}

/**
 * Does this string contain a concrete management token in ANY ratified format
 * (legacy `mgmt_` or class-prefixed `mgmt_ci_`/`mgmt_at_`/`mgmt_rt_`)? ALL formats
 * share one predicate so every registered format gets identical treatment —
 * including the shown-once escape hatch (a freshly-minted class token must pass a
 * `token create` render exactly like a legacy one would).
 *
 * MANAGEMENT tokens only — this answers "is this OUR credential?" (the `token` commands' mint
 * grammar). "Is this A secret?" is `containsSecretValue`.
 */
export function isMgmtToken(value: string): boolean {
  return MGMT_VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * T-226 D0-j: does this string contain a concrete secret in ANY ratified format — management
 * token OR provider credential? THE value-side policy predicate: the masking branch below, the
 * ceremony's display-is-authority gate, and the raw-plan confirm-string gate all ask THIS, so a
 * newly ratified format is honored everywhere the moment it joins `VALUE_PATTERNS`.
 */
export function containsSecretValue(value: string): boolean {
  return VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * Every ratified-format value match in `text`, as `[start, end)` spans sorted by start.
 *
 * Exported for the suppression engine (`mcp/ctx.ts`): a REGISTERED secret and a ratified-format
 * token can overlap in either direction (a resolved secret embedding a `mgmt_*` run, or a
 * registered value that is a SUBSTRING of a full token), and whichever pass substitutes second
 * would find its match already fragmented by the first. The engine unions any ratified span that
 * touches a registered occurrence into ONE replaced region, so neither pass can strand the other's
 * fragments; ratified spans touching NO registered secret are left for this registry's own
 * substitution, exactly as before. Span count is bounded by `text.length / 23` per pattern (the
 * shortest ratified format) — matches of one pattern never overlap, so there is no blowup here.
 */
export function ratifiedValueSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const re of VALUE_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (let match = global.exec(text); match !== null; match = global.exec(text)) {
      spans.push({ start: match.index, end: match.index + match[0]!.length });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Replace concrete secret substrings inside a free-text string with the mask,
 * preserving surrounding context (used when the VALUE — not the key — is what
 * flags the string). A bare token value collapses entirely to `(sensitive)`.
 */
export function redactText(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(global, REDACTED);
  }
  return out;
}

/**
 * Mask an Authorization header to `Bearer mgmt_************<suffix>` (deliverable
 * 6). Only a short suffix survives — never enough to reconstruct the token.
 */
export function maskAuthorization(value: string): string {
  // Try EVERY ratified management-token format (legacy `mgmt_…` AND the class-prefixed
  // `mgmt_ci_`/`mgmt_at_`/`mgmt_rt_`). The class prefix's trailing underscore breaks the legacy
  // pattern's contiguous base62 run, so keying only on MGMT_TOKEN_PATTERN would over-mask a class
  // token to the WHOLE-value form and lose the which-token-was-used correlation a `--verbose` trace
  // provides for legacy ones — the same partial mask must cover both (T-222 10b-iii).
  //
  // MANAGEMENT formats ONLY (T-226 D0-j): the suffix form is ratified for our own token and its
  // literal `Bearer mgmt_…` rendering would MISLABEL any other credential. A provider key in an
  // Authorization header falls through to the whole-value mask below, as it always has.
  for (const re of MGMT_VALUE_PATTERNS) {
    const match = value.match(re);
    if (match) {
      const suffix = match[0].slice(-4);
      return `Bearer mgmt_************${suffix}`;
    }
  }
  // A non-management Authorization (Basic, an opaque bearer, some other API key):
  // no operator-correlation form is ratified for these, so fail SAFE and mask the
  // WHOLE value. Never leak a suffix of a non-management credential.
  return REDACTED;
}

/**
 * Deep-redact a value (the whole envelope, in practice). Returns a NEW structure;
 * the input is never mutated. This is the single chokepoint every formatter is
 * downstream of.
 *
 * The walk is ITERATIVE (explicit stack, T-222 step 10b / A7c) — never recursion — so the
 * security chokepoint can never overflow on a pathologically deep body even if one slips the
 * client's response-admission depth cap (classify.ts). `redactLeaf` holds the per-value policy
 * (byte-identical to the prior recursive form); the loop only handles container rebuild + descent.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  return redactNode(value, undefined, opts);
}

/** A container-descent task: process (`value`, `key`) and write the result via `assign`. */
interface RedactTask {
  readonly value: unknown;
  readonly key: string | undefined;
  readonly assign: (result: unknown) => void;
}

/**
 * Create an own enumerable data property (after-S2 relay finding). Plain assignment would invoke
 * the inherited `__proto__` ACCESSOR for a key of that name — silently DROPPING the member from
 * the redacted output and rewriting the fresh record's prototype with caller-controlled data.
 * `JSON.parse` creates `__proto__` as an ordinary own key, so a server body can legitimately carry
 * one; the redactor's "input preserved except redactions" contract covers it like any other member.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function redactNode(root: unknown, rootKey: string | undefined, opts: RedactOptions): unknown {
  const holder: { result: unknown } = { result: undefined };
  const stack: RedactTask[] = [{ value: root, key: rootKey, assign: (r) => (holder.result = r) }];
  while (stack.length > 0) {
    const { value, key, assign } = stack.pop()!;
    const leaf = redactLeaf(value, key, opts);
    if (leaf.handled) {
      assign(leaf.value);
      continue;
    }
    // Not handled ⇒ `value` is a container to descend into (a secret-named key would have masked
    // the whole value in `redactLeaf`, so we only reach here for a NON-secret-named container).
    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length);
      assign(out);
      // Push in REVERSE so children pop front-to-back — array index order is irrelevant, but this
      // keeps the descent order deterministic and mirrors the object case.
      for (let i = value.length - 1; i >= 0; i--) {
        const idx = i;
        stack.push({ value: value[i], key: undefined, assign: (r) => (out[idx] = r) });
      }
    } else {
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      assign(out);
      // Push entries in REVERSE so they pop in original insertion order — the first ASSIGNMENT to
      // `out[k]` fixes key order, so this preserves byte-identical JSON key ordering vs the input.
      const entries = Object.entries(source);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        stack.push({ value: v, key: k, assign: (r) => setOwn(out, k, r) });
      }
    }
  }
  return holder.result;
}

/**
 * The per-value redaction policy. Returns `{ handled: true, value }` for a value decided in place
 * (every scalar, and any container masked WHOLE by a secret-named key); returns `{ handled: false }`
 * only for a NON-secret-named container the caller must descend into. Byte-identical to the prior
 * recursive base cases — the ONLY behavioral change from the pre-10b form is the explicit stack.
 */
function redactLeaf(
  value: unknown,
  key: string | undefined,
  opts: RedactOptions,
): { handled: true; value: unknown } | { handled: false } {
  // Exemption wins EVERYWHERE: a publishable key is printable even under a
  // secret-named key (it is a contract-ratified non-secret).
  if (typeof value === "string" && isPublishableExempt(value)) return { handled: true, value };

  // D5 (T-212): normalize the server's diff-secret sentinel to the CLI mask. Exact
  // VALUE match, unconditional — key name and the shown-once allowlist are
  // irrelevant to a literal sentinel (a minted secret is never the string
  // "(secret)"). Fail-safe: a real user string equal to "(secret)" is cosmetically
  // over-masked to "(sensitive)" — the registry's stated conservative bias.
  if (typeof value === "string" && value === SERVER_SECRET_SENTINEL) return { handled: true, value: REDACTED };

  const keyIsSecret = key !== undefined && FIELD_NAME_PATTERN.test(key);

  if (keyIsSecret) {
    // Shown-once: ONLY the exact freshly-minted value the caller allowlisted passes
    // here (e.g. the new token from `token create`). Any other secret-named value —
    // including a DIFFERENT mgmt_* token — is still masked.
    if (typeof value === "string" && isShownOnce(value, opts)) {
      return { handled: true, value };
    }
    if (key !== undefined && AUTHORIZATION_KEY.test(key) && typeof value === "string") {
      return { handled: true, value: maskAuthorization(value) };
    }
    // Fail safe: a secret-named key masks its whole value, whatever the type (incl. a container).
    return { handled: true, value: REDACTED };
  }

  if (typeof value === "string") {
    if (containsSecretValue(value)) {
      // A concrete secret (any ratified format — mgmt_* token or provider key) in ANY field is
      // masked unless it is the EXACT freshly-minted value allowlisted for this render (never a
      // blanket bypass).
      return { handled: true, value: isShownOnce(value, opts) ? value : redactText(value) };
    }
    return { handled: true, value };
  }

  // A NON-secret-named container: the caller descends into it (value-pattern detection still
  // applies to its leaves). Array items carry no key context.
  if (Array.isArray(value)) return { handled: false };
  if (value !== null && typeof value === "object") return { handled: false };

  // number / boolean / null / undefined — passed through untouched.
  return { handled: true, value };
}
