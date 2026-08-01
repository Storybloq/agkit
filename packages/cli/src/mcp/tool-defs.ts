// T-226 S2 — the MCP tool DEFINITIONS: the schema compiler + the ONE canonical serializer.
//
// This module is the SINGLE source of the `tools/list` payload (plan-T-226 D0-c/F11):
// `canonicalToolsList()` is BOTH the production ListTools handler's payload source AND the
// generator of the committed golden (`tools-list.golden.json`). There is no second serializer,
// so a byte-lock on the golden is a byte-lock on the wire.
//
// Roster (D0-d, amendments of record): 34 DERIVED tools (the registry's own MCP projection,
// `mcpToolList()`) + 3 FIXED tools contributed by the plan/apply subsystem (`agkit_apply`,
// `agkit_plan_discard`, `agkit_status`) = 37 exposed. `agkit_plan_read` is DERIVED (from
// `plan list` / `plan show`) and is never minted twice; the reserved `agkit_knowledge_*` pair
// remains absent by construction.
//
// The derived count is 32 as D0-d RATIFIED it, +1 from T-227 S5b (`agkit_provider_key_plan`, minted
// when `SecretRef` let `provider-key add`/`rotate` off the exclusion roster), +1 from T-299
// (`agkit_grant_read`, verbs `list`/`show` over the account-tier OAuth-grant reads). T-299 adds ONE
// tool, not three: `grant revoke` is mcpExcluded — a direct_confirm returns no Plan, so it projects
// to null — and `project summary` folds into the EXISTING `agkit_project_read` as a third verb.
//
// PURE by construction: no I/O, no wire imports, no child_process, no yargs. The only inputs are
// the command registry, its MCP projection generator, and zod's JSON-Schema emitter.
//
// FAIL-CLOSED at module load (the `RegistryError` idiom from registry.ts). A zod schema that
// cannot be represented as JSON Schema, an ambiguous (verb, discriminator) branch, a tool with no
// branches, an arg key colliding with a routing member, a non-strict arg object, or a duplicate
// tool name each THROW when this module is imported — a placeholder tool definition would let the
// server advertise a lie, so the server refuses to exist instead.
//
// `outputSchema` is OMITTED entirely (D0-c / F4): `CommandSpec.outputSchemaId` is an `$id` STRING,
// not a schema document, and MCP's `outputSchema` must be a real JSON Schema. Advertising the id
// would be a false affordance; the omission is recorded in the N-011 amendment (S5).
import { z } from "zod";
import type { AnyCommandSpec } from "../commands/types";
import { RegistryError, commandKey, registry, visibleCommands } from "../commands/registry";
import {
  mcpArgsSchema,
  mcpProjection,
  mcpSummary,
  mcpToolList,
  type McpNounDiscriminator,
} from "../commands/generators/mcp-metadata";

// --- JSON value model --------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- the tool shape ----------------------------------------------------------

/** The MCP annotation hints we emit. Only the fields a class actually asserts are present —
 *  an unset hint is the protocol's own default, never a silently-invented claim. */
export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One advertised tool. NOTE the deliberate absence of `outputSchema` (see the header). */
export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations: McpToolAnnotations;
}

export interface CanonicalToolsList {
  /** The canonical bytes: the tools array, 2-space indented, with exactly ONE trailing LF. */
  readonly json: string;
  /** The SAME objects the bytes were produced from (canonical key order preserved), so the
   *  production handler and the golden can never diverge. */
  readonly tools: readonly McpToolDef[];
}

// --- routing members + ceremony keys ----------------------------------------

/** The synthesized routing member every branch carries — dispatch keys on it (R2-F2). */
export const VERB_MEMBER = "verb";

