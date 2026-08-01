// registry.ts — the single source of truth for the `agkit` command surface.
//
// ANTI-PATTERN, NAMED (T-204 deliverable 1): storybloq's `register.ts` grew to a
// 4190-line monolith where every command, its args, its help and its dispatch
// were tangled in ONE file — impossible to review, merge, or reason about. We do
// the opposite: one directory per noun under src/commands/<noun>/ (a `spec.ts`
// plus one handler file per verb), and THIS file only *assembles* those fragments.
// A CI lint rule (eslint `max-lines`, scoped to packages/cli/**) caps every source
// file at 800 lines so the monolith cannot regrow. Adding a command = adding a
// fragment; deleting one = deleting a fragment. This file never balloons.
//
// `assembleRegistry` validates the whole set at LOAD and THROWS on any violation
// (deliverable 5 + acceptance): unknown / `toggle` verb, missing example, an
// example that fails its own arg schema, a missing `$id`, a D/PR command without
// typed-confirm, a prompt without a `flagEquivalent`, an unregistered scope
// family, or a duplicate command. Failing at import means a broken registry can
// never ship — the process refuses to start.
import type { AnyCommandSpec, CommandSpec } from "./types";
import { DANGERS, isDanger, isMutating, requiresTypedConfirm } from "./types";
import { isKebabNoun, isKnownVerb, isValidScope, exampleInput, RESERVED_TOP_LEVEL_TOKENS, type FlagValue } from "./vocab";
import { buildReservedSpecs } from "./reserved";

// --- the VISIBLE fragments (the ONLY place shipped-visible specs are enumerated) --
import { versionCommands } from "./version/spec";
import { whoamiCommands } from "./whoami/spec";
import { statusCommands } from "./status/spec";
import { configCommands } from "./config/spec";
import { profileCommands } from "./profile/spec";
import { projectCommands } from "./project/spec";
import { issuerCommands } from "./issuer/spec";
import { planCommands } from "./plan/spec";
import { loginCommands } from "./login/spec";
import { logoutCommands } from "./logout/spec";
import { tokenCommands } from "./token/spec";
import { grantCommands } from "./grant/spec";
import { usageCommands } from "./usage/spec";
import { endUserCommands } from "./end-user/spec";
import { mediaUsageCommands } from "./media-usage/spec";
import { mediaJobCommands } from "./media-job/spec";
import { auditCommands } from "./audit/spec";
import { attestedKeyCommands } from "./attested-key/spec";
import { accountCommands } from "./account/spec";
import { billingCommands } from "./billing/spec";
import { memberCommands } from "./member/spec";
import { publishableKeyCommands } from "./publishable-key/spec";
import { attestationCommands } from "./attestation/spec";
import { providerKeyCommands } from "./provider-key/spec";
import { secretSourceCommands } from "./secret-source/spec";
import { routeCommands } from "./route/spec";
import { agentCommands } from "./agent/spec";
import { agentToolCommands } from "./agent-tool/spec";
import { quotaCommands } from "./quota/spec";
import { revenuecatCommands } from "./revenuecat/spec";
import { killSwitchCommands } from "./kill-switch/spec";
import { mediaRouteCommands } from "./media-route/spec";
import { voiceIdentityCommands } from "./voice-identity/spec";
import { mediaQuotaCommands } from "./media-quota/spec";
import { mcpCommands } from "./mcp/spec";
import { selftestCommands } from "./selftest/spec";
import { upgradeCommands } from "./upgrade/spec";
import { dashboardCommands } from "./dashboard/spec";
import { apiCommands } from "./api/spec";
import { initCommands } from "./init/spec";
import { setupCommands } from "./setup/spec";

/**
 * Every VISIBLE fragment, concatenated. Order here is the catalog/help order. The
 * RESERVED trees are NOT here — they live behind the `buildReservedSpecs()` factory
 * and are appended ONLY in a `SHIP_RESERVED` build (T-210 §A). Every reserved noun lives
 * in that factory, so a default build carries none of them.
 */
