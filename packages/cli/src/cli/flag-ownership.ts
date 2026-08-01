// Flag OWNERSHIP (T-279 deliverable 4 support). One answer to the question "whose
// flag is this?" — the shell's, the serializer's, or the command's.
//
// WHY THIS MODULE EXISTS. A command's zod `args` is `.strict()`, so the shell must
// remove every flag it owns before validating a command's input (`--json` is the
// serializer's, `--profile` the context resolver's, `--yes` the ceremony's). That
// strip rule used to live inside `build-cli.ts` over three tables sourced from three
// different modules, which made it unreachable from anywhere else. The README drift
// check has to reproduce the SAME normalization to validate a documented invocation —
// `agkit init run --yes` is a correct, shipped command whose `--yes` is stripped before
// `initRunArgs` (which is `.strict()` and has no `yes`) ever sees it. Reproducing the
// rule instead of sharing it is exactly the drift the drift-check exists to prevent.
//
// WHY IT IS A LEAF — AND WHY IT NOW IMPORTS NOTHING AT ALL (ISS-226). It used to import
// `CLIENT_FLAGS` from `commands/vocab`. That single edge is what forced the arity table
// below to live somewhere else, because `vocab`'s own tokenizer is the FIRST consumer that
// needs it and `vocab -> flag-ownership -> vocab` is a cycle. `CLIENT_FLAGS` therefore MOVED
// here (vocab re-exports it, so no consumer's import path changed — the same move
// `GLOBAL_OUTPUT_FLAGS` made out of `core/output/config.ts`), leaving this module a true
// graph SINK that every layer may read: `commands/vocab`, `core/output/config`,
// `core/client/flags`, `cli/positional`, `cli/build-cli` and the README drift check.
//
// `stripGlobalFlagInput` is generic over the value type so this module needs no
// `FlagValue` import; callers instantiate it with their own value type.

/**
 * Global OUTPUT flag names — the serializer's, never a command's. Stripped from a
 * command's own `.strict()` input. Moved here from `core/output/config.ts` (which now
 * re-exports it) so the strip rule can be expressed without importing the output layer.
 */
export const GLOBAL_OUTPUT_FLAGS = [
  "json",
  "jq",
  "template",
  "compact",
  "no-color",
  "color",
  "verbose",
] as const;

/**
 * Global CONTEXT selectors (T-208): the precedence resolver's top layer. Registered
 * globally (documented in `--help`) + stripped from a command's own `.strict()` input.
 *
 * Exported (it was private to `build-cli`) because it was already being hand-copied as
 * bare string literals into the completion generator's flag set — behavior was correct,
 * but a third context flag would have silently missed shell completions. One table now.
 */
export const CONTEXT_FLAGS = ["profile", "project"] as const;

/**
 * Client-behavior + ceremony flag names (T-211/T-212) that register GLOBALLY and are stripped from a
 * command's own `.strict()` input. MOVED here from `commands/vocab.ts` (ISS-226) so this module owns
 * ALL THREE shell-owned tables and can therefore state their ARITY without importing anything —
 * vocab re-exports it, so the shell (`build-cli` strip set) and the completion generator (T-222
 * step 9) keep reading the SAME list from the same specifier. `--retries`/`--cursor` are re-read
 * from raw argv; `--yes`/`--plan-only` are the ceremony flags.
 */
export const CLIENT_FLAGS = ["retries", "idempotency-key", "paginate", "yes", "plan-only"] as const;

export const GLOBAL_OUTPUT_FLAG_SET: ReadonlySet<string> = new Set(GLOBAL_OUTPUT_FLAGS);
export const CONTEXT_FLAG_SET: ReadonlySet<string> = new Set(CONTEXT_FLAGS);
export const CLIENT_FLAG_SET: ReadonlySet<string> = new Set(CLIENT_FLAGS);