/**
 * Ceremony-only arg keys stripped from every DERIVED branch schema (R2-F1). A derived MCP plan
 * call is `planOnly`: it creates a plan and returns it, so a `confirm` the caller supplied would
 * be rejected by the engine as `plan_only_with_confirm` — advertising it invites input that
 * cannot succeed. `yes` is not an arg key on any shipped spec; it is listed so it can never
 * become one silently. The FIXED `agkit_apply` tool legitimately advertises `confirm`: there it
 * is ceremony INPUT to the apply gate, not a plan-creation key.
 */
export const CEREMONY_ONLY_KEYS: readonly string[] = ["confirm", "yes"];

// --- annotation classes (D.1 + D0-d) -----------------------------------------

/** Auto-approvable reads: no mutation, no open world (the management plane is a closed API). */
const READ_ANNOTATIONS: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Plan-class: writes nothing itself — it returns a Plan the gated executor applies. */
const PLAN_ANNOTATIONS: McpToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
/** The ONE destructive tool in the whole roster: the gated executor. Applying the SAME plan twice
 *  is terminal-by-construction (`assertPlanApplyable`), hence `idempotentHint:true`. */
const APPLY_ANNOTATIONS: McpToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

// --- fixed tools (explicit, strict schemas) ----------------------------------

const PLAN_ID_PROPERTY: JsonObject = {
  type: "string",
  minLength: 1,
  description: "The id of an open plan (as returned by a `_plan` tool or listed by agkit_plan_read).",
};

const CONFIRM_PROPERTY: JsonObject = {
  type: "string",
  minLength: 1,
  description:
    "The plan's confirm string. Required only when the server plan is destructive or prod-rebinding; " +
    "read the plan (agkit_plan_read, verb 'show') to see it — a refusal never discloses it.",
};

/**
 * The three FIXED tools. Their schemas are EXPLICIT (never derived): the plan/apply subsystem is
 * not a verb-folded resource noun. Their DESCRIPTIONS are still derived from the registry specs
 * they adapt, so a summary edit reddens the golden instead of drifting silently.
 */
const FIXED_TOOL_BLUEPRINTS: ReadonlyArray<{
  readonly name: string;
  /** The `<noun> <verb>` registry command this tool adapts — the description source, and the
   *  same binding S3's dispatch allowlist makes explicit (R2-F4). */
  readonly command: string;
  readonly inputSchema: JsonObject;
  readonly annotations: McpToolAnnotations;
}> = [
  {
    name: "agkit_apply",
    command: "plan apply",
    inputSchema: {
      type: "object",
      properties: { plan_id: PLAN_ID_PROPERTY, confirm: CONFIRM_PROPERTY },
      required: ["plan_id"],
      additionalProperties: false,
    },
    annotations: APPLY_ANNOTATIONS,
  },
  {
    name: "agkit_plan_discard",
    command: "plan discard",
    inputSchema: {
      type: "object",
      properties: { plan_id: PLAN_ID_PROPERTY },
      required: ["plan_id"],
      additionalProperties: false,
    },
    annotations: PLAN_ANNOTATIONS,
  },
  {
    name: "agkit_status",
    command: "status get",
    // No inputs at all: the session context is whatever this server process can see.
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ANNOTATIONS,
  },
];

/** The summary of a registry command, by `<noun> <verb>` key. Absent ⇒ startup failure: a fixed
 *  tool whose backing command left the registry must never keep advertising itself. */
function registrySummary(command: string): string {
  const spec = registry.find((candidate) => commandKey(candidate) === command);
  if (!spec) {
    throw new RegistryError(
      `MCP tool-defs: fixed-tool source command '${command}' is absent from the registry — the tool cannot describe itself`,
    );
  }
  return spec.summary;
}

/** The 3 fixed tools, built at module load (fail-closed on a missing source command). */
export const FIXED_TOOLS: readonly McpToolDef[] = FIXED_TOOL_BLUEPRINTS.map((blueprint) => ({
  name: blueprint.name,
  description: registrySummary(blueprint.command),
  inputSchema: blueprint.inputSchema,
  annotations: blueprint.annotations,
}));