const VISIBLE_SPECS: AnyCommandSpec[] = [
  ...versionCommands,
  ...whoamiCommands,
  ...statusCommands,
  ...configCommands,
  ...profileCommands,
  ...projectCommands,
  ...issuerCommands,
  ...planCommands,
  ...loginCommands,
  ...logoutCommands,
  ...tokenCommands,
  // T-299: the ACCOUNT-tier OAuth-grant plane (tokens family, same scopes as `token`) — the last
  // of the 4 UNSURFACED_OPS. `revoke` is direct_confirm + mcpExcluded, like its four siblings.
  ...grantCommands,
  ...usageCommands,
  ...endUserCommands,
  ...mediaUsageCommands,
  ...mediaJobCommands,
  ...auditCommands,
  ...attestedKeyCommands,
  // T-215 (L2-CLI-10): the account / identity / billing plane.
  ...accountCommands,
  ...billingCommands,
  ...memberCommands,
  // T-216 (project plane A): the publishable-key noun (alias `pk`) + the attestation noun.
  ...publishableKeyCommands,
  ...attestationCommands,
  // T-217 (project plane B): the provider-key noun + the route noun.
  ...providerKeyCommands,
  ...routeCommands,
  // T-227 (S5b): the operator allowlist for indirect secret sources — the CLI-only declaration
  // surface the MCP `SecretRef` env/file arms are checked against.
  ...secretSourceCommands,
  // T-218 (sub-wave B): the agents plane — agent profiles + their tools (agent-tool).
  ...agentCommands,
  ...agentToolCommands,
  // T-219 (sub-wave B): the billing-config & limits plane — quota / revenuecat / kill-switch.
  ...quotaCommands,
  ...revenuecatCommands,
  ...killSwitchCommands,
  // T-220 (sub-wave B): the media plane — media-route / voice-identity (alias `voice`) / media-quota.
  ...mediaRouteCommands,
  ...voiceIdentityCommands,
  ...mediaQuotaCommands,
  // T-222 (sub-wave C): the service plane — the mcp noun (stdout-takeover MCP handoff), the
  // selftest noun (the bare end-to-end diagnostic), and the upgrade noun (evidence-based self-update).
  ...mcpCommands,
  ...selftestCommands,
  ...upgradeCommands,
  ...dashboardCommands,
  // T-222 step 10c: the `api` raw wire door (get/post/put/patch/delete over a raw management path).
  ...apiCommands,
  // T-221: the onboarding ORCHESTRATOR (`agkit init`) — checkout to a working project in one run.
  ...initCommands,
  // T-224: the LOCAL provisioning command (`agkit setup`) — skill tree, MCP registration, AGENTS.md.
  ...setupCommands,
];

export class RegistryError extends Error {
  override name = "RegistryError";
}

/** The stable command key `<noun> <verb>` used for dedup + lookup. */
export function commandKey(spec: Pick<CommandSpec, "noun" | "verb">): string {
  return `${spec.noun} ${spec.verb}`;
}

/**
 * Commands that legitimately skip the T-212 mutation-ceremony load-check (invariant (i)):
 * every NON-reserved remote spec with danger ∈ {M,D,PR} must otherwise declare a `mutation`
 * binding (its write path). `plan discard` is the ONE durable ceremony-exempt member (D3:
 * zero-side-effect cleanup — the future T-222 selftest write probe; a plan ceremony to
 * discard a plan would be circular theater).
 *
 * S7 landed: the three formerly-staged shipped mutations (project create/archive, issuer
 * create) now declare `mutation: {kind:"plan"}` and run the fused ceremony — the S2
 * staging entries are gone and the count-pin test in registry.test.ts pins this set at
 * exactly one member.
 */
export const CEREMONY_EXEMPT: ReadonlySet<string> = new Set(["plan discard"]);

/**
 * Remote mutating commands that legitimately run NO management plan/apply ceremony — a
 * different confirmation model, NOT the "zero-side-effect cleanup" CEREMONY_EXEMPT is for:
 *   • login create / logout clear — OAuth-boundary lifecycle flows; the interactive browser/
 *     device consent IS the confirmation; they are not management-envelope writes.
 *   • token create — management_token.create is gating:"direct" + secret_bearing:"response"
 *     (a shown-once mint incompatible with plan/apply) and danger M (so ineligible for
 *     direct_confirm, which invariant (ii) restricts to D/PR). A legitimate direct mutation.
 * The guard still fires for any OTHER remote mutating command that forgets its binding.
 *
 * Distinct from CEREMONY_EXEMPT in BOTH direction and teeth: CEREMONY_EXEMPT keys are skipped by
 * the dispatch hook (build-cli runSpec) and must carry NO mutation binding (F-C1); these keys
 * simply do not require one from invariant (i), and the dispatch hook still gates their ceremony
 * on `spec.mutation` (which they lack), so no plan/apply runs. Membership is guarded below: only an
 * M-class REMOTE MUTATION may claim this exemption — a D/PR (or non-remote / non-mutating) member
 * is REJECTED at load, so a destructive op can never be silently exempted this way.
 */
