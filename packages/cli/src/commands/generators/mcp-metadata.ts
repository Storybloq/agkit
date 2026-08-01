// Generator (d) — per-command MCP-consumable metadata + the folded tool list
// (T-204 deliverable 4d). The MCP tool list is EXACTLY this registry's projection
// (N-011 §APX-D): L3-M1's tool generator consumes it, and the CLI<->MCP drift-lock
// (L2-CLI-23 gate 5) asserts binary<->tool symmetry against it.
//
// Tool-name rules (N-011 §APX-D header + D.1):
//   - reserved / mcpExcluded command -> NOT projected (RN-5 + `EXCL:` column)
//   - safe read (danger SR)          -> `agkit_<noun>_read`  (readOnlyHint:true)
//   - mutation  (danger M/D/PR)      -> `agkit_<noun>_plan`  (verb becomes a
//                                        discriminator param — "verb-folding,
//                                        noun-preserving": all of a noun's
//                                        mutations fold into ONE `_plan` tool)
//
// The single gated executor `agkit_apply` and `agkit_plan_discard` are FIXED MCP
// tools contributed by the plan/apply subsystem, NOT verb-folded resource tools;
// L3-M1 adds them. They are intentionally not derived here.
//
// account->billing) are the drift-lock's reconciliation surface. T-215 (Seam-4, RA-1) and
// T-216 (S4) jointly establish that surface as TWO declared, composing fold maps
// (CANONICAL_MCP_COMMAND_FOLDS verb-level, CANONICAL_MCP_NOUN_FOLDS noun-level) with a pinned
// resolution order: COMMAND fold → NOUN fold → the derivable dash→underscore fold. Both maps are
// append-only against this exact mechanism shape — T-215 seeds the account-plane folds
// (account→billing; account usage→usage), T-216 appends publishable-key→key.
import type { ZodType } from "zod";
import type { AnyCommandSpec, Danger, Scope } from "../types";
import { RegistryError, visibleCommands } from "../registry";

/**
 * T-227 S5b — the ONE accessor for "what does the MCP surface validate this command's arguments
 * with?". A command may declare an `mcpSurface` whose input GRAMMAR differs from the CLI's (a
 * `SecretRef` object where the CLI takes channel flags — see commands/mcp-surface.ts); everything
 * else projects its own `args`. Both the tool compiler and the dispatch table read THIS, so the
 * advertised schema and the parse authority can never be two different decisions.
 */
export function mcpArgsSchema(spec: AnyCommandSpec): ZodType<unknown> {
  return spec.mcpSurface?.args ?? spec.args;
}

/** The description contribution one command makes to its tool — its `mcpSurface` summary when it
 *  declares one (the MCP grammar's own prose, incl. the SecretRef inline warning), else `summary`. */
export function mcpSummary(spec: AnyCommandSpec): string {
  return spec.mcpSurface?.summary ?? spec.summary;
}

/**
 * NOUN-level canonical MCP folds (T-215 Seam-4 / T-216 S4 / RR-3). Applied inside `mcpNoun()`
 * BEFORE the dash fold: a noun listed here projects under its CANONICAL tool noun, never its
 * derivable name (publishing the derivable name for a fold-pending noun is public naming drift —
 * the D8 hazard). `account→billing` (T-215): the account plane's SR reads fold into
 * `agkit_billing_read` alongside billing info/plans; `agkit_account_read` must never project.
 * `publishable-key→key` (T-216): publishable-key list projects `agkit_key_read`, never
 * `agkit_publishable_key_read`. Append-only for later tickets.
 */
export const CANONICAL_MCP_NOUN_FOLDS: Readonly<Record<string, string>> = {
  account: "billing",
  "publishable-key": "key",
  // T-219 D-10: N-011 APX-E ratifies `agkit_killswitch_read`/`_plan` (matching the `killswitch`
  // scope family), NOT the derivable dash-fold `agkit_kill_switch_*` — publishing the derivable
  // name would be public naming drift against the ratified registry (the RR-3 hazard).
  "kill-switch": "killswitch",
  // T-220 D9 (S2): N-011 APX-E ratifies the media-cap singleton under the QUOTA tool names with a
  // `{kind:media}` discriminator (`agkit_quota_read{kind:media}` / `agkit_quota_plan{set,kind:media}`)
  // — never the derivable `agkit_media_quota_*`. The bare fold would collide with T-219's identical
  // quota verbs on `(tool, verb)`; the noun DISCRIMINATOR below is what legalizes the merge.
  "media-quota": "quota",
};

