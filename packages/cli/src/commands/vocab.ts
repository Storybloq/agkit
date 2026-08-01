// Closed vocabularies + the example/flag tokenizer shared by the registry load
// check and the invariant test (T-204 deliverable 5). Keeping these here, apart
// from any spec fragment, means the vocabulary is one authoritative list.
import type { Scope, ScopeLevel } from "./types";
// ISS-226: the ONE arity source. `cli/flag-ownership` is a graph SINK (it imports nothing), so
// this edge cannot cycle — see that module's header for why `CLIENT_FLAGS` had to move there.
import { flagConsumesValue } from "../cli/flag-ownership";

// --- closed verb vocabulary (D3 §2.1; T-204 deliverable 5) -------------------
// The ONLY verbs a command may declare. Enforced at registry-load (registry.ts):
// an unknown verb throws, and `toggle` is called out by name because it was the
// tempting-but-banned verb (enable/disable are the ratified pair). If you need a
// new verb it is a design change — add it HERE, deliberately, not ad hoc.
export const VERB_VOCABULARY = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "revoke",
  "archive",
  "rotate",
  "set",
  "clear",
  "enable",
  "disable",
  "activate",
  "deactivate",
  "sync",
  "revalidate",
  "add",
  "remove",
  // T-208 (canonical L2-CLI-06) deliberately extends the closed set for the
  // config/profile management surface. `unset` (config key removal — the standard
  // git-config verb, distinct from `clear`), `show` (a single-profile detail read),
  // `use` (select the active profile), and `rename` (profile rename) have no clean
  // existing synonym, so they are added HERE, deliberately, as the vocab contract
  // requires — keeping the CLI verbs identical to the ticket's command names (no
  // alias indirection, no CLI<->reference<->MCP drift).
  "unset",
  "show",
  "use",
  "rename",
  // T-212 (canonical L2-CLI-08) deliberately extends the closed set for the plan/apply
  // surface. `apply` (execute an open plan — also the top-level `agkit apply` alias the
  // confirmation-required hints teach) and `discard` (zero-side-effect plan cleanup, the
  // ceremony-exempt member) have no existing synonym; they are added HERE, deliberately,
  // as the vocab contract requires — CLI verbs identical to the ticket's command names.
  "apply",
  "discard",
  // T-214 (canonical L2-CLI-16) deliberately extends the closed set for the READ-ONLY
  // observability surface, following the T-208 precedent (add HERE, deliberately, never
  // ad hoc). These five verbs are the ticket's own command names for the `usage` /
  // `media-usage` nouns — `series` (usage time-series), `requests` (the paginated request
  // log), `top-users` (the top-N knob), `summary` + `costs` (media-usage rollups) — and
  // have no clean synonym in the existing set, so the CLI verbs stay byte-identical to the
  // ticket syntax (no alias indirection, no CLI<->reference<->MCP drift). They are pure
  // reads; NONE joins `READ_VERBS` (only get/list drive the bare-command rule — a multi-verb
  // usage noun must NOT surface bare). Kebab `top-users` is fine: MCP tool names are noun-keyed
  // + danger-driven, so a verb never enters a tool name (mcp-metadata.ts).
  "series",
  "requests",
  "top-users",
  "summary",
  "costs",
  // T-215 (canonical L2-CLI-10) deliberately extends the closed set for the account /
  // identity / billing plane, following the T-208/T-212/T-214 precedent (add HERE,
  // deliberately, never ad hoc). These five verbs are the ticket's own command names for
  // the `account` / `billing` nouns — `usage` (account usage rollup), `info` (billing state
  // read — the D-4 verb whose op snake-folds to `billing.get` via a SPEC_OP_OVERRIDES entry,
  // not `billing.info`), `plans` (the read-only plan catalog = DB truth, no marketing CRUD),
  // `checkout` + `portal` (the M-class money-path Stripe ceremonies) — and have no clean
  // synonym in the existing set, so the CLI verbs stay byte-identical to the ticket syntax
  // (no alias indirection, no CLI<->reference<->MCP drift). NONE joins `READ_VERBS`:
  // `account`/`billing` are MULTI-verb nouns that must never surface bare; `member` surfaces
  // bare via its EXISTING `list` read-verb, not through any verb added here.
  "usage",
  "info",
  "plans",
  "checkout",
  "portal",
  // T-219 (canonical L2-CLI-14) deliberately extends the closed set for the kill-switch
  // surface, following the T-208/T-214/T-215 precedent (add HERE, deliberately, never ad
  // hoc). `status` is the ticket's own command name for the kill-switch state read
  // (`kill-switch status` over the wire op `kill_switch.get`, a SPEC_OP_OVERRIDES entry) —
  // `get` would misread as fetching a resource by id, while `status` names what the operator
  // actually asks ("is traffic halted?"). It does NOT join `READ_VERBS`: `kill-switch` is a
  // multi-verb noun (status/activate/deactivate) and must never surface bare.
  "status",
  // T-222 (canonical L2-CLI-20) deliberately extends the closed set for the service plane,
  // following the T-208/T-214/T-215/T-219 precedent (add HERE, deliberately, never ad hoc).
  // These six are the ticket's own command tokens: `serve` (`mcp serve` — the in-process MCP
  // handoff), `run` (the bare `selftest`/`upgrade` verbs), `open` (`dashboard` — opens the
  // browser TTY-only), and `post`/`put`/`patch` (the raw `api` escape hatch, where the HTTP
  // method IS the verb token — `get`/`delete` already exist). NONE joins `READ_VERBS`:
  // `api get` must never make `api` a bare noun (five-verb noun), and serve/run/open gate
  // their own nouns' bare registration through `bare:true`, not the read-verb rule.
  "serve",
  "run",
  "open",
  "post",
  "put",
  "patch",
  // T-223 (canonical L2-CLI-22) deliberately extends the closed set for the READ-ONLY security
  // surface, following the T-208/T-214/T-215/T-219/T-222 precedent (add HERE, deliberately, never
  // ad hoc). `security` is the ticket's own command name (`account security` — the dashboard
  // deep-link plus the honest token-facts read), so the CLI verb stays byte-identical to the ticket
  // syntax (no alias indirection, no CLI<->reference<->MCP drift). It does NOT join `READ_VERBS`:
  // `account` is a multi-verb noun (get/usage/security) that must never surface bare, and
  // `security` is not a get/list-style state read.
  "security",
  // T-226 (D0-i) deliberately extends the closed set for the model-route defaults CATALOG read,
  // following the T-208/T-214/T-215/T-219/T-222/T-223 precedent (add HERE, deliberately, never ad
  // hoc). `defaults` is the wire operation's own name (`model_route.defaults`) and the catalog's
  // own noun — `list` is already taken by the project's BOUND routes, and reusing `get` would
  // misread as fetching one route by id. It does NOT join `READ_VERBS`: `route` is a multi-verb
  // noun (list/get/defaults/create/update/delete) that must never surface bare.
  "defaults",
  // T-228 (req 3 / MCP-12, 2026-07-31) deliberately extends the closed set for the MCP-integration
  // TRIAGE command, following the T-208/T-214/T-215/T-219/T-222/T-223/T-226 precedent (add HERE,
  // deliberately, never ad hoc). No existing verb fits: `get` reads ONE resource by id and this
  // reads none; `status` is already taken (`kill-switch status`) and names a STATE, not a
  // DIAGNOSIS; `run` is the bare-noun diagnostic verb (`selftest run`) and `mcp` is not bare;
  // `list` would promise a collection. `doctor` is the ticket's own command name, so the CLI verb
  // stays byte-identical to the ticket syntax (no alias indirection, no CLI↔reference↔MCP drift).
  // It does NOT join `READ_VERBS`: `mcp` is a multi-verb noun that must never surface bare.
  "doctor",
  // T-228 (req 1 / MCP-12, 2026-07-31) extends the closed set once more, for the command that
  // PRINTS this server's client-registration snippets with the absolute launcher path baked in.
  // No existing verb fits: `get` reads ONE resource by id; `list` promises a collection; `show`
  // is not in the set at all; `defaults` names a catalog of server-owned values, not a rendering
  // of local machine facts. `print-config` is the ticket's own command token, so the CLI verb
  // stays byte-identical to the ticket syntax (no alias indirection, no CLI↔reference↔MCP drift).
  // A KEBAB verb is already precedent (`top-users`, above) and is safe here for the structural
  // reason recorded there: MCP tool names are NOUN-keyed, so a verb never enters a tool name —
  // and this command is `mcpExclude`d besides, so it mints no tool at all.
  // It does NOT join `READ_VERBS`: `mcp` is a multi-verb noun that must never surface bare.
  "print-config",
] as const;

