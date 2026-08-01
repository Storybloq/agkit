// Output configuration (T-205, canonical L2-CLI-03). Resolves the global output
// flags (`--json`, `--jq`, `--template`, `--compact`, `--no-color`/`--color`,
// `--verbose`) + `NO_COLOR` env + the TTY seam into ONE `OutputConfig` that the
// serializer chokepoint reads. It is attached to `Ctx.output` by run.ts.
//
// Flag values are tokenized from the RAW argv with the SAME `parseFlagTokens` the
// command shell uses (single tokenizer, no drift). By CLI convention the global
// flags follow the command (e.g. `agkit project list --json name`); a flag placed
// BEFORE the command path would greedily consume the command token, so — like the
// command-input tokenizer already in build-cli.ts — options are options-after-path.
import { parseFlagTokens, type FlagValue } from "../../commands/vocab";

// `auto` is the default when no format flag is given: it resolves to `json` when
// piped (non-TTY, the machine default the pack-smoke asserts) and to `human` in
// an interactive terminal (TTY). `json` FORCES json regardless of the TTY, so its
// bytes are identical TTY vs non-TTY (deliverable 5 / acceptance #1).
export type OutputMode = "auto" | "human" | "json" | "jq" | "template";

export interface OutputConfig {
  /** Format family. `auto` flips json<->human by TTY; `json` is TTY-invariant. */
  mode: OutputMode;
  /** `--json a,b,c` field selection (per-item for lists); undefined = full data. */
  fields?: string[];
  /** `--jq <expr>`. */
  jqExpr?: string;
  /** `--template <tpl>`. */
  templateExpr?: string;
  /** `--compact` — whitespace-stripped JSON. */
  compact: boolean;
  /** Resolved: ANSI color is on (human + TTY + not disabled). */
  color: boolean;
  /** `--verbose` — emit a redacted diagnostic trace on stderr. */
  verbose: boolean;
  /** The TTY seam. Injected in tests; `process.stdout.isTTY` in production. */
  isTTY: boolean;
  /**
   * Shown-once exact-value allowlist for THIS render (default empty; set per-call
   * from a handler's shown-once marker). Only a secret value that `===` an entry
   * is disclosed unredacted — never a blanket bypass.
   */
  shownOnceSecrets: readonly string[];
}

/**
 * Global output flag names — stripped from a command's own input (build-cli.ts).
 *
 * The table itself MOVED to `cli/flag-ownership.ts` (T-279) so the one strip rule can be
 * expressed in a leaf module: this file imports `commands/vocab`, so a strip rule sited
 * in vocab would have closed a `vocab -> core/output/config -> vocab` cycle. Re-exported
 * here — and onward through the `core/output` barrel — so no consumer's import changed.
 */
export { GLOBAL_OUTPUT_FLAGS } from "../../cli/flag-ownership";

/** Thrown for a malformed output flag (e.g. `--jq` with no expression). */
export class OutputFlagError extends Error {
  override name = "OutputFlagError";
}

export interface ResolveInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

export function resolveOutputConfig({ argv, env, isTTY }: ResolveInput): OutputConfig {
  const flags = parseFlagTokens(argv);
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(flags, key);

  let mode: OutputMode = "auto";
  let jqExpr: string | undefined;
  let templateExpr: string | undefined;
  let fields: string[] | undefined;

  // Precedence when several are given: jq > template > json > human (the most
  // specific projection wins). Documented; not an error.
  if (has("jq")) {
    mode = "jq";
    const value = flags["jq"];
    if (typeof value !== "string" || value.length === 0) {
      throw new OutputFlagError("--jq requires an expression, e.g. --jq '.data'");
    }
    jqExpr = value;
  } else if (has("template")) {
    mode = "template";
    const value = flags["template"];
    if (typeof value !== "string" || value.length === 0) {
      throw new OutputFlagError("--template requires a template, e.g. --template '{{.id}}'");
    }
    templateExpr = value;
  } else if (has("json")) {
    mode = "json";
    const value = flags["json"];
    // bare `--json` (boolean true) = full envelope; `--json a,b` = field select.
    if (typeof value === "string" && value.length > 0) {
      fields = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }

  const compact = has("compact") && flags["compact"] !== "false";
  const verbose = has("verbose") && flags["verbose"] !== "false";
  // Color only ever applies to human rendering, which (from this resolver) only
  // happens in `auto` mode on a TTY. It is never emitted in json/jq/template.
  const color = isTTY && mode === "auto" && !isColorDisabled(flags, has, env);

  return { mode, fields, jqExpr, templateExpr, compact, color, verbose, isTTY, shownOnceSecrets: [] };
}

function isColorDisabled(
  flags: Record<string, FlagValue>,
  has: (key: string) => boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  // `NO_COLOR` (no-color.org): a non-empty value disables color.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  // `--no-color`, or the yargs negation `--color=false`.
  if (has("no-color") && flags["no-color"] !== "false") return true;
  if (has("color") && flags["color"] === "false") return true;
  return false;
}

/** A plain auto config — the fallback used to render an output-flag error. */
export function defaultOutputConfig(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): OutputConfig {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  return {
    mode: "auto",
    compact: false,
    color: isTTY && !noColor,
    verbose: false,
    isTTY,
    shownOnceSecrets: [],
  };
}

/**
 * The `--json` pre-sniff (T-207, canonical L2-CLI-04, deliverable 6). Detects a
 * bare `--json` (or `--json=…`) directly in the RAW argv, WITHOUT running the full
 * `resolveOutputConfig` tokenizer. Its job is narrow but important: if arg parsing
 * fails BEFORE a config is built (e.g. a malformed `--jq` makes `resolveOutputConfig`
 * throw), the catch path can still honor the user's `--json` intent and emit the
 * JSON error envelope instead of TTY prose. It is intentionally position-agnostic
 * and does not consume a value, so it can never itself throw.
 */
export function sniffJsonFromArgv(argv: readonly string[]): boolean {
  return argv.some((tok) => tok === "--json" || tok.startsWith("--json="));
}

/**
 * The catch-path fallback config (deliverable 6). Starts from the plain auto
 * default, but if the raw argv asked for `--json`, FORCES json mode (so the error
 * is JSON even on a TTY, where `auto` would otherwise render human prose). json
 * mode never colors, so color is cleared.
 */
export function fallbackOutputConfig(
  isTTY: boolean,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): OutputConfig {
  const base = defaultOutputConfig(isTTY, env);
  return sniffJsonFromArgv(argv) ? { ...base, mode: "json", color: false } : base;
}