// --- derived tools: the schema compiler --------------------------------------

/** One (verb, discriminator) contribution to a derived tool, with the spec that made it. */
interface Contribution {
  readonly verb: string;
  readonly discriminator: McpNounDiscriminator | null;
  readonly spec: AnyCommandSpec;
}

function discriminatorKey(discriminator: McpNounDiscriminator | null): string {
  return discriminator === null ? "" : `${discriminator.param}=${discriminator.value}`;
}

/** `set (kind=media)` / `list` — the human label for one contribution. */
function contributionLabel(contribution: Contribution): string {
  const { verb, discriminator } = contribution;
  return discriminator === null ? verb : `${verb} (${discriminator.param}=${discriminator.value})`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Group the projected specs by tool. The FOLD is never re-derived here — `mcpProjection` owns it;
 * this only buckets its output and re-asserts the (tool, verb, discriminator) uniqueness the
 * generator already guards, because a compiler that silently dropped a duplicate would advertise
 * one of two commands at random.
 */
function contributionsByTool(specs: readonly AnyCommandSpec[]): Map<string, Contribution[]> {
  const byTool = new Map<string, Contribution[]>();
  const claimed = new Map<string, string>();
  for (const spec of specs) {
    const projection = mcpProjection(spec);
    if (!projection) continue;
    const discriminator = projection.discriminator ?? null;
    const branchKey = `${projection.tool} ${projection.verb}#${discriminatorKey(discriminator)}`;
    const owner = claimed.get(branchKey);
    if (owner !== undefined) {
      throw new RegistryError(
        `MCP tool-defs: ambiguous branch '${branchKey}' — claimed by both '${owner}' and '${commandKey(spec)}'`,
      );
    }
    claimed.set(branchKey, commandKey(spec));
    const bucket = byTool.get(projection.tool) ?? [];
    bucket.push({ verb: projection.verb, discriminator, spec });
    byTool.set(projection.tool, bucket);
  }
  return byTool;
}

/** A strict JSON-Schema object node, or a startup failure naming what was wrong. */
function requireStrictObjectSchema(node: unknown, where: string): JsonObject {
  if (!isPlainObject(node)) {
    throw new RegistryError(`MCP tool-defs: ${where} did not convert to a JSON-Schema object`);
  }
  if (node["type"] !== "object") {
    throw new RegistryError(`MCP tool-defs: ${where} is not an object schema (type=${JSON.stringify(node["type"])})`);
  }
  if (node["additionalProperties"] !== false) {
    throw new RegistryError(
      `MCP tool-defs: ${where} is not STRICT (additionalProperties must be false) — an MCP client must not be ` +
        `invited to send keys the command's own parse rejects`,
    );
  }
  return node;
}

/**
 * The arg SHAPES a spec contributes — normally one, but a spec whose `args` is a discriminated
 * union (`issuer create`) converts to a top-level `oneOf` and contributes one shape per member.
 *
 * `io:"input"` is the load-bearing option, not a stylistic one: an MCP `inputSchema` describes
 * what the CALLER sends (which is then fed to the parse), so the INPUT side is the honest
 * projection — and it is also the only representable side for a spec whose args carry a transform
 * (`media-quota set`), whose OUTPUT side is unrepresentable by construction.
 *
 * T-227 S5b: the schema is `mcpArgsSchema(spec)` — the command's own `args` unless it declares an
 * `mcpSurface`, whose grammar dispatch ALSO parses with. One schema, advertised and enforced.
 */
function argShapes(spec: AnyCommandSpec): JsonObject[] {
  let converted: unknown;
  try {
    converted = z.toJSONSchema(mcpArgsSchema(spec), { io: "input" });
  } catch (err) {
    throw new RegistryError(
      `MCP tool-defs: the arg schema of '${commandKey(spec)}' cannot be represented as JSON Schema: ${message(err)}`,
    );
  }
  if (!isPlainObject(converted)) {
    throw new RegistryError(`MCP tool-defs: the arg schema of '${commandKey(spec)}' did not convert to an object`);
  }
  const union = converted["oneOf"];
  if (Array.isArray(union)) {
    if (union.length === 0) {
      throw new RegistryError(`MCP tool-defs: the arg schema of '${commandKey(spec)}' converted to an EMPTY union`);
    }
    return union.map((member, index) =>
      requireStrictObjectSchema(member, `the arg schema of '${commandKey(spec)}' (union member ${index})`),
    );
  }
  return [requireStrictObjectSchema(converted, `the arg schema of '${commandKey(spec)}'`)];
}

/**
 * ONE emitted branch: the routing members (`verb`, plus the declaring noun's discriminator when
 * the fold defines one) as required consts, then the contributing spec's own args MINUS the
 * ceremony-only keys. Strict — `additionalProperties:false` is preserved from the source shape.
 */
function buildBranch(tool: string, contribution: Contribution, shape: JsonObject): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];

  properties[VERB_MEMBER] = { type: "string", const: contribution.verb };
  required.push(VERB_MEMBER);
  if (contribution.discriminator !== null) {
    properties[contribution.discriminator.param] = { type: "string", const: contribution.discriminator.value };
    required.push(contribution.discriminator.param);
  }
  const routingMembers = new Set(required);

  const sourceProperties = shape["properties"];
  const argProperties = isPlainObject(sourceProperties) ? sourceProperties : {};
  for (const [key, value] of Object.entries(argProperties)) {
    if (CEREMONY_ONLY_KEYS.includes(key)) continue;
    if (routingMembers.has(key)) {
      throw new RegistryError(
        `MCP tool-defs: '${commandKey(contribution.spec)}' declares an arg '${key}' that collides with a ROUTING ` +
          `member of tool '${tool}' — dispatch strips routing members, so the arg would be unreachable`,
      );
    }
    properties[key] = value;
  }

  const sourceRequired = shape["required"];
  if (Array.isArray(sourceRequired)) {
    for (const key of sourceRequired) {
      if (typeof key !== "string") {
        throw new RegistryError(`MCP tool-defs: '${commandKey(contribution.spec)}' emitted a non-string required key`);
      }
      // A REQUIRED ceremony key is unsatisfiable over MCP either way: advertised, every call is
      // rejected as `plan_only_with_confirm`; stripped, the schema admits calls the command's own
      // parse refuses. No shipped spec does this — one that did is a build defect, so refuse to
      // exist rather than emit a satisfiable-looking dead branch (relay chunk-31).
      if (CEREMONY_ONLY_KEYS.includes(key)) {
        throw new RegistryError(
          `MCP tool-defs: '${commandKey(contribution.spec)}' makes CEREMONY key '${key}' REQUIRED — the branch ` +
            `cannot be satisfied over MCP (ceremony keys are stripped from derived schemas)`,
        );
      }
      required.push(key);
    }
  }

  return { type: "object", properties, required, additionalProperties: false };
}