// T-210 (canonical L2-CLI-21) §C extends the closed vocab for the RESERVED trees. Those
// verbs are NOT added here (`VERB_VOCABULARY` is on the LIVE graph — a verb string added
// here would ship in the DEFAULT bundle, defeating the "compiled-out" byte-absence goal).
// They live in `commands/reserved/reserved-verbs.ts` (`RESERVED_VERB_VOCABULARY`), which is
// reachable ONLY through the reserved factory and so tree-shakes out of a default build.
// The reserved factory validates its verbs against `VERB_VOCABULARY ∪ RESERVED_VERB_VOCABULARY`,
// and `assembleRegistry` skips its closed-vocab verb check for `reserved` specs (whose verb
// validity the factory already enforced) — so a reserved verb is still closed + validated,
// just byte-gated. See build-flags.ts for why source vs. a flag-off build cannot be told
// apart by the flag (both `SHIP_RESERVED===false`), which is why this split is necessary.

export type Verb = (typeof VERB_VOCABULARY)[number];

const VERB_SET: ReadonlySet<string> = new Set(VERB_VOCABULARY);

/** Verbs that read state — a singleton-noun with exactly one of these becomes a bare command. */
const READ_VERBS: ReadonlySet<string> = new Set(["get", "list"]);

export function isKnownVerb(verb: string): verb is Verb {
  return VERB_SET.has(verb);
}