export const NON_CEREMONY_REMOTE_MUTATIONS: ReadonlySet<string> = new Set([
  "login create",
  "logout clear",
  "token create",
  // T-216 R6: publishable-key create is an M-class shown-once mint — a direct mint returns no Plan,
  // so it is plan-INCOMPATIBLE (the token-create rationale verbatim). Passes the M-class-remote teeth.
  "publishable-key create",
  // T-217: credential.create is gating:"direct" + secret_bearing:"request" and danger M — the
  // token-create precedent exactly (a secret-channel write incompatible with plan/apply). NO
  // banner/confirm/--yes; the PROD-REBINDING ceremony fires only on the PR plan kinds.
  "provider-key add",
  // T-222: `selftest run` is danger M — its write probe performs a real plan.create/plan.discard
  // round-trip — but the probe IS the plan machinery's own test, so a plan/apply ceremony would be
  // theater (the token-create rationale). It carries NO `spec.mutation`, so the dispatch hook runs
  // no ceremony; this membership satisfies invariant (i) for an M-class remote mutation.
  "selftest run",
  // T-221: `init run` is a MULTI-PLAN orchestrator — plan ceremonies run INSIDE the handler via
  // the core/plan spine (commands/init/plan-leg.ts reuses the ceremony's own `assertPlanApplyable`
  // + `maxDanger` + `narrowPlan` + `renderPlan`). A `mutation` binding resolves exactly ONE plan
  // BEFORE the handler runs, so it cannot express "plan A → apply → mint → write → plan B →
  // confirm → apply". The exemption is from invariant (i)'s binding requirement ONLY: no
  // confirmation model is skipped — a PR plan still gets its own diff + typed confirm, and `--yes`
  // still never satisfies one. Passes the M-class-remote teeth (danger M, execution remote).
  "init run",
]);

/**
 * Validate + freeze a set of fragments into the registry. Exported so the
 * invariant test can feed it deliberately-broken fixtures and assert it throws
 * (the negative fixtures) without corrupting the real module-level registry.
 */
