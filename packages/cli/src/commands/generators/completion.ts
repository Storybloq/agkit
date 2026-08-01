// Generator — shell completion scripts (T-222 step 9, canonical L2-CLI-20 deliverable 5). Like
// `reference`, this is DERIVED from the SAME registry at invocation time, so it can never drift: a
// deleted spec.ts fragment drops the command from every shell's completion too. yargs' own
// completion machinery emits bash/zsh only and hangs an undocumented `--get-yargs-completions`
// runtime surface (a false affordance) — so we emit all THREE shells (bash/zsh/fish) from one static
// registry walk instead (D-1). Output is deterministic (sorted) with exactly ONE trailing LF.
import type { AnyCommandSpec } from "../types";
import { commandsByNoun, registry } from "../registry";
import { RESERVED_TOP_LEVEL_TOKENS, CLIENT_FLAGS } from "../vocab";
import { GLOBAL_OUTPUT_FLAGS } from "../../core/output";
import { CONTEXT_FLAGS } from "../../cli/flag-ownership";

export type CompletionShell = "bash" | "zsh" | "fish";

/** The supported shells, for the side-door's usage error + the per-shell test matrix. */
export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];

interface CompletionModel {
  /** Top-level tokens after `agkit` — nouns ∪ noun aliases ∪ the reserved meta-commands. */
  readonly topLevel: readonly string[];
  /**
   * Per-noun verb tokens (verb ∪ verb aliases), one entry per noun (nouns sorted). Each entry also
   * carries that noun's ALIASES: an alias head is a real command path (build-cli registers each
   * group under `[noun, ...nounAliases]`), so every shell's second-level dispatch must key on the
   * SAME set — keyed on the canonical noun alone, an alias falls through to the flags-only branch
   * and that noun's verbs never complete.
   */
  readonly nouns: ReadonlyArray<{
    readonly noun: string;
    readonly aliases: readonly string[];
    readonly verbs: readonly string[];
  }>;
  /** The `--flag` tokens offered anywhere (globals ∪ client/ceremony ∪ per-command, MINUS positionals). */
  readonly flags: readonly string[];
}