export function isReadVerb(verb: string): boolean {
  return READ_VERBS.has(verb);
}

// --- scope family registry (N-011 §APX-C.2, RN-2 + RN-4) ---------------------
// 100% of the C.2 matrix (C01–C20). The scope-string type in types.ts is open by
// design (additive registry), but every scope a *shipped* command declares must
// name a family from THIS list — the load-check catches typos like `porjects:read`.
// `knowledge` is registered-reserved (C20 / RN-5); it appears here because the
// family string exists in the open registry now even though no route requires it
// until T-AB lands.
export const SCOPE_FAMILIES = [
  "projects",
  "keys",
  "tokens",
  "issuers",
  "provider-keys",
  "routes",
  "agents",
  "media-routes",
  "identities",
  "quotas",
  "killswitch",
  "revenuecat",
  "billing",
  "account",
  "usage",
  "audit",
  "jobs",
  "attest",
  "plans",
  "knowledge",
] as const;

export type ScopeFamily = (typeof SCOPE_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(SCOPE_FAMILIES);
const LEVEL_SET: ReadonlySet<string> = new Set<ScopeLevel>(["read", "write", "destroy"]);

/** Well-formed `<registered-family>:<read|write|destroy>` ? */
export function isValidScope(scope: string): scope is Scope {
  const idx = scope.indexOf(":");
  if (idx <= 0) return false;
  const family = scope.slice(0, idx);
  const level = scope.slice(idx + 1);
  return FAMILY_SET.has(family) && LEVEL_SET.has(level);
}

// --- noun format (types.ts: "Lower-kebab") -----------------------------------
// A noun is lower-kebab: `[a-z0-9]` groups joined by single hyphens, no leading/
// trailing/double hyphen and NO underscore. Enforced at registry-load so the MCP
// tool-name derivation (`noun.replaceAll("-","_")`, mcp-metadata.ts) stays
// INJECTIVE — otherwise two distinct nouns (`a-b` and `a_b`) would both fold to
// the same `a_b` tool and silently merge their verbs/scopes.
const KEBAB_NOUN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Is `noun` a well-formed lower-kebab resource noun? */
export function isKebabNoun(noun: string): boolean {
  return KEBAB_NOUN.test(noun);
}

// --- example / flag tokenizer ------------------------------------------------
// Every example is a real CLI string (e.g. "agkit project create --name Acme").
// To assert "each example parses against its own arg schema" (deliverable 6) we
// tokenize it back into the input object here, then run it through the command's
// zod `args`. An example is what an operator TYPES AT A SHELL, so the split must
// be the SHELL'S split, not a naive whitespace one: real examples carry quoted
// values (`--description "Look up an order"`, `--parameter-schema '{"type":…}'`)
// and a whitespace split projects `"Look` / `'{"type":…}'` — a value the command
// never receives on argv (the shell strips the quotes BEFORE argv exists). That
// mangling is silent: the fragments still parse as strings, so the example check
// went green while asserting about input no invocation can produce.

/**
 * Tokenize an example EXACTLY as a POSIX shell would for argv purposes: whitespace separates
 * tokens except inside a single- or double-quoted segment, whose delimiters are REMOVED and
 * whose inner whitespace is preserved. A quoted segment may be glued to unquoted text on either
 * side (`--key="a b"` → the single token `--key=a b`), and a single-quoted segment is literal —
 * a `"` inside it is data, which is what makes `'{"type":"object"}'` survive as JSON.
 *
 * NO escape processing (`\"`, `\\`): the registry examples use none, and inventing an escape
 * dialect here would be a second, unverified grammar. An UNBALANCED quote is an explicit throw —
 * the example is malformed and the registry checker must say so, never tokenize garbage.
 *
 * This is example-only. Production argv (`parseFlagTokens`, `bareTokens`) is handed tokens the
 * real shell already split and unquoted; re-running a quote pass over those would CORRUPT a value
 * that legitimately contains a quote character, so those paths are deliberately untouched.
 *
 * EXPORTED (T-279 deliverable 4). The README drift check must reproduce the shell's ARGV for a
 * documented line, not just its flag object: `applyPositional` and `parseClientFlags` both read raw
 * argv (the boolean-swallow and dual-source rules are argv-shaped, not input-shaped), and a
 * documented `--confirm "apply PR plan: model_route.create"` only yields one token through THIS
 * split. Reconstructing argv from `splitExample`'s `{path, input}` would be a second, lossier
 * grammar — exactly the drift the drift check exists to catch — so the checker calls this instead.
 */
export function shellSplit(example: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let open = false; // a token has begun — `--name ""` must still emit an (empty) token
  let quote: '"' | "'" | null = null;
  for (const ch of example) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
      continue;
    }
    current += ch;
    open = true;
  }
  if (quote !== null) {
    throw new Error(`unbalanced ${quote === '"' ? "double" : "single"} quote in example: ${JSON.stringify(example)}`);
  }
  if (open) tokens.push(current);
  return tokens;
}

