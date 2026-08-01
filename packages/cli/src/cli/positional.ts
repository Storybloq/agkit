// The dispatch-side POSITIONAL grammar (T-212), extracted VERBATIM from `build-cli.ts` to keep
// that file under the packages/cli max-lines cap — the `./command-gates` and `./fs-seams`
// precedent. Pure, no I/O; `build-cli.ts` re-exports `applyPositional` so every existing consumer
// (and `positional-grammar.test.ts`) keeps importing it from there.
import type { AnyCommandSpec } from "../commands/types";
import { extractPositional, type FlagValue } from "../commands/vocab";
import { CliLocalError } from "../core/errors";
import { displaySafe } from "../core/output/display";
import { isShellOwnedFlag, shellFlagArity } from "./flag-ownership";

/**
 * The bare shell-owned VALUE flag that ate the token where the positional should have been, or null.
 *
 * ISS-226 REPOINTED THIS GUARD. It used to be gated on `BOOLEAN_SWALLOW_FLAGS = ["compact",
 * "verbose", "color", "no-color"]` — a hand-maintained literal that had already drifted (it omitted
 * `json`, `paginate`, `yes`, `plan-only`) and, worse, was aimed at the wrong flags. A shell-owned
 * BOOLEAN cannot swallow anything any more: `parseFlagTokens`/`bareTokens` read arity from
 * `cli/flag-ownership`, so `agkit apply --verbose plan_x` binds `plan_x` and simply RUNS. The
 * condition the old guard described is now unreachable by construction rather than by error message.
 *
 * What CAN still eat a positional is a flag that genuinely takes a value — `--json` (it doubles as
 * `--json a,b` field selection), `--jq`, `--template`, `--profile`, `--project`, `--retries`,
 * `--idempotency-key`. `agkit apply --json plan_x` parses as `json="plan_x"` with NO positional,
 * and the bare zod "id is required" never mentions where `plan_x` went. So the guard now fires on
 * exactly that class, derived from `SHELL_FLAG_ARITY` — never listed here.
 *
 * F-F3 is unchanged in shape: ONLY the space-separated bare-flag form swallows, so an explicit
 * `=`-form (`--json=id,name`) is a legitimate value and passes through untouched.
 */
function valueFlagAteThePositional(rawArgv: readonly string[]): string | null {
  for (let i = 0; i < rawArgv.length - 1; i++) {
    const tok = rawArgv[i]!;
    const next = rawArgv[i + 1]!;
    if (!tok.startsWith("--") || tok.includes("=") || next.startsWith("-")) continue;
    const name = tok.slice(2);
    if (isShellOwnedFlag(name) && shellFlagArity(name) === "value") return name;
  }
  return null;
}

/**
 * Map the single leftover positional token onto `tokenized[positional.key]` (before the zod
 * parse). ≥2 positionals is an "unexpected argument" usage_error; 0 leaves the key unset so the
 * zod required-key parse teaches — except when a value-taking global flag is what ate it, which
 * gets the teachable message above (ISS-226). F-D1: every echoed token is displaySafe'd — a
 * hostile CR/LF/ESC in an argv token renders visible, never live.
 */
export function applyPositional(
  tokenized: Record<string, FlagValue>,
  spec: AnyCommandSpec,
  positional: { readonly key: string; readonly name: string; readonly optional?: true },
  rawArgv: string[],
): void {
  const positionals = extractPositional(rawArgv, spec);
  if (positionals.length > 1) {
    throw new CliLocalError("usage_error", {
      detail: `unexpected argument '${displaySafe(positionals[1]!)}' — '${spec.noun} ${spec.verb}' takes a single ${positional.name}`,
      hint: `agkit ${spec.noun} ${spec.verb} <${positional.name}>`,
    });
  }
  if (positionals.length === 1) {
    // R20 (RR-4b): a positional token AND the legacy `--<key>` flag both present is a DUAL-SOURCE
    // conflict — ALWAYS a usage_error naming BOTH sources, even when the two values are EQUAL (a
    // script that passes both is confused; honor-or-reject, no "harmless duplicate" carve-out),
    // NEVER the old silent overwrite. Mode-independent (required AND optional-mode). This check
    // precedes `spec.args.parse` and every handler, so zero wire traffic on the error path. F-D1:
    // both echoed values are displaySafe'd — a hostile CR/LF/ESC renders visible, never live.
    const flagValue = tokenized[positional.key];
    if (flagValue !== undefined) {
      const flagStr = Array.isArray(flagValue) ? flagValue.join(",") : String(flagValue);
      throw new CliLocalError("usage_error", {
        detail: `<${positional.name}> was given twice: positional '${displaySafe(positionals[0]!)}' and --${positional.key} '${displaySafe(flagStr)}' — pass exactly one`,
        hint: `agkit ${spec.noun} ${spec.verb} <${positional.name}>`,
      });
    }
    tokenized[positional.key] = positionals[0]!;
    return;
  }
  // Optional-mode 0-token case leaves the key ABSENT (handler fallback runs); required-mode 0-token
  // leaves it absent too so the zod required-key parse teaches — both are the existing no-op path.
  // ISS-226 adds ONE case in front of that: the positional is REQUIRED, was not supplied through the
  // legacy `--<key>` flag either, and a bare value-taking global flag is sitting in front of a bare
  // token. Then the token did not go missing — a flag ate it — and saying so is the whole point.
  if (positional.optional === true || tokenized[positional.key] !== undefined) return;
  const eater = valueFlagAteThePositional(rawArgv);
  if (eater === null) return;
  // TWO honesty constraints shape this message (§B-9):
  //  • It does not ASSERT that the flag ate the positional, because it cannot know. `apply --json
  //    plan_x` and `apply --profile ci` are structurally identical — one is a swallow, the other a
  //    legitimate value plus a forgotten plan-id. So it states the fact (no positional was given)
  //    and the mechanism (this flag consumes the next token), and lets the reader match them. The
  //    remedy is the same either way, which is why one message can serve both.
  //  • F-D2 discipline (core/client/flags.ts): the CONSUMED value is NEVER echoed — a token that
  //    landed in a flag slot is exactly where a mis-pasted secret ends up. Only the flag is named.
  //    (`displaySafe` on the flag name is belt-and-braces; it comes from our own frozen table.)
  throw new CliLocalError("usage_error", {
    detail: `no ${positional.name} was given, and --${displaySafe(eater)} takes a value — it consumes the token that follows it, so put the ${positional.name} FIRST, or use the --${eater}=<value> form`,
    hint: `agkit ${spec.noun} ${spec.verb} <${positional.name}> --${eater} <value>`,
  });
}