export function assembleRegistry(
  fragments: AnyCommandSpec[],
  reservedAllowed = false,
): readonly AnyCommandSpec[] {
  const seen = new Set<string>();

  for (const spec of fragments) {
    const where = `${spec.noun ?? "?"} ${spec.verb ?? "?"}`;

    // T-210: a reserved spec is legal ONLY in the flag-on registry branch (which passes
    // `reservedAllowed`). In the DEFAULT assembly a reserved spec hand-added to
    // VISIBLE_SPECS would SHIP its bytes while being merely view-filtered from help —
    // and would bypass the closed-vocab verb check below (reserved verbs validate in the
    // byte-gated factory). Fail closed at import instead.
    if (spec.reserved && !reservedAllowed) {
      throw new RegistryError(
        `reserved command in a default (flag-off) assembly — reserved specs may only enter via the SHIP_RESERVED branch (${where})`,
      );
    }

    // required-field presence (deliverable 6 / acceptance "any of the fields missing")
    if (!spec.noun) throw new RegistryError(`command is missing 'noun' (${where})`);
    // noun must be lower-kebab so the MCP tool-name derivation stays injective
    // (mcp-metadata.ts `noun.replaceAll("-","_")`) — a stray underscore would let two
    // distinct nouns (`a-b` and `a_b`) silently fold to the same `agkit_a_b_*` tool.
    if (!isKebabNoun(spec.noun)) {
      throw new RegistryError(`noun '${spec.noun}' is not lower-kebab '[a-z0-9]+(-[a-z0-9]+)*' (${where})`);
    }
    if (!spec.verb) throw new RegistryError(`command is missing 'verb' (${where})`);
    if (!spec.summary) throw new RegistryError(`command is missing 'summary' (${where})`);
    if (!spec.args) throw new RegistryError(`command is missing 'args' schema (${where})`);
    if (typeof spec.handler !== "function") {
      throw new RegistryError(`command is missing a 'handler' function (${where})`);
    }
    // danger: present AND a member of the closed set (mirrors the verb check).
    // `danger: Danger` is compile-time only; a loosely-typed or typo'd value
    // (e.g. "sr") would otherwise pass and be MIS-projected as a mutation.
    if (!isDanger(spec.danger)) {
      throw new RegistryError(
        `danger '${String(spec.danger)}' is not one of ${DANGERS.join("/")} (${where})`,
      );
    }

    // FORBIDDEN: a command with no output-schema `$id`
    if (!spec.outputSchemaId) {
      throw new RegistryError(`command is missing 'outputSchemaId' ($id) (${where})`);
    }

    // deliverable 5: closed verb vocabulary — `toggle` is called out by name (for ALL
    // specs, reserved or not).
    if (spec.verb === "toggle") {
      throw new RegistryError(
        `verb 'toggle' is banned (${where}): use the enable/disable pair from the closed vocabulary`,
      );
    }
    // Visible specs are checked against the live `VERB_VOCABULARY`. RESERVED specs use the
    // BYTE-GATED reserved verb vocab (commands/reserved/reserved-verbs.ts) — kept off the
    // live graph so a default build has no reserved verb strings — and the reserved FACTORY
    // (build.ts) validates their verbs at construction, so we skip the closed-vocab check
    // here for them (T-210 §C). Adding reserved verbs to the live `VERB_VOCABULARY` would
    // leak them into the default bundle.
    if (!spec.reserved && !isKnownVerb(spec.verb)) {
      throw new RegistryError(`verb '${spec.verb}' is not in the closed vocabulary (${where})`);
    }

    // scopes must name a registered family at a valid level (typos fail closed)
    if (!Array.isArray(spec.scopes)) {
      throw new RegistryError(`command 'scopes' must be an array (${where})`);
    }
    for (const scope of spec.scopes) {
      if (!isValidScope(scope)) {
        throw new RegistryError(`scope '${scope}' is not a registered <family>:<level> (${where})`);
      }
    }

    // T-222 S1: the stdout-takeover dispatch class (`mcp serve`). A takeover handler owns
    // stdout end-to-end, bypassing the serializer chokepoint — so the class is locked to the
    // narrowest possible shape: local, safe-read, zero scopes, no mutation binding, and never
    // projected as an MCP tool (non-empty mcpExclude — the self-hosting paradox). Checked
    // BEFORE the mutation invariants so a takeover fault reports as itself.
    if (spec.stdoutTakeover) {
      if (spec.execution !== "local") {
        throw new RegistryError(
          `stdoutTakeover requires execution:"local" (got '${String(spec.execution)}') (${where})`,
        );
      }
      if (spec.danger !== "SR") {
        throw new RegistryError(`stdoutTakeover requires danger "SR" (got '${String(spec.danger)}') (${where})`);
      }
      if (spec.scopes.length > 0) {
        throw new RegistryError(`stdoutTakeover requires zero scopes (${where})`);
      }
      if (spec.mutation) {
        throw new RegistryError(`stdoutTakeover command must not declare 'mutation' (${where})`);
      }
      if (typeof spec.mcpExclude !== "string" || spec.mcpExclude.length === 0) {
        throw new RegistryError(`stdoutTakeover requires a non-empty 'mcpExclude' reason (${where})`);
      }
    }

    // T-227 S5b: the MCP-SURFACE override (commands/mcp-surface.ts). It shapes what the MCP tool
    // ADVERTISES and what dispatch PARSES, so every guard here is a fail-closed one: a malformed
    // override would either advertise a schema no call can satisfy or hand the handler an input its
    // own contract never described. Checked BEFORE the positional/example loops so a surface fault
    // reports as itself.
    if (spec.mcpSurface) {
      const surface = spec.mcpSurface;
      // An excluded command has no MCP surface at all — declaring one is a contradiction that would
      // read as "this is exposed" to a reviewer while `mcpProjection` kept returning null.
      if (typeof spec.mcpExclude === "string" && spec.mcpExclude.length > 0) {
        throw new RegistryError(`mcpSurface on an mcpExcluded command — an excluded command has no MCP surface (${where})`);
      }
      if (spec.reserved) {
        throw new RegistryError(`mcpSurface on a RESERVED command — reserved specs are never projected (${where})`);
      }
      if (!surface.args) throw new RegistryError(`mcpSurface is missing its 'args' schema (${where})`);
      if (!surface.summary) throw new RegistryError(`mcpSurface is missing its 'summary' (${where})`);
      // Over MCP the ONLY write door is the plan/apply gate: a derived mutation tool is annotated
      // "returns a Plan the gated executor applies", so a non-plan binding here would make that
      // annotation a lie and hand an MCP host an ungated write.
      if (surface.mutation && surface.mutation.kind !== "plan") {
        throw new RegistryError(
          `mcpSurface.mutation must be kind:"plan" (got '${String(surface.mutation.kind)}') — the MCP surface has no direct write door (${where})`,
        );
      }
      const surfaceShape = (surface.args as { shape?: Record<string, unknown> }).shape;
      if (surface.secret) {
        if (!surfaceShape || !Object.prototype.hasOwnProperty.call(surfaceShape, surface.secret.arg)) {
          throw new RegistryError(
            `mcpSurface.secret.arg '${surface.secret.arg}' is not a key in the mcpSurface args shape (${where})`,
          );
        }
        if (typeof surface.secret.resolve !== "function") {
          throw new RegistryError(`mcpSurface.secret declares no 'resolve' function (${where})`);
        }
      }
      // The MCP twin of the "every example parses" invariant below: the sweeps that drive EVERY
      // advertised branch read this example, so an unparseable one is a branch nobody exercises.
      const parsedExample = surface.args.safeParse(surface.example);
      if (!parsedExample.success) {
        throw new RegistryError(
          `mcpSurface.example does not parse against mcpSurface.args (${where}): ${parsedExample.error.message}`,
        );
      }
    }

    // T-212 invariant (iii): a declared positional must name a real key in the zod args shape
    // (the dispatcher maps the leftover non-flag token onto input[key] before the parse), and
    // (F-G2) that key must be a REQUIRED STRING field — an optional key would let a missing
    // token silently parse; a boolean/nullable key would coerce the injected token. Probe-based
    // (zod-version-independent): the field must REJECT undefined/null/true/42. Checked BEFORE
    // the example loop so a positional fault reports as itself, not as an example-parse failure.
    if (spec.positional) {
      const shape = (spec.args as { shape?: Record<string, unknown> }).shape;
      if (!shape || !Object.prototype.hasOwnProperty.call(shape, spec.positional.key)) {
        throw new RegistryError(
          `positional.key '${spec.positional.key}' is not a key in the command's args shape (${where})`,
        );
      }
      const field = shape[spec.positional.key] as {
        safeParse: (v: unknown) => { success: boolean; data?: unknown };
      };
      const rejects = (v: unknown): boolean => !field.safeParse(v).success;
      if (spec.positional.optional) {
        // T-216 S3 (RR-4c) — OPTIONAL mode. A MISSING token must parse to an ABSENT key, never a
        // manufactured value. Success alone is NOT enough: a `.default("x")` or `.transform()` field
        // ALSO "accepts" undefined but yields injected `data !== undefined` — a missing token would
        // silently become a value (RegistryError). So probe THREE facts, zod-version-independently:
        //   (1) safeParse(undefined) SUCCEEDS with `data === undefined` (a plain optional string);
        //   (2) a representative string parses to ITSELF (identity — a transform that mangles the
        //       token is a RegistryError);
        //   (3) null/true/42 are still REJECTED (no coercion).
        // Declaring `optional:true` over a REQUIRED key fails (1) (undefined → parse failure); the
        // key must be a plain optional string.
        const u = field.safeParse(undefined);
        const s = field.safeParse("proj_probe");
        if (
          !u.success ||
          (u as { data?: unknown }).data !== undefined ||
          !s.success ||
          (s as { data?: unknown }).data !== "proj_probe" ||
          !rejects(null) ||
          !rejects(true) ||
          !rejects(42)
        ) {
          throw new RegistryError(
            `optional positional.key '${spec.positional.key}' must be a PLAIN optional string ` +
              `(a missing token must parse to an absent key, never a manufactured/transformed value) (${where})`,
          );
        }
      } else {
        // F-G2 — REQUIRED mode: the field must REJECT undefined/null/true/42 (declaring required
        // mode over an OPTIONAL key fails here, since undefined parses).
        if (!rejects(undefined) || !rejects(null) || !rejects(true) || !rejects(42)) {
          throw new RegistryError(
            `positional.key '${spec.positional.key}' must be a required string field (${where})`,
          );
        }
      }
    }

    // FORBIDDEN: a command with no example
    if (!Array.isArray(spec.examples) || spec.examples.length < 1) {
      throw new RegistryError(`command must declare >=1 example (${where})`);
    }
    // deliverable 6: every example must parse against the command's own arg schema. T-212:
    // POSITIONAL-aware — a positional-bearing spec's example maps its trailing token onto the
    // positional key before the parse (else a required positional key would fail here). F-G2:
    // a wrong positional CARDINALITY in an example (0 or 2+) throws inside exampleInput and is
    // surfaced as a RegistryError here — an explicit failure, never a silent drop.
    for (const example of spec.examples) {
      let input: Record<string, FlagValue>;
      try {
        input = exampleInput(spec, example);
      } catch (err) {
        throw new RegistryError(`example positional cardinality (${where}): ${err instanceof Error ? err.message : String(err)}`);
      }
      const parsed = spec.args.safeParse(input);
      if (!parsed.success) {
        throw new RegistryError(
          `example does not parse against its arg schema (${where}): ${JSON.stringify(example)} -> ${parsed.error.message}`,
        );
      }
    }

    // deliverable 6: every mutating command has a danger class (checked above),
    // and every D/PR command has typed-confirm wiring
    if (requiresTypedConfirm(spec.danger) && !spec.confirm) {
      throw new RegistryError(
        `command is danger '${spec.danger}' but declares no typed-confirm wiring ('confirm') (${where})`,
      );
    }
    // a non-mutating command must NOT claim confirm (keeps the classification honest)
    if (!isMutating(spec.danger) && spec.confirm) {
      throw new RegistryError(`safe-read command must not declare 'confirm' (${where})`);
    }

    // T-219 S-A: `confirm.requireReason` has TEETH (N-011 A506 note ⁷ — the kill-switch-engage
    // asymmetry is REGISTRY DATA, not prose). A spec declaring `requireReason:true` must (a) be a
    // mutation (a read has no reason to demand one), (b) carry a `reason` key in its arg shape, and
    // (c) actually REQUIRE it: its first example, re-parsed with `reason` deleted, must FAIL the
    // parse. (c) is the load-bearing half — an `.optional()`/`.default("x")` reason would silently
    // manufacture an audit trail the operator never wrote, which is exactly what this invariant
    // exists to make unrepresentable.
    if (spec.confirm?.requireReason === true) {
      if (!isMutating(spec.danger)) {
        throw new RegistryError(`'confirm.requireReason' on a non-mutating command (${where})`);
      }
      const shape = (spec.args as { shape?: Record<string, unknown> }).shape ?? {};
      if (!Object.prototype.hasOwnProperty.call(shape, "reason")) {
        throw new RegistryError(
          `'confirm.requireReason' declared but the arg shape has no 'reason' key (${where})`,
        );
      }
      const firstExample = spec.examples[0]!;
      let reasonProbe: Record<string, FlagValue>;
      try {
        reasonProbe = exampleInput(spec, firstExample);
      } catch {
        // Unreachable: the example-parses invariant above already surfaced a cardinality fault.
        reasonProbe = {};
      }
      delete reasonProbe["reason"];
      if (spec.args.safeParse(reasonProbe).success) {
        throw new RegistryError(
          `'confirm.requireReason' declared but the example parses WITHOUT 'reason' — the flag is optional or defaulted, not required (${where})`,
        );
      }
    }

    // T-212 invariant (i): a NON-reserved remote MUTATING spec must declare a `mutation`
    // binding (its write path) unless its commandKey is ceremony-exempt OR is a documented
    // non-ceremony remote mutation (T-213 auth/mint commands whose confirmation model is not a
    // management plan/apply). A-4: scoped to `!spec.reserved` — reserved D/PR specs (which carry
    // no `mutation` field) load clean.
    if (
      !spec.reserved &&
      spec.execution === "remote" &&
      isMutating(spec.danger) &&
      !spec.mutation &&
      !CEREMONY_EXEMPT.has(commandKey(spec)) &&
      !NON_CEREMONY_REMOTE_MUTATIONS.has(commandKey(spec))
    ) {
      throw new RegistryError(
        `remote mutating command declares no 'mutation' binding and is not ceremony-exempt (${where})`,
      );
    }

    // T-213 merge-integration invariant — the TEETH of NON_CEREMONY_REMOTE_MUTATIONS: a member of
    // that set may ONLY be an M-class REMOTE MUTATION. A destructive/prod-rebinding (D/PR) op can
    // NEVER be silently exempted from the ceremony this way (invariant (ii) reserves the
    // direct_confirm door for D/PR; this reserves the no-ceremony exemption for M), and a
    // non-remote / non-mutating command has no business in the set at all. Checked per-spec so
    // the exemption is only ever usable exactly where it is legitimate; T-212's guard above stays
    // in force for every OTHER remote mutating command that forgets its binding.
    if (NON_CEREMONY_REMOTE_MUTATIONS.has(commandKey(spec))) {
      if (spec.execution !== "remote" || !isMutating(spec.danger) || requiresTypedConfirm(spec.danger)) {
        throw new RegistryError(
          `command is in NON_CEREMONY_REMOTE_MUTATIONS but is not an M-class remote mutation ` +
            `(execution='${String(spec.execution)}', danger='${String(spec.danger)}') — the no-ceremony ` +
            `exemption is only for M-class direct remote mutations; a D/PR op can never be exempted this way (${where})`,
        );
      }
    }

    // T-212 invariant (ii): a direct_confirm mutation is only legal on a typed-confirm danger
    // (D/PR) — it is the emergency door for destructive / prod-rebinding ops.
    if (spec.mutation?.kind === "direct_confirm" && !requiresTypedConfirm(spec.danger)) {
      throw new RegistryError(
        `direct_confirm mutation requires danger D/PR (got '${spec.danger}') (${where})`,
      );
    }

    // T-215 Seam-1 invariant: an M-class `direct` mutation (the no-typed-challenge money-path door,
    // billing checkout/portal) is legal ONLY at danger M, execution "remote", and MUST carry no
    // typed-confirm wiring — a `confirm`-bearing op may never ride the no-challenge door (its typed
    // authority would be unreachable). The mirror of invariant (ii): (ii) reserves the D/PR
    // direct_confirm door; this reserves the M direct door.
    if (spec.mutation?.kind === "direct") {
      if (spec.danger !== "M") {
        throw new RegistryError(`direct mutation requires danger M (got '${spec.danger}') (${where})`);
      }
      if (spec.execution !== "remote") {
        throw new RegistryError(
          `direct mutation requires execution:"remote" (got ${String(spec.execution)}) (${where})`,
        );
      }
      if (spec.confirm) {
        throw new RegistryError(
          `direct mutation must not declare typed-confirm wiring ('confirm') — a typed-confirm op ` +
            `may not ride the no-challenge door (${where})`,
        );
      }
    }

    // T-212 F-C1: a CEREMONY_EXEMPT key with a `mutation` binding is a FAIL-OPEN hazard — the
    // dispatch hook (build-cli runSpec) skips the ceremony for exempt keys, so the binding's
    // write would run with NO plan, NO prompt, NO halt. The registry refuses the combination.
    if (spec.mutation && CEREMONY_EXEMPT.has(commandKey(spec))) {
      throw new RegistryError(
        `ceremony-exempt command must not declare a 'mutation' binding — the dispatch hook would skip its ceremony (fail-open) (${where})`,
      );
    }

    // deliverable 6: every prompt has a flagEquivalent
    for (const prompt of spec.prompts ?? []) {
      if (!prompt.flagEquivalent || !prompt.flagEquivalent.startsWith("--")) {
        throw new RegistryError(
          `prompt '${prompt.name}' must declare a '--' flagEquivalent (${where})`,
        );
      }
    }

    // T-210: a spec that mirrors a byte-pinned management route (carries a
    // `reservedRoute`) MUST be flagged `reserved` — otherwise it would LEAK into the
    // default build's visible surface. This is the durable negative-control invariant
    // (__fixtures__/leaked-spec reddens the reserved-leak test against it).
    if (spec.reservedRoute && !spec.reserved) {
      throw new RegistryError(
        `command carries a reservedRoute but is not marked 'reserved' (would leak) (${where})`,
      );
    }

    // T-210 §D: every RESERVED command is remote and declares a NON-EMPTY set of
    // capabilities (NEVER inferred from scopes). The vocab-SUBSET check — caps ⊆ the
    // closed reserved capability vocab (the T-211 seam) — lives in the byte-gated
    // reserved factory (reserved/build.ts) so the vocab strings stay absent from a
    // default build; here we keep only the vocab-free structural guards.
    if (spec.reserved) {
      if (spec.execution !== "remote") {
        throw new RegistryError(
          `reserved command must declare execution:"remote" (got ${String(spec.execution)}) (${where})`,
        );
      }
      const caps = spec.requiredCapabilities ?? [];
      if (caps.length === 0) {
        throw new RegistryError(`reserved command must declare >=1 requiredCapabilities (${where})`);
      }
    }

    // dedup: exactly one command per (noun, verb)
    const key = commandKey(spec);
    if (seen.has(key)) throw new RegistryError(`duplicate command '${key}'`);
    seen.add(key);
  }

  // T-213 (decision k): a `bare: true` command surfaces as `agkit <noun>` (build-cli), so it must
  // be the ONLY visible command for its noun — a bare surface can carry no sibling subcommands.
  // Checked ACROSS the whole set (per-noun visible count), after the per-spec loop above.
  const visibleByNoun = new Map<string, number>();
  for (const spec of fragments) {
    if (spec.reserved) continue;
    visibleByNoun.set(spec.noun, (visibleByNoun.get(spec.noun) ?? 0) + 1);
  }
  for (const spec of fragments) {
    if (spec.bare && !spec.reserved && (visibleByNoun.get(spec.noun) ?? 0) !== 1) {
      throw new RegistryError(
        `bare command '${commandKey(spec)}' must be the ONLY visible command for noun '${spec.noun}' ` +
          `(a bare surface carries no sibling subcommands)`,
      );
    }
  }

  // T-216 (S1/R12): NOUN-ALIAS load-checks (a `pk` alias for `publishable-key`). A noun alias is a
  // second shell token that routes to the noun, so it must be UNAMBIGUOUS against every top-level
  // shell token. Checked ACROSS the whole set (needs the full noun ∪ alias universe), after the
  // per-spec loop. Reserved specs carry no nounAliases; they participate only as noun-name occupants.
  //   (a) every spec of a noun declares the IDENTICAL alias set (a spec-local alias would let one
  //       verb be reachable under `pk` while a sibling was not — an inconsistent surface);
  //   (b) every alias is lower-kebab (so build-cli group registration + MCP injectivity hold);
  //   (c) no self-alias (`alias === own noun`) and no duplicate within one noun's set;
  //   (d) collision-free against ALL top-level shell tokens: every registry noun, every OTHER
  //       noun's aliases, and the single-sourced non-registry tokens (TOP_LEVEL_VERB_ALIASES keys
  //       + `reference` + `help`, via RESERVED_TOP_LEVEL_TOKENS) — an ambiguous alias could shadow
  //       a real command.
  const aliasesByNoun = new Map<string, readonly string[]>();
  for (const spec of fragments) {
    const declared = spec.nounAliases ?? [];
    if (!aliasesByNoun.has(spec.noun)) {
      aliasesByNoun.set(spec.noun, declared);
    } else {
      const first = aliasesByNoun.get(spec.noun)!;
      const same = first.length === declared.length && first.every((a, i) => a === declared[i]);
      if (!same) {
        throw new RegistryError(
          `noun '${spec.noun}' declares INCONSISTENT nounAliases across its specs ` +
            `([${first.join(", ")}] vs [${declared.join(", ")}]) — every spec of a noun must declare the IDENTICAL set (${spec.noun} ${spec.verb})`,
        );
      }
    }
  }
  const allNouns = new Set<string>(fragments.map((s) => s.noun));
  for (const [noun, aliases] of aliasesByNoun) {
    if (aliases.length === 0) continue;
    // The reserved universe THIS noun's aliases may not collide with: all nouns + every OTHER
    // noun's aliases + the non-registry top-level tokens.
    const reserved = new Set<string>([...allNouns, ...RESERVED_TOP_LEVEL_TOKENS]);
    for (const [otherNoun, otherAliases] of aliasesByNoun) {
      if (otherNoun === noun) continue;
      for (const a of otherAliases) reserved.add(a);
    }
    const seenAlias = new Set<string>();
    for (const alias of aliases) {
      if (!isKebabNoun(alias)) {
        throw new RegistryError(`noun alias '${alias}' (noun '${noun}') is not lower-kebab`);
      }
      if (alias === noun) {
        throw new RegistryError(`noun '${noun}' declares itself as a nounAlias (self-alias)`);
      }
      if (seenAlias.has(alias)) {
        throw new RegistryError(`noun '${noun}' declares duplicate nounAlias '${alias}'`);
      }
      seenAlias.add(alias);
      if (reserved.has(alias)) {
        throw new RegistryError(
          `noun alias '${alias}' (noun '${noun}') collides with an existing top-level shell token ` +
            `(a registry noun, another noun's alias, or a reserved command: apply/reference/help)`,
        );
      }
    }
  }

  return Object.freeze([...fragments]);
}