/** A tokenized flag value: a string, a bare-boolean `true`, or — for a REPEATED string flag
 *  (e.g. `--scope a --scope b`) — the ordered array of its string values. */
export type FlagValue = string | boolean | string[];

/** Split an example into its command-path tokens and its parsed flag input. */
export function splitExample(example: string): { path: string[]; input: Record<string, FlagValue> } {
  const tokens = shellSplit(example);
  const firstFlag = tokens.findIndex((t) => t.startsWith("--"));
  const path = firstFlag === -1 ? tokens : tokens.slice(0, firstFlag);
  const flagTokens = firstFlag === -1 ? [] : tokens.slice(firstFlag);
  return { path, input: parseFlagTokens(flagTokens) };
}

/**
 * Assign `value` to `key`, collecting a REPEATED string flag into an ordered array. A single
 * occurrence stays scalar (backward-compatible with every existing single-valued flag); a second
 * string occurrence promotes to `[first, second, …]` — this is what makes `--scope a --scope b`
 * (repeatable, per the token-create ticket) reach the handler as both values instead of silently
 * last-wins (which would drop a requested scope — an honor-or-reject violation). A repeat that
 * involves a bare boolean is degenerate (no meaningful array) and keeps the prior last-wins.
 */
function assignFlag(out: Record<string, FlagValue>, key: string, value: string | boolean): void {
  const existing = out[key];
  if (existing === undefined) {
    out[key] = value;
    return;
  }
  if (typeof value === "string" && (typeof existing === "string" || Array.isArray(existing))) {
    out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    return;
  }
  out[key] = value; // degenerate repeat (a boolean is involved) — last wins, as before
}