/** A noun-level MCP discriminator (T-220 §2-S2 / D9): commands of a declaring noun carry
 *  `param=value` as an EXTRA discriminator alongside the verb, so two nouns may legally share a
 *  folded tool's `(tool, verb)` pairs — uniqueness widens to `(tool, verb, discriminator)`. */
export interface McpNounDiscriminator {
  readonly param: "kind";
  readonly value: string;
}

/**
 * NOUN-keyed canonical MCP discriminators (T-220 §2-S2, extending the T-215-owned fold surface).
 * `media-quota → {kind:media}` rides its noun fold into the quota tools; `quota → {kind:agent}` is
 * the inventory-ratified twin (N-011 APX-E) — declaration-only on its own (quota folds nowhere;
 * a discriminator on an unfolded, uncolliding noun is a legal annotation), load-bearing the moment
 * media-quota shares its pairs. Append-only for later tickets, like the fold maps above.
 */
export const CANONICAL_MCP_NOUN_DISCRIMINATORS: Readonly<Record<string, McpNounDiscriminator>> = {
  "media-quota": { param: "kind", value: "media" },
  quota: { param: "kind", value: "agent" },
};

/**
 * A command-fold TARGET. A bare `string` is a noun-only fold (the verb is preserved). The object
 * form `{noun, verb}` (T-218 §3.7) is a NOUN-AND-VERB fold: it retargets the noun AND RENAMES the
 * verb — needed when a folded command's own verb would collide with the target tool's existing verbs
 * (`agent-tool list` folding into `agkit_agent_read` alongside `agent list` must rename its verb to
 * `tool_list`, else two commands claim the `(agkit_agent_read, list)` discriminator pair).
 */
export type McpCommandFold = string | { readonly noun: string; readonly verb: string };

/**
 * COMMAND-level (verb) canonical MCP folds (T-215 Seam-4 / T-216 S4 / T-218 §3.7 / RR-3), keyed
 * `"<noun> <verb>"` → target — for the exceptions the noun map CANNOT express. Consulted in
 * `mcpProjection` BEFORE the noun-level fold (pinned precedence: command fold → noun fold → dash
 * fold). `account usage → usage` (T-215): `account usage` folds into the EXISTING `agkit_usage_read`
 * tool. `agent-tool <verb> → {noun:"agent", verb:"tool_<verb>"}` (T-218): the kebab-folded
 * `agent-tool` noun projects into `agkit_agent_read` / `agkit_agent_plan` with a RENAMED verb, so
 * NO `agkit_agent_tool_*` tool ever exists and the discriminator verbs stay unique (§3.7).
 */
export const CANONICAL_MCP_COMMAND_FOLDS: Readonly<Record<string, McpCommandFold>> = {
  "account usage": "usage",
  "agent-tool list": { noun: "agent", verb: "tool_list" },
  "agent-tool get": { noun: "agent", verb: "tool_get" },
  "agent-tool create": { noun: "agent", verb: "tool_create" },
  "agent-tool update": { noun: "agent", verb: "tool_update" },
  "agent-tool delete": { noun: "agent", verb: "tool_delete" },
};

const LOWER_SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/**
 * GENERAL load-checks over the fold maps (nothing plane-specific hardcoded), run on every
 * `mcpToolList` derivation against the REAL visible registry (not the possibly-narrowed spec list
 * a test passes — the maps describe THE registry, so a stale entry reddens every derivation):
 *   (a) every noun-fold key is a visible registry noun, and every command-fold key is a visible
 *       `"<noun> <verb>"` command (stale entries = RegistryError);
 *   (b) every fold target is a lower-snake-safe tool segment — a NOUN may be dash-folded first
 *       (`agent-tool` → `agent_tool`), a renamed VERB may not (it is emitted verbatim, see below).
 *
 * The maps are INJECTABLE (defaulting to the canonical ones production uses) purely so the guard's
 * own negative tests can feed it a malformed map; `mcpToolList` always calls it with the defaults.
 */