/** Compile ONE derived tool from its contributions. */
function compileDerivedTool(tool: string, kind: "read" | "plan", contributions: readonly Contribution[]): McpToolDef {
  if (contributions.length === 0) {
    throw new RegistryError(`MCP tool-defs: derived tool '${tool}' has ZERO branches — it cannot be dispatched`);
  }
  const ordered = [...contributions].sort(
    (a, b) =>
      compareStrings(a.verb, b.verb) || compareStrings(discriminatorKey(a.discriminator), discriminatorKey(b.discriminator)),
  );
  const branches = ordered.flatMap((contribution) =>
    argShapes(contribution.spec).map((shape) => buildBranch(tool, contribution, shape)),
  );
  // Single-branch tools inline their branch (the verb member is still required — dispatch keys on it).
  const inputSchema: JsonObject =
    branches.length === 1 ? branches[0]! : { type: "object", anyOf: branches as unknown as JsonValue[] };

  // T-227 S5b: `mcpSummary` — a command with an `mcpSurface` describes the MCP grammar (which is
  // not the CLI's), so its tool text is the surface's, never the flag-teaching CLI summary.
  const description =
    ordered.length === 1
      ? mcpSummary(ordered[0]!.spec)
      : ordered.map((contribution) => `${contributionLabel(contribution)}: ${mcpSummary(contribution.spec)}`).join("\n");

  return {
    name: tool,
    description,
    inputSchema,
    annotations: kind === "read" ? READ_ANNOTATIONS : PLAN_ANNOTATIONS,
  };
}