/**
 * Parse `--key value`, `--key=value`, and bare boolean `--flag` tokens (repeats → arrays).
 *
 * ISS-226 — ARITY-AWARE. This walk used to be unconditionally value-greedy: ANY `--flag` followed
 * by a non-`--` token swallowed it. yargs never agreed (it knows `--verbose` is `type: "boolean"`),
 * so a leading boolean global flag parsed one way here and another way in the shell, and every
 * consumer that "shares the consumption rule" — the positional walk below, `core/output/config`,
 * `core/client/flags`, `cli/build-cli`'s command input, the README drift check — inherited the
 * disagreement. `flagConsumesValue` is now the single arity authority (`cli/flag-ownership`), so a
 * SHELL-OWNED boolean consumes nothing and `agkit --verbose apply plan_x` binds `plan_x` to the
 * positional instead of losing `apply` into `verbose`. A COMMAND's own flag is unaffected: every one
 * of them is registered `type: "string"` by `describeOptions`, so it stays value-greedy exactly as
 * before.
 */
export function parseFlagTokens(tokens: string[]): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined || !tok.startsWith("--")) continue;
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      assignFlag(out, body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--") && flagConsumesValue(body)) {
      assignFlag(out, body, next);
      i++;
    } else {
      assignFlag(out, body, true);
    }
  }
  return out;
}

// --- positional plumbing (T-212 S3) ------------------------------------------
// The tokenizer above is FLAG-only (non-`--` tokens are skipped). T-212 adds a single
// positional surface (`agkit apply <plan-id>` / `agkit plan show <plan-id>`), so these
// helpers walk the SAME consumption rules as `parseFlagTokens` (a value-taking `--flag`
// consumes the next non-flag token) to isolate the leftover positional token(s). Sharing
// the consumption rule with `parseFlagTokens` is what keeps the positional walk from ever
// disagreeing with the arg parse over which token a `--flag` swallowed.

/** A minimal command-path descriptor for positional resolution. */
export interface PositionalCommand {
  readonly noun: string;
  readonly verb: string;
  readonly aliases?: readonly string[];
  /** T-216 (S1): noun-position aliases (`pk` for `publishable-key`) — `extractPositional` treats
   *  any of `[noun, ...nounAliases]` as the path head, so `pk revoke <id>` extracts one positional. */
  readonly nounAliases?: readonly string[];
}

/** The NON-flag, non-consumed tokens of a token list, in order (command path + positionals). */
export function bareTokens(tokens: readonly string[]): string[] {
  const bare: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--")) {
      // A `--flag value` (no `=`) consumes the next NON-flag token as its value — exactly
      // as parseFlagTokens does, ARITY INCLUDED (ISS-226): a shell-owned BOOLEAN consumes
      // nothing, so `agkit --verbose plan list` leaves `plan list` as the command path
      // instead of eating `plan` and resolving the nonexistent `agkit list`. A `--flag=value`,
      // a bare boolean, or a value-less trailing flag consumes nothing.
      if (!tok.includes("=")) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("--") && flagConsumesValue(tok.slice(2))) i++;
      }
      continue;
    }
    bare.push(tok);
  }
  return bare;
}

/**
 * The leftover positional token(s) after the command PATH. The path is `<noun> <verb|alias>`
 * (2 tokens) or a bare / top-level `<noun|verb|alias>` (1 token — the S6 `agkit apply` alias).
 * The dispatcher maps EXACTLY ONE onto `input[positional.key]`; 0 → the zod required-key error;
 * ≥2 → an "unexpected argument" usage_error.
 */
export function extractPositional(rawArgv: readonly string[], spec: PositionalCommand): string[] {
  const bare = bareTokens(rawArgv);
  const nounNames = new Set<string>([spec.noun, ...(spec.nounAliases ?? [])]);
  const verbNames = new Set<string>([spec.verb, ...(spec.aliases ?? [])]);
  let pathLen = 0;
  if (bare[0] !== undefined && nounNames.has(bare[0])) {
    // The noun (or a NOUN ALIAS, T-216 S1: `pk` for `publishable-key`) heads the path; without
    // alias-awareness `pk revoke <id>` would compute pathLen=0 and yield 3 spurious positionals.
    pathLen = 1;
    if (bare[1] !== undefined && verbNames.has(bare[1])) pathLen = 2;
  } else if (bare[0] !== undefined && verbNames.has(bare[0])) {
    // A top-level verb alias (`agkit apply <plan-id>`): the path is the single alias token.
    pathLen = 1;
  }
  return bare.slice(pathLen);
}