/**
 * THE registry. Assembled + validated at import — a bad fragment throws here and
 * the whole CLI refuses to start (fail fast). Every generator maps over this.
 *
 * T-210 §A — the flag-gated ternary is the byte-absence mechanism. With
 * `__AGKIT_SHIP_RESERVED__` `define`d `false` (the default build), esbuild folds this
 * to `assembleRegistry(VISIBLE_SPECS)`, the `buildReservedSpecs()` call becomes dead
 * code, and the reserved factory + its whole import graph tree-shake out of the bundle
 * (proven by the SENTINEL leg in `scripts/pack-probes.sh`). A `SHIP_RESERVED=1` build
 * appends the 42 reserved commands, which surface in `--help`/`reference`/`reference --json`
 * (but NEVER in MCP `tools/list` — mcpProjection excludes them unconditionally, and
 * NEVER in the committed skill — always the flag-off artifact). In unbuilt source
 * (vitest/dev) `SHIP_RESERVED` is `false`, so the default suite + the drift-locked
 * skill see the reserved-free registry; tests reach the reserved specs by importing
 * `buildReservedSpecs()` directly.
 */
// DCE-CRITICAL: the flag guard is written INLINE in the ternary CONDITION (not via an
// intermediate const/var, and not via the imported `SHIP_RESERVED`). tsup runs esbuild
// WITHOUT minify, so esbuild will NOT inline an intermediate `var x = false; x ? …` into
// the branch (that needs minify) — but it DOES constant-fold a literal condition written
// in place and drop the dead branch. With `__AGKIT_SHIP_RESERVED__` `define`d `false`,
// `typeof false !== "undefined" && false` folds to `false` HERE, the ternary folds to
// `VISIBLE_SPECS`, and the `buildReservedSpecs()` call + its whole module graph (the
// reserved trees + the shared knowledge validator) tree-shake out of the bundle (proven
// by the SENTINEL leg in `scripts/pack-probes.sh`). The `typeof` keeps unbuilt source
// (vitest) `false` with no ReferenceError.
export const registry: readonly AnyCommandSpec[] =
  typeof __AGKIT_SHIP_RESERVED__ !== "undefined" && __AGKIT_SHIP_RESERVED__
    ? assembleRegistry([...VISIBLE_SPECS, ...buildReservedSpecs()], true)
    : assembleRegistry(VISIBLE_SPECS);

