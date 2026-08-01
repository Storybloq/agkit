// T-226 S3b — the CLOSED ALLOWLIST and the ONE adapter (plan §2 tools/call, F3/F10, R2-F2/R2-F4).
//
// This is the only path from a tool NAME to a registry handler, and it is a TABLE, not a router: it
// is built once at module load from `derivedProjectionEntries(mcpProjection) ∪ FIXED_DISPATCH_
// BINDINGS`, and a call that does not land on an entry never reaches any wire I/O. Every command
// the registry marks `mcpExclude` (44 of them: the shown-once mints, the direct-confirm revokes,
// the human browser ceremonies, the raw `api` door, the local config/profile surface) is
// unreachable BY CONSTRUCTION — not by a check we remembered to write, but because no entry names
// it. The three FIXED tools bind explicitly, because `mcpProjection` omits mcpExcluded specs by
// design and `plan apply` / `plan discard` are exactly that (R2-F4).
//
// BOOT FAILS CLOSED (`RegistryError`, the registry.ts idiom): a duplicate (tool, verb,
// discriminator) triple, a fixed binding whose command left the registry, an advertised tool with
// no dispatch entry, a dispatch entry for a tool nobody advertises, or a branch-less entry each
// throw at import. A server that cannot honour its own `tools/list` refuses to exist.
//
// THE SEQUENCE MIRRORS `build-cli.runSpec` EXACTLY, and deliberately reuses its pieces rather than
// re-deciding anything:
//   validate the FULL call arguments against the COMPILED branch schema (never a re-derivation —
//   the same `CANONICAL_TOOLS` bytes the client was handed)
//     → strip EXACTLY the routing members (`verb`, plus the declaring noun's discriminator param)
//     → `spec.args` strict parse (the command's own validation authority)
//     → for a mutation, `runMutationCeremony(spec, ctx, input, deps)` and the returned pass onto
//       `ctx.ceremony`
//     → the EXACT registry `spec.handler`, same object identity.
// NO code here calls `plan.create`, `plan.apply` or any resource operation directly: the handler
// the registry declares is the only thing that touches the wire.
//
// HOW BRANCH VALIDATION IS SPLIT, and why that is not a second schema. The advertised branch is
// `{routing consts} ∪ {the spec's own zod args, minus the ceremony keys}` — the compiled JSON
// Schema is the authority for the first half (which members exist, which are required, what the
// routing consts are) and the ZOD SCHEMA THAT GENERATED THE SECOND HALF is the authority for its
// own value types. So this module enforces exactly what JSON Schema adds over zod — the member
// key-set (`additionalProperties:false`), the required set and the `const` discriminants — and
// hands the values to `spec.args.parse`. There is no hand-written JSON-Schema type validator and
// no second source of truth; the key-set discipline sweep in `dispatch-allowlist.test.ts` pins the
// two halves to each other for EVERY branch.
import type { ZodType } from "zod";
import type {
  AnyCommandSpec,
  Ctx,
  CommandResult,
  McpSecretIntake,
  MutationBinding,
} from "../commands/types";
import { CEREMONY_EXEMPT, RegistryError, commandKey, visibleCommands } from "../commands/registry";
import { mcpArgsSchema, mcpProjection, type McpNounDiscriminator } from "../commands/generators/mcp-metadata";
import { runMutationCeremony, type CeremonyDeps } from "../core/plan/ceremony";
import type { ClientFlags } from "../core/client/flags";
import { CANONICAL_TOOLS, VERB_MEMBER, type JsonObject, type McpToolDef } from "./tool-defs";
import { invalidParams, unknownTool } from "./result";
import { scrubSecretText, type McpCall } from "./ctx";

/** What a dispatch entry does when it runs: a read, a plan-creating mutation, or a fixed tool. */
export type DispatchKind = "read" | "plan" | "apply" | "discard" | "status";

