// Generator (b) — `reference.md`, the full human catalog (T-204 deliverable 4b,
// consumed by T-CLI-19). Grouped by noun; each command shows its verb, aliases,
// danger, scopes, examples and MCP tool. It maps over the SAME registry as every
// other artifact, so deleting a spec.ts fragment removes the command from this output
// too (acceptance).
//
// T-210 (L2-CLI-21): the catalog now renders whatever the FLAG-GATED `registry`
// contains — there is no separate reserved appendix. A DEFAULT build's registry has no
// reserved commands, so the catalog is reserved-free (FORBIDDEN: reserved in any
// shipped skill/reference). A `SHIP_RESERVED` build's registry appends the 42 reserved
// commands, which render inline as FULL entries — and for a contract-route reserved
// command the danger/gating shown is the EXACT `reservedRoute` value (incl. the
// compound "PR+D" and BOTH kill-switch branches), NEVER the projected CLI shell class
// (§E). The committed `skill/reference.md` is ALWAYS the flag-off artifact (§B).
//
// `agkit reference` prints this on demand. As of T-209 a BYTE-IDENTICAL copy is ALSO
// committed + shipped as `skill/reference.md`: regenerate it from THIS generator (never
// hand-edit), and the default suite's `skill-reference-drift.test.ts` locks the
// committed bytes to `renderReferenceMarkdown(registry)`. The output is pinned to
// EXACTLY ONE trailing LF so the drift lock is byte-exact.
import type { AnyCommandSpec, WireDanger, WireGatingValue } from "../types";
import { commandsByNoun, registry } from "../registry";
import { mcpProjection } from "./mcp-metadata";
import { effectiveCommandPath, isSingletonReadGroup } from "./command-path";

/** The heading renders the EFFECTIVE command path (C-6): a singleton-read noun is bare
 * (`agkit audit`, not `agkit audit list`) — the SAME path the yargs shell registers, so
 * `.strictCommands()` accepts what the catalog documents. Multi-command nouns keep the verb. */
function commandHeading(spec: AnyCommandSpec, singletonRead: boolean): string {
  const alias = spec.aliases && spec.aliases.length > 0 ? ` (aliases: ${spec.aliases.join(", ")})` : "";
  return `${effectiveCommandPath(spec, singletonRead)}${alias}`;
}

function mcpLine(spec: AnyCommandSpec): string {
  const proj = mcpProjection(spec);
  if (!proj) return spec.mcpExclude ? `MCP: excluded (${spec.mcpExclude})` : "MCP: reserved";
  // The braces render the tool's discriminators in the N-011 APX-E notation: the verb on `_plan`
  // tools, plus the declared noun discriminator (S2/D9) — `agkit_quota_plan{set,kind:media}`.
  const parts = [
    ...(proj.kind === "plan" ? [proj.verb] : []),
    ...(proj.discriminator ? [`${proj.discriminator.param}:${proj.discriminator.value}`] : []),
  ];
  return `MCP: \`${proj.tool}\`${parts.length > 0 ? `{${parts.join(",")}}` : ""}`;
}

/** Human-render the EXACT wire danger — a single class, the compound "PR+D", or the
 *  discriminated kill-switch pair with BOTH branches shown (§E). */
function formatWireDanger(danger: WireDanger): string {
  if (typeof danger === "object") return `${danger.engage} (engage) / ${danger.disengage} (disengage)`;
  return danger;
}

/** Human-render the EXACT wire gating — same discriminated form as danger. */
function formatWireGating(gating: WireGatingValue): string {
  if (typeof gating === "object") return `${gating.engage} (engage) / ${gating.disengage} (disengage)`;
  return gating;
}

function renderCommand(spec: AnyCommandSpec, singletonRead: boolean): string {
  const lines: string[] = [];
  lines.push(`### ${commandHeading(spec, singletonRead)}`);
  lines.push("");
  lines.push(spec.summary);
  lines.push("");
  if (spec.reservedRoute) {
    // Reserved contract-route command: show the EXACT wire danger/gating + the route.
    lines.push(`- danger: \`${formatWireDanger(spec.reservedRoute.danger)}\``);
    lines.push(`- gating: \`${formatWireGating(spec.reservedRoute.gating)}\``);
    lines.push(`- reserved route: \`${spec.reservedRoute.operationId}\` (\`${spec.reservedRoute.method} ${spec.reservedRoute.path}\`)`);
  } else {
    lines.push(`- danger: \`${spec.danger}\``);
  }
  lines.push(`- scopes: ${spec.scopes.length ? spec.scopes.map((s) => `\`${s}\``).join(", ") : "_(none)_"}`);
  lines.push(`- output schema: \`${spec.outputSchemaId}\``);
  lines.push(`- ${mcpLine(spec)}`);
  if (spec.reserved) {
    lines.push(`- reserved: ${spec.reserved.ticket} — ${spec.reserved.reason}`);
  }
  if (spec.confirm) lines.push(`- typed-confirm: type the ${spec.confirm.challenge}`);
  if (spec.prompts && spec.prompts.length > 0) {
    lines.push(`- prompts: ${spec.prompts.map((p) => `${p.name} (${p.flagEquivalent})`).join(", ")}`);
  }
  lines.push("");
  lines.push("Examples:");
  lines.push("");
  lines.push("```");
  for (const ex of spec.examples) lines.push(ex);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/** Build the Markdown catalog. `agkit reference` prints this. Renders the flag-gated
 *  registry directly (default ⇒ reserved-free; SHIP_RESERVED ⇒ reserved inline). */
export function renderReferenceMarkdown(specs: readonly AnyCommandSpec[] = registry): string {
  const out: string[] = [];
  out.push("# agkit command reference");
  out.push("");
  out.push("_Generated from the CommandSpec registry (`src/commands/registry.ts`). Do not hand-edit._");
  out.push("");

  const byNoun = commandsByNoun(specs);
  for (const [noun, group] of byNoun) {
    // T-216 (S1): render the noun alias (`pk` for `publishable-key`) on the noun grouping. Every
    // spec of a noun declares the identical set (registry load-check), so read it off the head.
    const nounAliases = group[0]?.nounAliases ?? [];
    const aliasSuffix = nounAliases.length > 0 ? ` (alias: ${nounAliases.join(", ")})` : "";
    out.push(`## ${noun}${aliasSuffix}`);
    out.push("");
    const singletonRead = isSingletonReadGroup(group);
    for (const spec of group) out.push(renderCommand(spec, singletonRead));
  }

  // Pin the terminal byte sequence to EXACTLY ONE trailing LF (drift-lock invariant,
  // T-209): collapse any trailing run of newlines to a single "\n", and add one when
  // the body ends without a newline. Only the terminator is normalized — the internal
  // structure (the intentional blank lines between blocks) is untouched.
  return out.join("\n").replace(/\n*$/, "\n");
}