export function validateCanonicalFolds(
  nounFolds: Readonly<Record<string, string>> = CANONICAL_MCP_NOUN_FOLDS,
  commandFolds: Readonly<Record<string, McpCommandFold>> = CANONICAL_MCP_COMMAND_FOLDS,
  discriminators: Readonly<Record<string, McpNounDiscriminator>> = CANONICAL_MCP_NOUN_DISCRIMINATORS,
): void {
  const visible = visibleCommands();
  const nouns = new Set(visible.map((s) => s.noun));
  const commands = new Set(visible.map((s) => `${s.noun} ${s.verb}`));
  for (const [key, target] of Object.entries(nounFolds)) {
    if (!nouns.has(key)) {
      throw new RegistryError(`CANONICAL_MCP_NOUN_FOLDS key '${key}' is not a visible registry noun (stale entry)`);
    }
    if (!LOWER_SNAKE.test(target.replaceAll("-", "_"))) {
      throw new RegistryError(`CANONICAL_MCP_NOUN_FOLDS target '${target}' (key '${key}') is not lower-snake-safe`);
    }
  }
  for (const [key, target] of Object.entries(commandFolds)) {
    if (!commands.has(key)) {
      throw new RegistryError(`CANONICAL_MCP_COMMAND_FOLDS key '${key}' is not a visible '<noun> <verb>' command (stale entry)`);
    }
    // Both the fold NOUN and (for the object form) the RENAMED verb must be lower-snake-safe tool
    // segments — a stray dash/underscore mismatch would defeat MCP tool-name / verb injectivity.
    const foldNoun = typeof target === "string" ? target : target.noun;
    if (!LOWER_SNAKE.test(foldNoun.replaceAll("-", "_"))) {
      throw new RegistryError(`CANONICAL_MCP_COMMAND_FOLDS noun target '${foldNoun}' (key '${key}') is not lower-snake-safe`);
    }
    // The RENAMED verb is checked DIRECTLY — no dash fold. `mcpProjection` emits an object-form
    // verb VERBATIM (unlike a noun, which it dash-folds), so normalizing here would accept a
    // `tool-list` that then projects as a dash-bearing, non-lower-snake discriminator. A fold verb
    // is a deliberately authored token: it must already BE canonical lower-snake.
    if (typeof target !== "string" && !LOWER_SNAKE.test(target.verb)) {
      throw new RegistryError(`CANONICAL_MCP_COMMAND_FOLDS verb target '${target.verb}' (key '${key}') is not lower-snake-safe`);
    }
  }
  // S2 discriminator load-checks (T-220): stale keys redden like stale fold entries; param/value
  // are emitted verbatim as an MCP tool param name/value, so both must already BE lower-snake.
  for (const [key, disc] of Object.entries(discriminators)) {
    if (!nouns.has(key)) {
      throw new RegistryError(
        `CANONICAL_MCP_NOUN_DISCRIMINATORS key '${key}' is not a visible registry noun (stale entry)`,
      );
    }
    if (!LOWER_SNAKE.test(disc.param) || !LOWER_SNAKE.test(disc.value)) {
      throw new RegistryError(
        `CANONICAL_MCP_NOUN_DISCRIMINATORS entry '${key}' ('${disc.param}=${disc.value}') is not lower-snake-safe`,
      );
    }
  }
}

export interface McpProjection {
  /** Tool name, e.g. "agkit_project_read" or "agkit_project_plan". */
  tool: string;
  /** The CLI verb — a discriminator param on `_plan` tools. */
  verb: string;
  /** The declared NOUN discriminator (S2/D9), when the primary noun declares one — an extra
   *  discriminator param beside the verb (`agkit_quota_plan{set,kind:media}`). Absent otherwise. */
  discriminator?: McpNounDiscriminator;
  /** `_read` (auto-approvable) or `_plan` (returns a Plan, requires write scope). */
  kind: "read" | "plan";
  readOnlyHint: boolean;
  destructiveHint: boolean;
  scopes: Scope[];
  danger: Danger;
  outputSchemaId: string;
}