/** ONE (tool, verb, discriminator) → CommandSpec binding. */
export interface DispatchEntry {
  readonly tool: string;
  /** The routing verb, or `null` for a FIXED tool (whose schema carries no `verb` member). */
  readonly verb: string | null;
  readonly discriminator: McpNounDiscriminator | null;
  /** The EXACT registry spec — same object identity the CLI dispatches (test 9). */
  readonly spec: AnyCommandSpec;
  /**
   * T-227 S5b — THIS surface's parse authority: `spec.mcpSurface.args` when the command declares an
   * MCP grammar of its own, else `spec.args`. It is the SAME schema `tool-defs.ts` compiled into the
   * advertised branch (`mcpArgsSchema`), so "advertised" and "enforced" cannot drift.
   */
  readonly argsSchema: ZodType<unknown>;
  /**
   * THIS surface's write path: `spec.mcpSurface.mutation` when declared, else `spec.mutation`. The
   * override exists because the MCP surface is PLAN-FIRST by construction — a command the CLI runs
   * through the wire's `direct` door names its plannable equivalent rather than becoming the one
   * derived mutation tool that writes with no plan/apply gate.
   */
  readonly mutation: MutationBinding | undefined;
  /** THIS surface's `SecretRef` intake (`spec.mcpSurface.secret`), when the branch takes one. */
  readonly secret: McpSecretIntake | undefined;
  /** The synthesized members stripped before `spec.args` sees the input (R2-F2). */
  readonly routingMembers: readonly string[];
  /** The compiled branch schema(s) this entry accepts — a union arg schema contributes several. */
  readonly branches: readonly JsonObject[];
  readonly kind: DispatchKind;
  /** Map the (routing-stripped) call arguments to the command's own input shape. */
  readonly toCommandInput: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** A resolved call: the entry it landed on and the strict-parsed command input. */
export interface ResolvedDispatch {
  readonly entry: DispatchEntry;
  readonly input: unknown;
}

/** The plan-id member every fixed plan tool advertises (`tool-defs.ts` PLAN_ID_PROPERTY). */
const PLAN_ID_MEMBER = "plan_id";

/**
 * The three FIXED tools and the EXACT registry command each adapts (R2-F4). `toCommandInput` is the
 * whole adapter: the tools advertise `plan_id` (an MCP-legible name that says WHAT it is), while
 * the registry specs take the positional `id` — so the rename happens here, once, and the key-set
 * sweep proves the mapped key set is exactly what `spec.args` advertises.
 */
const FIXED_DISPATCH_BINDINGS: ReadonlyArray<{
  readonly tool: string;
  readonly command: string;
  readonly kind: DispatchKind;
  readonly toCommandInput: (args: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    tool: "agkit_apply",
    command: "plan apply",
    kind: "apply",
    toCommandInput: (args) => ({
      id: args[PLAN_ID_MEMBER],
      // `confirm` is ceremony INPUT to the apply gate (R2-F1) — forwarded ONLY when the caller
      // sent it, so `confirmProvided` stays a faithful fact for the decision spine.
      ...(args["confirm"] !== undefined ? { confirm: args["confirm"] } : {}),
    }),
  },
  {
    tool: "agkit_plan_discard",
    command: "plan discard",
    kind: "discard",
    toCommandInput: (args) => ({ id: args[PLAN_ID_MEMBER] }),
  },
  {
    tool: "agkit_status",
    command: "status get",
    kind: "status",
    // No inputs at all: the session context is whatever this server process can see.
    toCommandInput: () => ({}),
  },
];

/** The advertised names of the fixed tools (the derived roster may never mint one of these). */
export const FIXED_TOOL_NAMES: readonly string[] = FIXED_DISPATCH_BINDINGS.map((b) => b.tool);

function discriminatorKey(discriminator: McpNounDiscriminator | null): string {
  return discriminator === null ? "" : `${discriminator.param}=${discriminator.value}`;
}

function entryKey(tool: string, verb: string | null, discriminator: McpNounDiscriminator | null): string {
  return `${tool}\u0000${verb ?? ""}\u0000${discriminatorKey(discriminator)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The branch schemas of one compiled tool: a `anyOf` union's members, or the schema itself. */
function branchesOf(def: McpToolDef): JsonObject[] {
  const union = def.inputSchema["anyOf"];
  if (Array.isArray(union)) {
    return union.filter(isPlainObject) as JsonObject[];
  }
  return [def.inputSchema];
}

/** The `const` a branch pins a member to, when it pins one. */
function constOf(branch: JsonObject, member: string): unknown {
  const properties = branch["properties"];
  if (!isPlainObject(properties)) return undefined;
  const node = properties[member];
  if (!isPlainObject(node)) return undefined;
  return node["const"];
}

/** The property key-set a branch advertises. */
function branchProperties(branch: JsonObject): string[] {
  const properties = branch["properties"];
  return isPlainObject(properties) ? Object.keys(properties) : [];
}

/** The required key list a branch declares. */
function branchRequired(branch: JsonObject): string[] {
  const required = branch["required"];
  return Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [];
}

/** The branches of `def` that carry this entry's routing consts. */
function branchesFor(
  def: McpToolDef,
  verb: string,
  discriminator: McpNounDiscriminator | null,
): JsonObject[] {
  return branchesOf(def).filter((branch) => {
    if (constOf(branch, VERB_MEMBER) !== verb) return false;
    if (discriminator === null) return true;
    return constOf(branch, discriminator.param) === discriminator.value;
  });
}

/**
 * Build the dispatch table. `defs`/`specs` are injectable ONLY so the boot-invariant tests can feed
 * a mutated roster and prove each guard reddens; production always uses the canonical pair.
 */
export function buildDispatchTable(
  defs: readonly McpToolDef[] = CANONICAL_TOOLS.tools,
  specs: readonly AnyCommandSpec[] = visibleCommands(),
): ReadonlyMap<string, DispatchEntry> {
  const byName = new Map(defs.map((def) => [def.name, def]));
  const table = new Map<string, DispatchEntry>();

  const claim = (entry: DispatchEntry): void => {
    const key = entryKey(entry.tool, entry.verb, entry.discriminator);
    const owner = table.get(key);
    if (owner !== undefined) {
      throw new RegistryError(
        `MCP dispatch: duplicate entry '${entry.tool} ${entry.verb ?? "(fixed)"}` +
          `${discriminatorKey(entry.discriminator) === "" ? "" : ` {${discriminatorKey(entry.discriminator)}}`}' — ` +
          `claimed by both '${commandKey(owner.spec)}' and '${commandKey(entry.spec)}'`,
      );
    }
    table.set(key, entry);
  };

  // --- DERIVED: the registry's own MCP projection, one entry per (tool, verb, discriminator).
  for (const spec of specs) {
    const projection = mcpProjection(spec);
    if (!projection) continue;
    const def = byName.get(projection.tool);
    if (!def) {
      throw new RegistryError(
        `MCP dispatch: '${commandKey(spec)}' projects tool '${projection.tool}', which is not advertised — roster drift`,
      );
    }
    const discriminator = projection.discriminator ?? null;
    const branches = branchesFor(def, projection.verb, discriminator);
    if (branches.length === 0) {
      throw new RegistryError(
        `MCP dispatch: '${commandKey(spec)}' has NO advertised branch on '${projection.tool}' — it could never be called`,
      );
    }
    const routingMembers = discriminator === null ? [VERB_MEMBER] : [VERB_MEMBER, discriminator.param];
    claim({
      tool: projection.tool,
      verb: projection.verb,
      discriminator,
      spec,
      argsSchema: mcpArgsSchema(spec),
      mutation: spec.mcpSurface?.mutation ?? spec.mutation,
      secret: spec.mcpSurface?.secret,
      routingMembers,
      branches,
      kind: projection.kind === "read" ? "read" : "plan",
      toCommandInput: (args) => args,
    });
  }

  // --- FIXED: the plan/apply subsystem's three tools, bound to their exact registry commands.
  for (const binding of FIXED_DISPATCH_BINDINGS) {
    const def = byName.get(binding.tool);
    if (!def) {
      throw new RegistryError(`MCP dispatch: fixed tool '${binding.tool}' is not advertised — roster drift`);
    }
    const spec = specs.find((candidate) => commandKey(candidate) === binding.command);
    if (!spec) {
      throw new RegistryError(
        `MCP dispatch: fixed tool '${binding.tool}' binds command '${binding.command}', which is absent from the registry`,
      );
    }
    claim({
      tool: binding.tool,
      verb: null,
      discriminator: null,
      spec,
      // A fixed tool adapts an EXCLUDED spec, which may carry no `mcpSurface` (registry load-check),
      // so its authority and write path are the spec's own, unconditionally.
      argsSchema: spec.args,
      mutation: spec.mutation,
      secret: undefined,
      routingMembers: [],
      branches: [def.inputSchema],
      kind: binding.kind,
      toCommandInput: binding.toCommandInput,
    });
  }

  // --- ROSTER ↔ DISPATCH BIJECTION (R2-F4): every advertised name resolves, and nothing else does.
  const advertised = new Set(defs.map((def) => def.name));
  const dispatched = new Set([...table.values()].map((entry) => entry.tool));
  const unreachable = [...advertised].filter((name) => !dispatched.has(name));
  if (unreachable.length > 0) {
    throw new RegistryError(
      `MCP dispatch: advertised tool(s) with NO dispatch entry: ${unreachable.join(", ")} — the server would advertise a lie`,
    );
  }
  const unadvertised = [...dispatched].filter((name) => !advertised.has(name));
  if (unadvertised.length > 0) {
    throw new RegistryError(
      `MCP dispatch: dispatch entr(ies) for unadvertised tool(s): ${unadvertised.join(", ")} — an undiscoverable surface`,
    );
  }
  return table;
}