// ── flag ARITY (ISS-226) ─────────────────────────────────────────────────────────────
//
// WHY THIS TABLE EXISTS, AND WHY IT IS A TYPE-EXHAUSTIVE `Record` RATHER THAN A LIST.
// `parseFlagTokens` was unconditionally value-greedy: ANY `--flag` followed by a non-`--`
// token swallowed it. yargs is NOT — it knows `--verbose` is boolean and `--json` is a
// string — so the two layers DISAGREED, and every walk that "shares the consumption rule"
// with `parseFlagTokens` (the positional walk, the client-flag guards, the README drift
// check) inherited the wrong answer. ISS-226 is the bug that disagreement produced.
//
// The FIRST attempt at a fix was a hand-maintained literal — `BOOLEAN_SWALLOW_FLAGS =
// ["compact","verbose","color","no-color"]` in `cli/positional.ts`. It drifted: it omitted
// `json`, `paginate`, `yes` and `plan-only`, so the guard it gated never fired for them.
// That is the SAME defect class T-279 already fixed once here (the completion generator's
// hand-copied `flagKeys.add("profile"); flagKeys.add("project")`, which became
// `CONTEXT_FLAGS`). A second hand-maintained copy of a table we already own is not a fix,
// so arity is DERIVED: `ShellOwnedFlagName` is the union of the three tuples above, and a
// `Record` over it makes an unclassified flag a COMPILE error — a new entry in any tuple
// cannot reach the shell until someone states, here, whether it takes a value. The runtime
// EXHAUSTIVENESS PIN (`flag-arity.test.ts`) asserts the same partition and, independently,
// that every row matches the `type:` build-cli actually registers with yargs.
//
// ARITY IS READ OFF THE YARGS REGISTRATION, NEVER OFF THE FLAG'S NAME. `--json` LOOKS
// boolean and is not: it is registered `type: "string"` because it doubles as `--json a,b`
// field selection (`agkit version --json version` is a shipped, hint-advertised invocation),
// so it consumes the next token exactly like `--profile` does.

/** Whether a shell-owned flag consumes the following token in the space-separated form. */
export type FlagArity = "boolean" | "value";

/** Every flag name the shell owns — the union of the three tables above. */
export type ShellOwnedFlagName =
  | (typeof GLOBAL_OUTPUT_FLAGS)[number]
  | (typeof CONTEXT_FLAGS)[number]
  | (typeof CLIENT_FLAGS)[number];

/**
 * The arity of every shell-owned flag. EXHAUSTIVE by type: a flag added to
 * `GLOBAL_OUTPUT_FLAGS` / `CONTEXT_FLAGS` / `CLIENT_FLAGS` without a row here fails `tsc`.
 * Each row's authority is the `.option(...)` call in `build-cli.ts#registerGlobalOutputFlags`:
 *   • `type: "string"`  -> "value"   (json, jq, template, profile, project, retries, idempotency-key)
 *   • `type: "boolean"` -> "boolean" (compact, verbose, color, paginate, yes, plan-only)
 *   • `no-color` is yargs' automatic negation of the boolean `color`, hence boolean.
 */
export const SHELL_FLAG_ARITY: Readonly<Record<ShellOwnedFlagName, FlagArity>> = Object.freeze({
  // --- GLOBAL_OUTPUT_FLAGS
  json: "value", // `.option("json", { type: "string" })` — `--json a,b` selects data fields
  jq: "value", // `.option("jq", { type: "string" })` — the jq expression
  template: "value", // `.option("template", { type: "string" })` — the template string
  compact: "boolean", // `.option("compact", { type: "boolean" })`
  "no-color": "boolean", // yargs' negation of the boolean `color`
  color: "boolean", // `.option("color", { type: "boolean" })`
  verbose: "boolean", // `.option("verbose", { type: "boolean" })`
  // --- CONTEXT_FLAGS
  profile: "value", // `.option("profile", { type: "string" })`
  project: "value", // `.option("project", { type: "string" })`
  // --- CLIENT_FLAGS
  retries: "value", // `.option("retries", { type: "string" })`
  "idempotency-key": "value", // `.option("idempotency-key", { type: "string" })`
  paginate: "boolean", // `.option("paginate", { type: "boolean" })`
  yes: "boolean", // `.option("yes", { type: "boolean" })`
  "plan-only": "boolean", // `.option("plan-only", { type: "boolean" })`
});

/** The shell-owned flags that take NO value — the set `cli/positional.ts` used to hand-list. */
export const BOOLEAN_SHELL_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(SHELL_FLAG_ARITY)
    .filter(([, arity]) => arity === "boolean")
    .map(([key]) => key),
);