/** The tool-name noun: the CANONICAL noun fold (Seam-4 / S4) applied BEFORE the dash fold
 *  (`publishable-key` → `key`; then dashes to underscores: "a-b" -> "a_b"). */
function mcpNoun(noun: string): string {
  return (CANONICAL_MCP_NOUN_FOLDS[noun] ?? noun).replaceAll("-", "_");
}

/** Was this command's tool name produced by a DECLARED fold entry (command- or noun-level)?
 *  The attributable-collision check reads this: a cross-noun tool-name collision is legal ONLY
 *  when it is attributable to a declared fold. */
function isDeclaredFold(spec: AnyCommandSpec): boolean {
  return (
    CANONICAL_MCP_COMMAND_FOLDS[`${spec.noun} ${spec.verb}`] !== undefined ||
    CANONICAL_MCP_NOUN_FOLDS[spec.noun] !== undefined
  );
}

/**
 * Project ONE command to its MCP tool metadata, or `null` if it is not an MCP
 * tool (reserved, or `mcpExclude` set — cross-cutting / human-ceremony / secret).
 * Resolution order (S4, pinned): COMMAND fold (`"<noun> <verb>"`) → NOUN fold → the
 * derivable noun; THEN dash→underscore.
 */
export function mcpProjection(
  spec: AnyCommandSpec,
  // Injectable ONLY so the uniqueness guard's negative tests can synthesize discriminator
  // collisions (the validateCanonicalFolds precedent); production always uses the canonical map.
  discriminators: Readonly<Record<string, McpNounDiscriminator>> = CANONICAL_MCP_NOUN_DISCRIMINATORS,
): McpProjection | null {
  if (spec.reserved || spec.mcpExclude) return null;
  // Pinned precedence (Seam-4 / S4 / T-218 §3.7): command fold → noun fold → derivable dash fold. A
  // command-level fold names the FINAL target noun (dash-folded only — the noun map does not
  // re-apply); the OBJECT form additionally RENAMES the verb (e.g. `agent-tool list` → verb
  // `tool_list` under `agkit_agent_read`, so it does not collide with `agent list`).
  const commandFold = CANONICAL_MCP_COMMAND_FOLDS[`${spec.noun} ${spec.verb}`];
  let noun: string;
  let verb: string;
  if (commandFold === undefined) {
    noun = mcpNoun(spec.noun);
    verb = spec.verb;
  } else if (typeof commandFold === "string") {
    noun = commandFold.replaceAll("-", "_");
    verb = spec.verb;
  } else {
    noun = commandFold.noun.replaceAll("-", "_");
    verb = commandFold.verb;
  }
  // The discriminator is keyed by the PRIMARY noun (S2): it belongs to the CLI noun that folds,
  // not to the fold target — `media-quota` carries {kind:media} INTO the quota tools.
  const discriminator = discriminators[spec.noun];
  if (spec.danger === "SR") {
    return {
      tool: `agkit_${noun}_read`,
      verb,
      ...(discriminator === undefined ? {} : { discriminator }),
      kind: "read",
      readOnlyHint: true,
      destructiveHint: false,
      scopes: spec.scopes,
      danger: spec.danger,
      outputSchemaId: spec.outputSchemaId,
    };
  }
  return {
    tool: `agkit_${noun}_plan`,
    verb,
    ...(discriminator === undefined ? {} : { discriminator }),
    kind: "plan",
    // plan tools never mutate directly — they return a Plan the gated executor
    // applies; so readOnlyHint:false + destructiveHint:false (D.1).
    readOnlyHint: false,
    destructiveHint: false,
    scopes: spec.scopes,
    danger: spec.danger,
    outputSchemaId: spec.outputSchemaId,
  };
}