/**
 * THE table, built ONCE at module load — importing this module IS the fail-closed gate, exactly as
 * it is for `tool-defs.ts`.
 */
export const DISPATCH_TABLE: ReadonlyMap<string, DispatchEntry> = buildDispatchTable();

/** Every entry, for the bijection + key-set sweeps. */
export function dispatchEntries(table: ReadonlyMap<string, DispatchEntry> = DISPATCH_TABLE): DispatchEntry[] {
  return [...table.values()];
}

/** The entries of one tool. */
function entriesForTool(table: ReadonlyMap<string, DispatchEntry>, tool: string): DispatchEntry[] {
  return [...table.values()].filter((entry) => entry.tool === tool);
}

/**
 * Resolve a `tools/call` to its entry + strict-parsed input. PURE — no I/O of any kind, so an
 * unknown tool, an excluded command, a bad verb, a mismatched discriminator and a malformed
 * argument are ALL refused before the call could reach the network (test 7).
 *
 * Throws `McpError(InvalidParams)`: unknown tool (the SDK's own tool-not-found shape) or input that
 * fails the advertised branch (D0-g's `-32602` row).
 */
export function resolveCall(
  name: string,
  args: Record<string, unknown> | undefined,
  table: ReadonlyMap<string, DispatchEntry> = DISPATCH_TABLE,
): ResolvedDispatch {
  const candidates = entriesForTool(table, name);
  if (candidates.length === 0) throw unknownTool(name);
  const call = args ?? {};

  const entry = selectEntry(name, candidates, call);
  validateBranch(entry, call);

  const stripped: Record<string, unknown> = {};
  const routing = new Set(entry.routingMembers);
  for (const [key, value] of Object.entries(call)) {
    if (routing.has(key)) continue;
    stripped[key] = value;
  }

  const commandInput = entry.toCommandInput(stripped);
  let input: unknown;
  try {
    input = entry.argsSchema.parse(commandInput);
  } catch (err) {
    throw invalidParams(
      `${name}: the arguments do not satisfy the tool's schema — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { entry, input };
}

/** Pick the entry a call routes to: the fixed tool's only entry, or the (verb, discriminator) one. */
function selectEntry(
  name: string,
  candidates: readonly DispatchEntry[],
  call: Record<string, unknown>,
): DispatchEntry {
  const fixed = candidates.find((entry) => entry.verb === null);
  if (fixed) return fixed;

  const verb = call[VERB_MEMBER];
  if (typeof verb !== "string") {
    throw invalidParams(
      `${name}: '${VERB_MEMBER}' is required and must be one of: ${verbList(candidates)}`,
    );
  }
  const byVerb = candidates.filter((entry) => entry.verb === verb);
  if (byVerb.length === 0) {
    throw invalidParams(`${name}: unknown ${VERB_MEMBER} '${verb}' — expected one of: ${verbList(candidates)}`);
  }
  const matched = byVerb.find(
    (entry) =>
      entry.discriminator === null || call[entry.discriminator.param] === entry.discriminator.value,
  );
  if (!matched) {
    // Every candidate for this verb is discriminated and none matched: the caller sent a missing,
    // extra or wrong discriminant. Named explicitly — a wrong `kind` must never fall through to
    // another noun's command.
    const param = byVerb[0]!.discriminator!.param;
    const values = byVerb.map((entry) => entry.discriminator?.value ?? "").join(", ");
    throw invalidParams(`${name}: '${param}' must be one of: ${values} for ${VERB_MEMBER} '${verb}'`);
  }
  return matched;
}

function verbList(candidates: readonly DispatchEntry[]): string {
  return [...new Set(candidates.map((entry) => entry.verb ?? ""))].sort().join(", ");
}

/**
 * Enforce what the COMPILED branch adds over the spec's zod schema: the member key-set
 * (`additionalProperties:false`), the required set, and every `const` discriminant. A union arg
 * schema contributes several branches; the call satisfies the tool if it satisfies ANY of them.
 */
function validateBranch(entry: DispatchEntry, call: Record<string, unknown>): void {
  const failures: string[] = [];
  for (const branch of entry.branches) {
    const violations = branchViolations(branch, call);
    if (violations.length === 0) return;
    failures.push(violations.join("; "));
  }
  throw invalidParams(`${entry.tool}: ${failures[0] ?? "the arguments do not match the tool's schema"}`);
}

/** The violations of ONE branch — empty means the call satisfies it. */
function branchViolations(branch: JsonObject, call: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const properties = new Set(branchProperties(branch));
  const unknownKeys = Object.keys(call).filter((key) => !properties.has(key));
  if (unknownKeys.length > 0) violations.push(`unknown argument(s): ${unknownKeys.sort().join(", ")}`);
  const missing = branchRequired(branch).filter((key) => call[key] === undefined);
  if (missing.length > 0) violations.push(`missing required argument(s): ${missing.sort().join(", ")}`);
  for (const member of properties) {
    const pinned = constOf(branch, member);
    if (pinned === undefined) continue;
    if (call[member] !== undefined && call[member] !== pinned) {
      violations.push(`'${member}' must be ${JSON.stringify(pinned)}`);
    }
  }
  return violations;
}

/**
 * The ceremony seams for an MCP call (plan §2: `tty:false`, no prompts wired). Both prompt seams
 * are TOTAL and fail closed: there is no interactive channel behind an MCP stdio session, so a y/N
 * is a decline and a typed prompt is EOF — which is exactly what the decision spine reads as
 * non-interactive, and why the gate halts with a typed reason instead of hanging.
 *
 * `warn` is the ceremony's redacted plan render + notices. It goes to the server's STDERR through
 * the SAME redaction/bounding path every other byte takes — never to stdout, which belongs to the
 * protocol frames.
 *
 * T-227 S5: it is also THE call-path stderr write, and the one place a resolved secret can reach a
 * surface without passing `result.ts` — the ceremony renders the PLAN, and for a credential rotate
 * the resolved value is in the plan body it is rendering. So this call's suppression view is
 * subtracted first. The view is read PER LINE, never snapshotted when the deps are built:
 * resolution happens immediately before plan-CREATE (D0-H), i.e. AFTER this object exists, so a
 * snapshot taken here would be empty exactly when it mattered.
 */
export function mcpCeremonyDeps(call: McpCall): CeremonyDeps {
  return {
    confirm: async () => false,
    promptLine: async () => null,
    isTTY: false,
    now: call.seams.now,
    warn: (text) => call.seams.diagnostic(scrubSecretText(text, call.secrets.suppressed())),
  };
}

/**
 * T-227 S5b — THE MCP SECRET RESOLUTION POINT (ticket req 7).
 *
 * A branch that declares a `SecretRef` intake arrives here holding a REFERENCE, never material. The
 * reference is resolved process-side by the COMMAND's own resolver (which owns `channel:"mcp"`, the
 * minimum-byte floor and the operator allowlist — this module knows none of that, and imports no
 * filesystem), and the resolved value is registered in THIS call's suppression registry BEFORE it is
 * placed in any structure at all. That ordering is the whole guarantee: from this line on, every
 * render of this call — summary, hint, machine body, `structuredContent`, the ceremony's plan diff,
 * the stderr diagnostic — subtracts the value, because every one of them reads `secrets.suppressed()`
 * at render time.
 *
 * WHERE IT SITS, and why: `runEntry` runs AFTER `resolveCall` (which stays pure — no env read, no
 * `open(2)` behind a `-32602`) and AFTER the auth gate in `tools.ts`, so an unauthenticated MCP host
 * can never use a secret-bearing tool as an env/file probe. It is also the last step before the
 * ceremony, i.e. immediately before `plan.create` — the resolved value's ONLY destination is the
 * plan body the change builder constructs one frame later (server-side custody, PL-04).
 *
 * The rebuilt record is a COPY: the parsed input a caller-shaped object was validated into is never
 * mutated, and the member is written with `defineProperty` (the `setOwn` discipline) rather than
 * assigned — the key is a spec constant today, and this keeps it inert if that ever stops being true.
 */
function resolveEntrySecret(entry: DispatchEntry, input: unknown, ctx: Ctx, call: McpCall): unknown {
  const intake = entry.secret;
  if (intake === undefined) return input;
  if (!isPlainObject(input)) return input;
  const value = intake.resolve(ctx, input[intake.arg]);
  call.secrets.register(value);
  const resolved: Record<string, unknown> = { ...input };
  Object.defineProperty(resolved, intake.arg, { value, enumerable: true, writable: true, configurable: true });
  return resolved;
}

/**
 * The spec the CEREMONY runs over. Normally the registry object itself; for a command whose MCP
 * surface declares its own plan binding it is a shallow copy carrying that binding — every other
 * field (noun/verb, danger, confirm, elideFlags, prompts) rides through unchanged, so the
 * reconstruction, the danger floor and the typed challenge are all still the spec's own.
 *
 * The HANDLER is never taken from this copy: `runEntry` calls `entry.spec.handler`, the exact
 * registry object, on both surfaces (test 9). A command that must behave differently under a plan
 * pass reads `ctx.ceremony` — the documented seam — rather than being swapped out here.
 */
function ceremonySpec(entry: DispatchEntry): AnyCommandSpec {
  return entry.mutation === entry.spec.mutation ? entry.spec : { ...entry.spec, mutation: entry.mutation };
}

/**
 * Run a resolved entry: the SecretRef resolution (when the branch takes one), the ceremony (for a
 * mutation) and then the EXACT registry handler.
 *
 * This mirrors `build-cli.runSpec` — the ceremony hook gates on the entry's binding and skips the
 * ceremony-exempt keys, so `plan discard` (the one exempt member) runs its handler directly, and
 * every plan-kind mutation gets its plan created, judged and passed on `ctx.ceremony` before the
 * handler is entered. Nothing here decides anything about danger, confirmation or expiry: the
 * ceremony owns that, and this file never re-implements a cell of it.
 */
export async function runEntry(
  entry: DispatchEntry,
  input: unknown,
  call: McpCall,
  clientFlags?: ClientFlags,
): Promise<CommandResult> {
  let ctx: Ctx = clientFlags === undefined ? call.ctx : { ...call.ctx, clientFlags };
  const resolved = resolveEntrySecret(entry, input, ctx, call);
  if (entry.mutation && !CEREMONY_EXEMPT.has(commandKey(entry.spec))) {
    const pass = await runMutationCeremony(ceremonySpec(entry), ctx, resolved, mcpCeremonyDeps(call));
    ctx = { ...ctx, ceremony: pass };
  }
  return entry.spec.handler(ctx, resolved);
}