/**
 * Every DERIVED tool, compiled. The ROSTER, kind and hint classes come from `mcpToolList()` —
 * this compiler never re-derives them; it only attaches schemas. The two derivations are then
 * cross-checked branch-for-branch, so a future divergence between the generator's fold and this
 * module's bucketing is a startup failure rather than a silently thinner tool list.
 */
export function compileDerivedTools(specs: readonly AnyCommandSpec[] = visibleCommands()): McpToolDef[] {
  const folded = mcpToolList(specs);
  const contributions = contributionsByTool(specs);

  const foldedNames = new Set(folded.map((entry) => entry.tool));
  for (const tool of contributions.keys()) {
    if (!foldedNames.has(tool)) {
      throw new RegistryError(`MCP tool-defs: tool '${tool}' was projected but is absent from mcpToolList() — fold drift`);
    }
  }

  return folded.map((entry) => {
    const bucket = contributions.get(entry.tool) ?? [];
    // Branch-set equality against the generator's own provenance list (S2/D9 verbDiscriminators).
    const mine = new Set(bucket.map((c) => `${c.verb}#${discriminatorKey(c.discriminator)}`));
    const theirs = new Set(
      entry.verbDiscriminators.map((vd) => `${vd.verb}#${discriminatorKey(vd.discriminator ?? null)}`),
    );
    const missing = [...theirs].filter((key) => !mine.has(key));
    const extra = [...mine].filter((key) => !theirs.has(key));
    if (missing.length > 0 || extra.length > 0) {
      throw new RegistryError(
        `MCP tool-defs: branch-set drift on '${entry.tool}' — missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
      );
    }
    return compileDerivedTool(entry.tool, entry.kind, bucket);
  });
}

// --- the ONE canonical serializer --------------------------------------------

const SORTED_ARRAY_KEYS: readonly string[] = ["required", "enum"];

/**
 * Deterministic ordering for anything that reaches the wire: every object's keys sorted, and the
 * SET-valued arrays (`required`, `enum`) sorted too. Order-significant arrays (`anyOf`, `items`,
 * `allOf`) keep their authored order — branches are already emitted in a sorted order, and zod's
 * own emission is deterministic for a given schema.
 */
function canonicalize(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (isPlainObject(node)) {
    const out: JsonObject = {};
    for (const key of Object.keys(node).sort()) {
      const value = node[key]!;
      if (SORTED_ARRAY_KEYS.includes(key) && Array.isArray(value) && value.every((v) => typeof v === "string")) {
        out[key] = [...(value as string[])].sort();
      } else {
        out[key] = canonicalize(value);
      }
    }
    return out;
  }
  return node;
}

/** Stable key order for the tool object itself: name, description, inputSchema, annotations. */
function canonicalToolObject(def: McpToolDef): McpToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: canonicalize(def.inputSchema) as JsonObject,
    annotations: canonicalize(def.annotations as unknown as JsonObject) as McpToolAnnotations,
  };
}

/**
 * Deep-freeze a canonical tool graph (relay chunk-32). TS `readonly` is type-level only; without
 * this, a runtime mutation of the exported `tools` would change the production ListTools payload
 * while `json` kept its build-time bytes — silently splitting the wire from the golden. Safe to
 * freeze unconditionally: `canonicalize` copies every node, so no shared structure is reached.
 */
function deepFreeze<T>(node: T): T {
  if (typeof node === "object" && node !== null) {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
}

/**
 * THE serializer. Returns the canonical tool objects AND their exact bytes — the production
 * ListTools handler serves `tools`, the golden pins `json`, and they are the same array, so the
 * byte-lock is a wire lock (D0-c/F11).
 *
 * `specs` is injectable ONLY so the golden's negative control can feed a mutated registry copy and
 * prove the bytes bind to the specs, not to a cached artifact; production always uses the default.
 */
export function canonicalToolsList(specs: readonly AnyCommandSpec[] = visibleCommands()): CanonicalToolsList {
  const defs = [...FIXED_TOOLS, ...compileDerivedTools(specs)];
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.name)) {
      throw new RegistryError(`MCP tool-defs: duplicate tool name '${def.name}' — a tool may never be minted twice`);
    }
    seen.add(def.name);
  }
  const tools = Object.freeze(
    defs.sort((a, b) => compareStrings(a.name, b.name)).map((def) => deepFreeze(canonicalToolObject(def))),
  );
  return Object.freeze({ json: `${JSON.stringify(tools, null, 2)}\n`, tools });
}

/**
 * Built ONCE, at module load — importing this module IS the fail-closed gate. A broken registry,
 * an unserializable arg schema or an ambiguous branch throws here, so no MCP server process can
 * exist while advertising a tool list it cannot honour.
 */
export const CANONICAL_TOOLS: CanonicalToolsList = canonicalToolsList();

// ── the mcpExclude roster: the tool list's PHOTOGRAPHIC NEGATIVE ─────────────────────────────
//
// T-228 (ruling PR-2) MOVED this pair of declarations here from `__fixtures__/route-claims.ts`,
// unchanged. The move is custody, not redesign: `scripts/regen-goldens.ts` is the package's ONE
// committed regen entry point (T-225 R3 — "every generated artifact this package commits is
// re-rendered there, and NOWHERE else"), `mcp-exclusions.golden.json` is one of the artifacts it
// must render, and a committed producer may not reach into a test fixture for its generator. The
// fixture re-exports both names, so every existing consumer is untouched.
//
// It lives BESIDE `canonicalToolsList` because the two are one decision read from two sides: a
// visible command either projects to a tool (and appears in the tools golden) or carries a
// non-empty `mcpExclude` reason (and appears here). Keeping the generators adjacent means a
// command that silently changed sides moves two committed artifacts in the same run.

export interface ExclusionEntry {
  /** `<noun> <verb>` — the registry key. */
  readonly command: string;
  /** The spec's danger class, so an exclusion silently turning into a read is visible. */
  readonly danger: string;
  /** The ratified `EXCL:` reason (N-011 §APX-D). */
  readonly reason: string;
}

export interface CanonicalExclusionRoster {
  /** The canonical bytes: command-sorted, 2-space indented, exactly one trailing LF. */
  readonly json: string;
  readonly entries: readonly ExclusionEntry[];
}

/**
 * THE exclusion roster: every visible command carrying a non-empty `mcpExclude`, derived by RUNNING
 * over the registry. Deterministic (sorted by command key) so the committed golden is a byte-lock:
 * an accidental un-exclusion, a new unexcluded mutation, or a re-classified command all move these
 * bytes. Regenerate by running the derivation — never by hand-editing the golden.
 */
export function canonicalExclusionRoster(
  specs: readonly AnyCommandSpec[] = visibleCommands(),
): CanonicalExclusionRoster {
  const entries: ExclusionEntry[] = specs
    .filter((spec) => typeof spec.mcpExclude === "string" && spec.mcpExclude.length > 0)
    .map((spec) => ({ command: commandKey(spec), danger: spec.danger, reason: spec.mcpExclude! }))
    .sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  return { json: `${JSON.stringify(entries, null, 2)}\n`, entries };
}