export interface McpTool {
  tool: string;
  kind: "read" | "plan";
  readOnlyHint: boolean;
  destructiveHint: boolean;
  /** All verbs folded under this tool (the `_plan` discriminator values). */
  verbs: string[];
  /** Per-verb discriminator provenance (S2/D9): one entry per DISTINCT (verb, discriminator)
   *  contribution — `agkit_quota_plan` carries {set,agent}, {set,media}, {clear,agent},
   *  {clear,media}. `discriminator` is null for a verb contributed by a non-declaring noun.
   *  `verbs` above stays the deduped verb list (the pre-S2 shape consumers already read). */
  verbDiscriminators: Array<{ verb: string; discriminator: McpNounDiscriminator | null }>;
  /** Union of the scopes of every folded command. */
  scopes: Scope[];
  /** Output-schema `$id`s of the folded commands. */
  outputSchemaIds: string[];
}

function pushUnique<T>(arr: T[], value: T): void {
  if (!arr.includes(value)) arr.push(value);
}

/**
 * The folded MCP tool list — verb-folding, noun-preserving (D.1). Reserved and
 * mcpExcluded commands are absent (RN-5). This is the artifact L3-M1 turns into
 * the MCP `tools/list`.
 */
export function mcpToolList(
  specs: readonly AnyCommandSpec[] = visibleCommands(),
  // Injectable ONLY for the uniqueness guard's negative tests (synthetic same-discriminator
  // collisions); production always derives with the canonical map.
  discriminators: Readonly<Record<string, McpNounDiscriminator>> = CANONICAL_MCP_NOUN_DISCRIMINATORS,
): McpTool[] {
  // S4 load-checks first: stale/malformed fold-map entries redden EVERY derivation.
  validateCanonicalFolds();
  const byTool = new Map<string, McpTool>();
  // T-215 Seam-4.3, widened by T-220 §2-S2: the folded tool's discriminator is the
  // (tool, verb, noun-discriminator) TRIPLE. Two DISTINCT commands folding to the same triple —
  // same pair with the SAME (or both-absent) noun discriminator — would pushUnique-dedupe into an
  // ambiguous discriminator (a future `billing get` could silently alias `account get`); distinct
  // DECLARED discriminators legalize the merge (N-011's `{kind:agent}` vs `{kind:media}` shape).
  // Per (tool, verb): discriminator-key → owning `<noun> <verb>` command.
  const pairOwner = new Map<string, Map<string, string>>();
  /** Per tool: `verb#discriminator` → the command that contributed it ((tool,verb,disc) uniqueness). */
  const verbOwners = new Map<string, Map<string, string>>();
  /** Per tool: the primary nouns contributing WITHOUT a declared fold (attributable-collision). */
  const derivableNouns = new Map<string, Set<string>>();
  for (const spec of specs) {
    const proj = mcpProjection(spec, discriminators);
    if (!proj) continue;
    const commandKey = `${spec.noun} ${spec.verb}`;
    // Triple-collision check FIRST — it names the "(tool, verb) collision" the account/billing
    // plane's discriminator tests assert; T-216's per-tool verb map re-checks the same invariant
    // (both are kept — a union of the two parents' guards, neither is dropped).
    const pairKey = `${proj.tool} ${proj.verb}`;
    const discKey = proj.discriminator === undefined ? "" : `${proj.discriminator.param}=${proj.discriminator.value}`;
    const pairClaims = pairOwner.get(pairKey) ?? new Map<string, string>();
    const owner = pairClaims.get(discKey);
    if (owner !== undefined && owner !== commandKey) {
      throw new RegistryError(
        `MCP (tool, verb, discriminator) collision: '${pairKey}'${discKey === "" ? "" : ` {${discKey}}`} is ` +
          `claimed by both '${owner}' and '${commandKey}' — two distinct commands may not fold to the ` +
          `same discriminator triple`,
      );
    }
    // Mixing a DISCRIMINATED contribution with an UNDISCRIMINATED one under one (tool, verb) is
    // equally ambiguous — the undiscriminated command has no distinguishing param — so it reddens
    // like a same-discriminator duplicate (fail-closed; distinct DECLARED values are the only merge).
    const mixesWithOther = [...pairClaims.keys()].some(
      (k) => (k === "") !== (discKey === "") && pairClaims.get(k) !== commandKey,
    );
    if (mixesWithOther) {
      throw new RegistryError(
        `MCP (tool, verb, discriminator) collision: '${pairKey}' mixes discriminated and undiscriminated ` +
          `contributions ('${[...pairClaims.values()][0]}' and '${commandKey}') — an ambiguous discriminator`,
      );
    }
    pairClaims.set(discKey, commandKey);
    pairOwner.set(pairKey, pairClaims);
    // (tool, verb, discriminator) uniqueness (S4/T-215 Seam-4.3/T-220 S2): the per-tool re-check.
    const owners = verbOwners.get(proj.tool) ?? new Map<string, string>();
    const verbKey = `${proj.verb}#${discKey}`;
    const prevOwner = owners.get(verbKey);
    if (prevOwner !== undefined && prevOwner !== commandKey) {
      throw new RegistryError(
        `MCP tool '${proj.tool}' verb '${proj.verb}'${discKey === "" ? "" : ` {${discKey}}`} is contributed ` +
          `by two distinct commands ('${prevOwner}' and '${commandKey}') — an ambiguous discriminator`,
      );
    }
    owners.set(verbKey, commandKey);
    verbOwners.set(proj.tool, owners);
    // Attributable-collision bookkeeping (S4): record DERIVABLE (undeclared) noun contributions.
    const derivable = derivableNouns.get(proj.tool) ?? new Set<string>();
    if (!isDeclaredFold(spec)) derivable.add(spec.noun);
    derivableNouns.set(proj.tool, derivable);
    // Any tool-name collision across DISTINCT primary nouns must be ATTRIBUTABLE to a declared
    // fold entry: at most ONE noun may contribute derivably. An accidental collision (two nouns
    // folding to one tool with no declaration) reddens; a declared merge (T-215's
    // `account usage → agkit_usage_read`) is legal.
    if (derivable.size > 1) {
      throw new RegistryError(
        `MCP tool '${proj.tool}' is contributed by multiple primary nouns (${[...derivable].join(", ")}) ` +
          `with NO declared canonical fold entry — an accidental cross-noun collision`,
      );
    }
    const existing = byTool.get(proj.tool);
    if (existing) {
      // Verb-folding is only sound if every command folded under one tool agrees
      // on kind + hints. The registry's injective-noun + closed-danger checks make
      // this hold for name-derivable folds; assert it so the non-derivable folds
      // (route->model_route, account->billing) the drift-lock reconciles later
      // can never silently produce a tool with inconsistent read/plan semantics.
      if (
        existing.kind !== proj.kind ||
        existing.readOnlyHint !== proj.readOnlyHint ||
        existing.destructiveHint !== proj.destructiveHint
      ) {
        throw new RegistryError(
          `MCP tool '${proj.tool}' folds inconsistent commands: ` +
            `${existing.kind}(ro=${existing.readOnlyHint}) vs ${proj.kind}(ro=${proj.readOnlyHint})`,
        );
      }
      pushUnique(existing.verbs, proj.verb);
      // S2 provenance: distinct (verb, discriminator) contributions each get ONE entry (the same
      // command listed twice is legal per the ownership checks, so dedupe by the triple here).
      if (
        !existing.verbDiscriminators.some(
          (e) => e.verb === proj.verb && (e.discriminator?.value ?? null) === (proj.discriminator?.value ?? null),
        )
      ) {
        existing.verbDiscriminators.push({ verb: proj.verb, discriminator: proj.discriminator ?? null });
      }
      for (const s of proj.scopes) pushUnique(existing.scopes, s);
      pushUnique(existing.outputSchemaIds, proj.outputSchemaId);
    } else {
      byTool.set(proj.tool, {
        tool: proj.tool,
        kind: proj.kind,
        readOnlyHint: proj.readOnlyHint,
        destructiveHint: proj.destructiveHint,
        verbs: [proj.verb],
        verbDiscriminators: [{ verb: proj.verb, discriminator: proj.discriminator ?? null }],
        scopes: [...proj.scopes],
        outputSchemaIds: [proj.outputSchemaId],
      });
    }
  }
  return [...byTool.values()];
}