function uniqSort(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Extract a spec's declared zod object keys (its flags), or [] for a non-object schema. */
function specArgKeys(spec: AnyCommandSpec): string[] {
  const shape = (spec.args as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/** Walk the registry into a shell-agnostic completion model (deterministic). */
export function buildCompletionModel(specs: readonly AnyCommandSpec[] = registry): CompletionModel {
  const groups = commandsByNoun(specs);

  // A load-check enforces that every spec of a noun declares the IDENTICAL nounAliases, so the
  // group head is authoritative for the whole group.
  const nouns = uniqSort([...groups.keys()]).map((noun) => {
    const group = groups.get(noun)!;
    const aliases = uniqSort(group[0]!.nounAliases ?? []);
    const verbs = uniqSort(group.flatMap((s) => [s.verb, ...(s.aliases ?? [])]));
    return { noun, aliases, verbs };
  });

  // Top level and the dispatch branches read the SAME alias set — derived once so an alias can
  // never be offerable at the top level while unreachable in the verb dispatch.
  const topLevel = uniqSort([
    ...nouns.map((n) => n.noun),
    ...nouns.flatMap((n) => n.aliases),
    ...RESERVED_TOP_LEVEL_TOKENS,
  ]);

  // Every declared positional KEY (across all specs) is excluded from the flag set — a positional is
  // a bare token, never a `--flag` (structural-test invariant).
  const positionalKeys = new Set(specs.map((s) => s.positional?.key).filter((k): k is string => Boolean(k)));
  const flagKeys = new Set<string>();
  for (const spec of specs) for (const k of specArgKeys(spec)) if (!positionalKeys.has(k)) flagKeys.add(k);
  // All three shell-owned tables, read from their single source (T-279). `profile`/`project`
  // used to be hand-copied string literals here because CONTEXT_FLAGS was private to
  // build-cli — correct at the time, but a third context flag would have silently gone
  // missing from completions. Offer exactly what the shell registers, derived not restated.
  for (const g of GLOBAL_OUTPUT_FLAGS) flagKeys.add(g);
  for (const c of CLIENT_FLAGS) flagKeys.add(c);
  for (const x of CONTEXT_FLAGS) flagKeys.add(x);
  const flags = uniqSort([...flagKeys]).map((k) => `--${k}`);

  return { topLevel, nouns, flags };
}

/** Render the completion script for `shell` from the registry. Deterministic; one trailing LF. */
export function renderCompletionScript(
  shell: CompletionShell,
  specs: readonly AnyCommandSpec[] = registry,
): string {
  const model = buildCompletionModel(specs);
  const body =
    shell === "bash" ? renderBash(model) : shell === "zsh" ? renderZsh(model) : renderFish(model);
  return body.endsWith("\n") ? body : `${body}\n`;
}

// ── bash: a `complete -F _agkit` two-level word-list function ──────────────────────────────────────
function renderBash(model: CompletionModel): string {
  const flags = model.flags.join(" ");
  const lines: string[] = [
    "# agkit bash completion (generated from the registry — do not edit)",
    "_agkit() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local top="${model.topLevel.join(" ")}"`,
    `  local flags="${flags}"`,
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    '    COMPREPLY=( $(compgen -W "$top" -- "$cur") )',
    "    return",
    "  fi",
    '  case "${COMP_WORDS[1]}" in',
  ];
  for (const { noun, aliases, verbs } of model.nouns) {
    const label = [noun, ...aliases].join("|");
    lines.push(`    ${label}) COMPREPLY=( $(compgen -W "${[...verbs].join(" ")} $flags" -- "$cur") ); return ;;`);
  }
  lines.push(
    "  esac",
    '  COMPREPLY=( $(compgen -W "$flags" -- "$cur") )',
    "}",
    "complete -F _agkit agkit",
  );
  return lines.join("\n") + "\n";
}

// ── zsh: `#compdef agkit` + a compadd case function (no `_arguments`) ────────────────────────────────
function renderZsh(model: CompletionModel): string {
  const flags = model.flags.join(" ");
  const lines: string[] = [
    "#compdef agkit",
    "# agkit zsh completion (generated from the registry — do not edit)",
    "_agkit() {",
    "  if (( CURRENT == 2 )); then",
    `    compadd -- ${model.topLevel.join(" ")}`,
    "    return",
    "  fi",
    '  case "$words[2]" in',
  ];
  for (const { noun, aliases, verbs } of model.nouns) {
    const label = [noun, ...aliases].join("|");
    lines.push(`    ${label}) compadd -- ${[...verbs].join(" ")} ${flags} ;;`);
  }
  // The tail has to serve BOTH zsh install paths, and they want opposite things. Dropped into
  // `$fpath` as `_agkit`, the `#compdef` header makes compinit autoload this FILE as the function
  // body, so it must CALL itself on first invocation (`funcstack[1]` is `_agkit` there). Sourced or
  // eval'd, the top level is NOT a completion context — a bare self-call runs `compadd` outside one
  // (an error) and binds nothing, so it must REGISTER instead. The guard picks per invocation.
  lines.push(
    "    *) compadd -- " + flags + " ;;",
    "  esac",
    "}",
    'if [ "$funcstack[1]" = "_agkit" ]; then',
    '  _agkit "$@"',
    "else",
    "  compdef _agkit agkit",
    "fi",
  );
  return lines.join("\n") + "\n";
}

// ── fish: per-token `complete -c agkit -n …` lines ─────────────────────────────────────────────────
function renderFish(model: CompletionModel): string {
  const lines: string[] = ["# agkit fish completion (generated from the registry — do not edit)"];
  // Top-level tokens — offered only when no subcommand has been seen yet.
  for (const tok of model.topLevel) {
    lines.push(`complete -c agkit -f -n '__fish_use_subcommand' -a '${tok}'`);
  }
  // Per-noun verbs — offered once that noun OR any of its aliases has been seen
  // (`__fish_seen_subcommand_from` takes a token list and matches any of them).
  for (const { noun, aliases, verbs } of model.nouns) {
    const heads = [noun, ...aliases].join(" ");
    for (const verb of verbs) {
      lines.push(`complete -c agkit -f -n '__fish_seen_subcommand_from ${heads}' -a '${verb}'`);
    }
  }
  // Flags — offered everywhere (long options).
  for (const flag of model.flags) {
    lines.push(`complete -c agkit -l '${flag.replace(/^--/, "")}'`);
  }
  return lines.join("\n") + "\n";
}
