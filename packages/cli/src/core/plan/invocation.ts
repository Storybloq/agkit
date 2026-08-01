// The ONE argv→shell encoder for reconstructed invocations (T-212 S5a, canonical L2-CLI-08,
// RC-12). Every place the ceremony reconstructs a command line — the plan.create `note`, a
// non-TTY halt hint, a decline/mismatch re-plan hint — builds it HERE, from a command's
// PER-SPEC PARSED input, so three RC-12 guarantees hold BY CONSTRUCTION:
//
//   1. A confirm value is a PLACEHOLDER, never echoed — the reconstruction reads the spec's
//      `confirm.challenge` (`<project-name>` / `<confirm-string>` / …), never `input.confirm`.
//   2. A secret-prompt flag is ELIDED to `<name>` (a `PromptSpec.secret` value never appears).
//   3. Transport globals (--idempotency-key / --retries / --paginate / output flags) never
//      reproduce — they are stripped before the zod parse, so they are ABSENT from `input`.
//
// Injection safety: every token is POSIX single-quoted when it carries anything outside a
// strict shell-safe set (so `;`, `$( )`, quotes, spaces, the `<…>` placeholder brackets are all
// inert); a control character (CR/LF/NUL/ESC) is REJECTED at the primitive (`quoteToken` throws)
// and ELIDED to `<unprintable>` at the reconstruction layer — the "never crash" contract holds
// while a hostile value can neither inject nor echo.
import type { AnyCommandSpec } from "../../commands/types";
import { isSecretFieldName } from "../output/redaction";

// The set a token may contain and still go UNQUOTED — the standard shell-quote safe class
// (alnum + `-_@%+=:,./`). Anything else (including the placeholder brackets `<>`) forces quoting.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
// C0 controls + DEL — the CR/LF/NUL/ESC hazards RC-12 names. Never safely encodable in a hint.
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

/** A token carrying a control character — refused by the primitive encoder (RC-12 "rejects"). */
export class UnsafeInvocationTokenError extends Error {
  override name = "UnsafeInvocationTokenError";
}

/**
 * POSIX single-quote ONE token for a shell line. A shell-safe token passes through bare (matching
 * the CLI's existing unquoted-hint idiom, e.g. `agkit login`); anything else is single-quoted with
 * the `'\''` escape for an embedded quote. A control char THROWS — it is the one thing quoting
 * cannot neutralize (a raw newline would still break the line; an ESC would still move the cursor).
 */