/**
 * Parse an example into the input object the registry checker validates, WITH positional
 * awareness: for a positional-bearing spec, the example's trailing positional token is mapped
 * onto `input[positional.key]` (before S3 the checker ignored it and a required key failed).
 *
 * F-G2: a REQUIRED-mode positional-bearing spec's example must carry EXACTLY ONE positional token
 * — zero (the flag form, which the canonical hints never teach) or two+ (ambiguous) is an EXPLICIT
 * failure the registry surfaces as a RegistryError, never a silent drop.
 *
 * T-216 (S3): an OPTIONAL-mode positional (`positional.optional === true`) relaxes the cardinality
 * to ZERO-OR-ONE — zero omits the key (the bare `agkit project get` form), one maps it — while ≥2
 * stays an explicit error in both modes.
 */
export function exampleInput(
  spec: PositionalCommand & { positional?: { key: string; name: string; optional?: true } },
  example: string,
): Record<string, FlagValue> {
  const { path, input } = splitExample(example);
  if (!spec.positional) return input;
  // path[0] is the literal "agkit" prefix; the remainder is `<command…> <positional?>`.
  const positionals = extractPositional(path.slice(1), spec);
  const optional = spec.positional.optional === true;
  if (positionals.length > 1) {
    throw new Error(
      `a positional-bearing spec's example may carry at most one <${spec.positional.name}> token (got ${positionals.length}): ${JSON.stringify(example)}`,
    );
  }
  if (positionals.length === 0) {
    if (optional) return input; // the bare form — key omitted, handler fallback runs
    throw new Error(
      `a required positional-bearing spec's example must carry exactly one <${spec.positional.name}> token (got 0): ${JSON.stringify(example)}`,
    );
  }
  return { ...input, [spec.positional.key]: positionals[0]! };
}

// --- top-level shell tokens (T-212 S6 verb aliases + non-registry commands) — single-sourced (S5) --
// The deliberate top-level surface aliases (T-212 Design d): ONE registry entry per target — the
// alias is a build-cli registration, so help/reference/MCP see a single citizen and the (noun,verb)
// dedup invariant holds. HOISTED here (T-216 S5) from build-cli so `assembleRegistry`'s noun-alias
// collision check can see it WITHOUT importing build-cli (which imports the registry — that would
// cycle). build-cli re-consumes THIS constant, and a build-cli parity test pins that the tokens it
// registers equal the exported set, so a future build-cli-only addition can never silently escape
// the collision check.
export const TOP_LEVEL_VERB_ALIASES: Readonly<Record<string, { readonly noun: string; readonly verb: string }>> = {
  apply: { noun: "plan", verb: "apply" },
};

/** Non-registry top-level shell commands: the `reference` meta-command, the `completion`
 *  meta-command (T-222 step 9), + yargs' builtin `help`. A noun alias may not collide with these
 *  (they are reachable top-level tokens — a `completion` noun would shadow the generator side-door). */
export const NON_REGISTRY_TOP_LEVEL_COMMANDS = ["reference", "help", "completion"] as const;

/**
 * Client-behavior + ceremony flag names (T-211/T-212). The TABLE now lives in
 * `cli/flag-ownership.ts` and is RE-EXPORTED here so no consumer's import path changed —
 * the same move `GLOBAL_OUTPUT_FLAGS` made out of `core/output/config.ts`. ISS-226 forced it:
 * flag-ownership owns flag ARITY, this module's tokenizer is arity's first consumer, and a
 * `vocab -> flag-ownership -> vocab` edge would have cycled. It is still ONE list.
 */
export { CLIENT_FLAGS } from "../cli/flag-ownership";

/**
 * The FULL set of reserved top-level shell tokens that are NOT sourced from the registry nouns —
 * the top-level verb aliases (`apply`) ∪ the non-registry commands (`reference`, `help`). The
 * noun-alias collision check unions THIS with every registry noun + every sibling noun's aliases.
 */
export const RESERVED_TOP_LEVEL_TOKENS: readonly string[] = [
  ...Object.keys(TOP_LEVEL_VERB_ALIASES),
  ...NON_REGISTRY_TOP_LEVEL_COMMANDS,
];

// --- output-schema `$id` convention (deliverable 2 + FORBIDDEN: no missing $id) -
/** Stable `$id` for a command's output schema. Emitted in `reference --json`. */
export function outputSchemaId(noun: string, verb: string): string {
  return `https://schemas.agkit.cloud/cli/v1/${noun}.${verb}.output.json`;
}