/** The shell-owned flags that DO consume the following token (`--json a,b`, `--profile ci`). */
export const VALUE_SHELL_FLAGS: ReadonlySet<string> = new Set(
  Object.entries(SHELL_FLAG_ARITY)
    .filter(([, arity]) => arity === "value")
    .map(([key]) => key),
);

/** The declared arity of `key`, or `null` when the shell does not own it (a command's own flag). */
export function shellFlagArity(key: string): FlagArity | null {
  return Object.prototype.hasOwnProperty.call(SHELL_FLAG_ARITY, key)
    ? SHELL_FLAG_ARITY[key as ShellOwnedFlagName]
    : null;
}

/**
 * Does a bare `--key` consume the next non-flag token as its value?
 *
 * A KNOWN boolean does not — that is the whole ISS-226 fix. Everything else does, INCLUDING a
 * flag the shell does not own: a command's own options are all registered `type: "string"`
 * (`describeOptions`), so value-greedy is their correct reading and the pre-ISS-226 behavior is
 * preserved exactly for them. Only the shell's own booleans change.
 */
export function flagConsumesValue(key: string): boolean {
  return shellFlagArity(key) !== "boolean";
}

/** True when `key` is owned by the shell or the serializer — i.e. not a command's own. */
export function isShellOwnedFlag(key: string): boolean {
  return GLOBAL_OUTPUT_FLAG_SET.has(key) || CONTEXT_FLAG_SET.has(key) || CLIENT_FLAG_SET.has(key);
}

/**
 * Drop every shell-owned flag from a tokenized command input, leaving only the flags the
 * command's own `.strict()` schema is entitled to see. Pure; the input is not mutated.
 */
export function stripGlobalFlagInput<T>(input: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isShellOwnedFlag(key)) out[key] = value;
  }
  return out;
}

/** A LEADING value-taking flag that ate the command word (`agkit --json apply plan_x`). */
export interface LeadingFlagSwallow {
  /** The flag name WITHOUT `--` (`json`). */
  readonly flag: string;
  /** The command token it consumed as its value (`apply`). */
  readonly token: string;
}

/**
 * ISS-226, the half arity alone cannot fix. A value-taking flag placed BEFORE the command path
 * consumes the command word — `agkit --json apply plan_x` reads as `json="apply"`, leaving
 * `plan_x` as the command, and yargs says `Unknown command: plan_ABC123`, which names the wrong
 * token and teaches nothing. Fixing the arity table cannot help here: `--json` genuinely takes a
 * value, so this parse is CORRECT — it is the user's token ORDER that is wrong.
 *
 * So we detect it and say so. Walk the LEADING flag run only (the region before the first token
 * no flag consumed) and report the first value-taking shell flag whose consumed token
 * `isCommandToken` recognizes as a command head. `--profile ci route list` is untouched (`ci` is
 * not a command head); the walk stops at the first surviving bare token, so a flag AFTER the path
 * is never considered.
 *
 * CALLED ONLY ON A FAILURE PATH (run.ts's `cli.parseAsync()` catch, and the README drift check's
 * unresolved-path branch). That placement is deliberate and load-bearing: a profile legitimately
 * NAMED `version` makes `agkit --profile version route list` dispatch fine, and because yargs
 * never failed we never second-guess it. We only ever improve a message that was already an error.
 */
export function leadingFlagSwallowedCommand(
  argv: readonly string[],
  isCommandToken: (token: string) => boolean,
): LeadingFlagSwallow | null {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) return null; // the command path started — nothing leading left to eat
    if (tok === "--") return null; // the option terminator: everything after it is positional
    if (tok.includes("=")) continue; // `--json=a,b` consumes nothing; keep walking the flag run
    const name = tok.slice(2);
    if (!flagConsumesValue(name)) continue; // a boolean consumes nothing (post-ISS-226 arity)
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) continue; // consumed nothing
    if (isShellOwnedFlag(name) && isCommandToken(next)) return { flag: name, token: next };
    i += 1; // it ate `next` as a legitimate value — skip past it and keep walking the flag run
  }
  return null;
}