// --- lookups + views ---------------------------------------------------------

/** Commands visible in the live CLI + MCP surface (reserved ones are hidden, RN-5). */
export function visibleCommands(specs: readonly AnyCommandSpec[] = registry): AnyCommandSpec[] {
  return specs.filter((s) => !s.reserved);
}

/** Reserved (registered-but-not-yet-available) commands (RN-5). */
export function reservedCommands(specs: readonly AnyCommandSpec[] = registry): AnyCommandSpec[] {
  return specs.filter((s) => Boolean(s.reserved));
}

/**
 * Every token that can stand at the HEAD of a command line — each visible noun and noun alias,
 * plus `RESERVED_TOP_LEVEL_TOKENS` (the top-level verb alias `apply`, `reference`, `completion`,
 * yargs' `help`). DERIVED from the registry, so a new noun joins without an edit.
 *
 * ISS-226's one consumer: when yargs has ALREADY failed, `run.ts` asks whether a leading
 * value-taking global flag ate one of these — `agkit --json apply plan_x` reads as `json="apply"`
 * and yargs then reports the wrong token. Membership here is what separates that mistake from a
 * legitimate `agkit --profile ci route list`, so it must be the SHIPPED head set, never a literal.
 */
export const TOP_LEVEL_COMMAND_TOKENS: ReadonlySet<string> = new Set<string>([
  ...RESERVED_TOP_LEVEL_TOKENS,
  ...visibleCommands().flatMap((spec) => [spec.noun, ...(spec.nounAliases ?? [])]),
]);

/** Group commands by noun, preserving registry order within each group. */
export function commandsByNoun(
  specs: readonly AnyCommandSpec[] = registry,
): Map<string, AnyCommandSpec[]> {
  const byNoun = new Map<string, AnyCommandSpec[]>();
  for (const spec of specs) {
    const group = byNoun.get(spec.noun);
    if (group) group.push(spec);
    else byNoun.set(spec.noun, [spec]);
  }
  return byNoun;
}