export function quoteToken(token: string): string {
  if (CONTROL_CHAR.test(token)) {
    throw new UnsafeInvocationTokenError("token carries a control character; refusing to encode");
  }
  if (token.length > 0 && SHELL_SAFE.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/** Join reconstructed argv tokens into ONE `agkit …` line, each token quoted as needed. */
export function encodeShellCommand(tokens: readonly string[]): string {
  return ["agkit", ...tokens].map(quoteToken).join(" ");
}

/** Halt-hint augmentation (RC-6): force the FULL runnable line to include the missing gate flags. */
export interface InvocationOptions {
  /** Append `--yes` (a non-TTY halt always needs it). */
  readonly appendYes?: boolean;
  /** Append `--confirm <placeholder>` when the effective danger is typed (D/PR). */
  readonly appendConfirmPlaceholder?: boolean;
}

/** camelCase → kebab-case for a flag name (`signingKey` → `signing-key`). */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The confirm PLACEHOLDER for a spec — driven by its typed-confirm challenge (never a value). */
function confirmPlaceholder(spec: AnyCommandSpec): string {
  return `<${spec.confirm?.challenge ?? "confirm-string"}>`;
}

/** Elide a control-char value to a fixed placeholder so reconstruction never throws (fail-safe). */
function safeValue(value: string): string {
  return CONTROL_CHAR.test(value) ? "<unprintable>" : value;
}

/**
 * R2-3: render ONE value token. string/number/boolean render (strings through `safeValue`);
 * ANYTHING else — objects, functions, symbols, a hostile custom `toString` — renders the fixed
 * placeholder. `String()` is NEVER called on a non-primitive: a poisoned `toString` could
 * otherwise exfiltrate through the plan.create note / hint channel (or throw mid-ceremony).
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return safeValue(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "<unrenderable>";
}

/** Append a regular `--flag value` (or a bare boolean flag), skipping absent/false values. */
function appendFlag(tokens: string[], key: string, value: unknown): void {
  const flag = `--${kebab(key)}`;
  if (value === true) {
    tokens.push(flag);
    return;
  }
  if (value === false || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    // R2-3: element-wise under the SAME rule — a non-primitive element is the placeholder.
    for (const item of value) tokens.push(flag, renderValue(item));
    return;
  }
  tokens.push(flag, renderValue(value));
}

/**
 * Reconstruct the argv tokens (WITHOUT the leading `agkit`) for a spec + its parsed input.
 * Deterministic (keys sorted); the positional key renders as a trailing bare token; the confirm
 * key renders as `--confirm <placeholder>` (never its value); a secret-prompt key renders as
 * `--flag <name>` (elided). Optionally augments with the non-TTY gate flags (RC-6).
 */
export function toInvocationTokens(
  spec: AnyCommandSpec,
  input: unknown,
  opts: InvocationOptions = {},
): string[] {
  const tokens: string[] = [spec.noun, spec.verb];
  const record: Record<string, unknown> =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const positionalKey = spec.positional?.key;
  const secretKeys = new Set((spec.prompts ?? []).filter((p) => p.secret).map((p) => p.name));
  // T-217 (RR-5d / RA-1): custody-elision keys — their VALUES never reproduce in a
  // reconstruction, independent of the secret-NAME pattern (`--extra-header`/`--endpoint-url`
  // are not secret-named yet must not echo a mistaken-paste secret in any hint).
  const elideKeys = new Set(spec.elideFlags ?? []);

  let positionalToken: string | undefined;
  let hadConfirm = false;
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === positionalKey) {
      if (typeof value === "string") positionalToken = safeValue(value);
      continue;
    }
    if (key === "confirm") {
      // RC-12: the confirm value is a PLACEHOLDER — never echoed. DEFERRED to the tail so the
      // ceremony flag renders last (conventional order), whether it came from input or an append.
      hadConfirm = true;
      continue;
    }
    if (secretKeys.has(key) || isSecretFieldName(key) || elideKeys.has(key)) {
      // RC-12 secret-flag elision (F-D4) + T-217 custody elision (RR-5d/RA-1): a value never
      // appears when its prompt is marked `secret`, its KEY matches the shared secret-field-name
      // policy (the SAME FIELD_NAME_PATTERN the redaction registry masks by), OR its key is in the
      // spec's `elideFlags`. A repeated flag (scalar-or-array) collapses to ONE `<flag>` marker
      // regardless of occurrence count — the value never iterates.
      tokens.push(`--${kebab(key)}`, `<${kebab(key)}>`);
      continue;
    }
    appendFlag(tokens, key, value);
  }
  // Order: regular flags, positional, then the ceremony gate flags (--yes, --confirm) at the tail.
  if (positionalToken !== undefined) tokens.push(positionalToken);
  if (opts.appendYes) tokens.push("--yes");
  if (hadConfirm || opts.appendConfirmPlaceholder) tokens.push("--confirm", confirmPlaceholder(spec));
  return tokens;
}

/**
 * The full `agkit …` line for a spec + parsed input (the plan.create note; a decline/mismatch
 * re-plan hint). Confirm/secret channels are placeholders; a hostile value is quoted inert or
 * elided — this NEVER throws (the note/hint path must never crash the ceremony).
 */
export function reconstructInvocation(spec: AnyCommandSpec, input: unknown): string {
  return encodeShellCommand(toInvocationTokens(spec, input));
}
