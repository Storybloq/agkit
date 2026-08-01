// CommandSpec — the ONE typed shape every `agkit` command is authored as (T-204,
// canonical L2-CLI-02, deliverable 2). A single `CommandSpec[]` registry is the
// SOLE source from which four artifacts are generated (registry.ts assembles the
// per-noun fragments; src/commands/generators/* project them):
//
//   1. the yargs shell + `--help`      (src/cli/, deliverable 4a)
//   2. `reference.md` full catalog     (deliverable 4b)
//   3. `reference --json` machine reg  (deliverable 4c)
//   4. per-command MCP tool metadata   (deliverable 4d — consumed by L3-M1)
//
// Because all four derive from this array, deleting a `spec.ts` fragment removes
// its command from every artifact at once (T-204 acceptance) — there is no second
// place to forget.
//
// The field set is normative (N-011 §APX-D, D3 §11). See registry.ts for the
// load-time invariants and registry.test.ts for the zod-validated shape checks.
import type { ZodType } from "zod";
import type { OutputConfig } from "../core/output/config";
import type { ResolvedCredential } from "../core/auth/types";
import type { KeyringPort } from "../core/auth/keyring";
import type { ClientFlags } from "../core/client/flags";
import type { Resolved } from "../core/config";
// RUNTIME import (a real module edge): safe because core/errors imports NOTHING from
// commands/** — no cycle exists or may be introduced (verified; keep it that way). It is the
// EXISTING CLI-local error machinery — F0 mints no new code.
import { CliLocalError } from "../core/errors";
// TYPE-ONLY import (T-222 S4): `typeof EXIT.RETRYABLE | typeof EXIT.TERMINAL` restricts
// `CommandResult.verdictExit` to the closed taxonomy BY TYPE; erased at build (and
// exit-codes.ts has zero imports, so even a value import could not cycle).
import type { EXIT } from "../core/errors/exit-codes";
// TYPE-ONLY import (A18): the generated management DTO surface erases at build, so naming it
// here can NEVER drag the fs-reading api-only `wire-contract/management` module into the CLI
// bundle. It is the ONLY management-contract module the seam is allowed to reference.
import type { ManagementPlan, Operations } from "@agentkit-cloud/shared/wire-contract/management-types.gen";
// TYPE-ONLY import (T-212): the plan-change shape a mutation binding produces. core/plan/types
// references THIS module RUNTIME-only (the `Danger` helpers), so this back-edge is type-only
// and erases at build — NO runtime cycle (verified; keep it that way).
import type { PlanChange } from "../core/plan/types";
// TYPE-ONLY import (T-213/T-222): the auth/service seam interfaces `Ctx` references live in
// ./command-seams (extracted for the max-lines cap). Type-only ⇒ erased at build; this module
// re-exports them + the require*/DTO helpers below so consumers keep importing from ./types.
import type { AuthCommandSeam, ServiceCommandSeam } from "./command-seams";
// T-221: same pattern for the runtime's OPTIONAL prompt/fs seams — `CliRuntime` extends them.
import type { RuntimeIoSeams } from "./runtime-io";
// T-227 S5b: same pattern for the per-command MCP-surface override (type-only ⇒ erased; the module
// imports only TYPES back from here, so the pair can never become a runtime cycle).
import type { McpSurface } from "./mcp-surface";

// --- danger classification (N-011 §APX-A column legend) ----------------------
//   SR = safe read · M = mutating · D = destructive · PR = prod-rebinding.
// A route may carry two badges on the wire (e.g. `PR+D`); the CLI records the
// dominant class here and the drift-lock (L2-CLI-23) reconciles the pair.
export type Danger = "SR" | "M" | "D" | "PR";

/**
 * The closed danger set as a runtime array — the registry load-check validates
 * `danger` against THIS (exactly as `verb` is validated against VERB_VOCABULARY),
 * because `danger: Danger` is only a compile-time constraint: a fragment authored
 * in loosely-typed JS, or a typo'd `"sr"`, would otherwise slip through and be
 * mis-projected as a mutation (everything != "SR" takes the `_plan` branch).
 */
export const DANGERS = ["SR", "M", "D", "PR"] as const;

/** Runtime closed-set guard for the danger class. */
export function isDanger(value: unknown): value is Danger {
  return typeof value === "string" && (DANGERS as readonly string[]).includes(value);
}

/** A mutating command is anything that is not a safe read. */
export function isMutating(danger: Danger): boolean {
  return danger !== "SR";
}

/** Destructive or prod-rebinding — the classes that require typed-confirm wiring. */
export function requiresTypedConfirm(danger: Danger): boolean {
  return danger === "D" || danger === "PR";
}

// --- scopes (N-011 §APX-C, RN-2) ---------------------------------------------
// Canonical form is bare `<family>:<verb>` (no `mgmt:` prefix), with the 3-verb
// ladder read < write < destroy (write-implies-read, destroy-implies-write). The
// string type is intentionally open (`${string}:...`) because the scope registry
// is additive; the CANONICAL family list lives in vocab.ts (SCOPE_FAMILIES) and
// the registry load-check rejects any scope whose family is not registered.
export type ScopeLevel = "read" | "write" | "destroy";
export type Scope = `${string}:${ScopeLevel}`;

// --- interactive prompts (deliverable 2, deliverable 6) ----------------------
/**
 * A prompt the CLI may ask interactively. Every prompt MUST carry a
 * `flagEquivalent` so the exact same input is reachable non-interactively (the
 * scriptable / CI path) — the registry-invariant test fails a prompt without one.
 */
export interface PromptSpec {
  /** Input key this prompt fills — must match a key in the command's `args`. */
  name: string;
  /** Human prompt text shown in interactive mode. */
  message: string;
  /** The flag that supplies the same value non-interactively. Required. */
  flagEquivalent: `--${string}`;
  /** Hide typed input (secrets / tokens). */
  secret?: boolean;
}

// --- typed-confirm (deliverable 6; N-011 §APX-A `dconf` gating) ---------------
/**
 * Typed-confirm wiring. Every D / PR command MUST declare one — the operator has
 * to type a literal challenge (the target's name) before a destroy or a
 * prod-rebind proceeds. The presence of this field IS the "confirm required"
 * signal the invariant test checks; the server independently re-verifies the
 * `confirm` value (PL-13), so this is defence-in-depth, not the only gate.
 */
export interface TypedConfirm {
  /** What the operator must type verbatim to proceed. */
  challenge: "resource-name" | "project-name" | "confirm-string" | "token-name" | "key-id";
  /** Also require a `--reason` (kill-switch-engage style, N-011 A506 note ⁷). */
  requireReason?: boolean;
}

// --- reserved (deliverable 2 `reserved?: BuildFlag`; N-011 RN-5 / §APX-C.4) ---
/**
 * Marks a registered-but-not-yet-available command. Reserved commands stay in the
 * registry (so the catalog and drift-lock see them) but generators EXCLUDE them
 * from default `--help` and MCP `tools/list` (RN-5). The build flag names the
 * ticket that unblocks the surface — exactly like a `NOT_YET_EMITTED` error code.
 */
export interface BuildFlag {
  /** The ticket whose landing un-reserves this command (e.g. "T-AB", "OD-R"). */
  ticket: string;
  /** Why it is reserved. */
  reason: string;
}

// --- reserved-route wire metadata (T-210 / L2-CLI-21 §E) ---------------------
/**
 * A gating class on the wire (N-011 §APX-A `gating` column). The kill-switch is
 * gated per-branch, so a route may carry a discriminated `{engage,disengage}` pair.
 */
export type WireGating = "free" | "direct" | "plan_required" | "direct_confirm";
export type WireGatingValue =
  | WireGating
  | { readonly engage: WireGating; readonly disengage: WireGating };

/**
 * The danger a reserved route declares on the wire — preserved VERBATIM from the
 * byte-pinned contract: a single class, the compound `"PR+D"` (admin.account.update),
 * or the kill-switch discriminated `{engage,disengage}` pair. The CLI shell projects
 * this down to a single `CommandSpec.danger` via `projectWireDanger` (reserved/wire-danger),
 * but the reference RENDERS this exact value, never the projection (§E).
 */
export type WireDanger =
  | Danger
  | "PR+D"
  | { readonly engage: Danger; readonly disengage: Danger };

/**
 * The EXACT contract tuple a reserved CONTRACT-route command mirrors. Hand-authored
 * on the spec and locked three-ways to `management/v1.1.0` by the reservation
 * drift-test. The three no-contract reserved commands carry NO `reservedRoute` — they
 * must never masquerade as a ratified wire op (§E.5).
 */
export interface ReservedRoute {
  readonly operationId: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  /** Literal contract scope — e.g. `"knowledge:read"` or `"none (superadmin)"`. */
  readonly scope: string;
  readonly danger: WireDanger;
  readonly gating: WireGatingValue;
  readonly paginated: boolean;
}

/**
 * Where a reserved argument comes from (§G F-r3-4 — no overclaim). `provisional-cli`
 * args are EXCLUDED from tuple-fidelity claims and reconcile to the contract before
 * any enable release (D3 §6.G). Never call a provisional flag "contract-authorized".
 */
export type ArgProvenance =
  | "contract-path-param"
  | "shared-validator"
  | "migration-invariant"
  | "provisional-cli";

// --- context + client seam (settled design; typed fully in T-211) ------------
/**
 * The response DTO the typed client resolves for a management operation (T-211 / A17). Keyed
 * by operation_id through the generated `Operations` map; an operation whose response is not
 * yet modelled as a `$def` in management/v1.1.0 resolves to `unknown` — so this narrowing is
 * strictly back-compatible with the pre-T-211 `Promise<unknown>` seam.
 */
export type OperationResponse<K extends keyof Operations> = Operations[K]["response"];

/**
 * Low-level authenticated request to a management operation. T-211 tightens the RESPONSE to the
 * generated per-operation DTO (A17) while keeping `params` deliberately loose (the command's zod
 * `args` are the validation authority; typing `params` to the request DTO would break the
 * zod-output call sites). `operationId` is constrained to a real management operation_id so an
 * unknown op is a COMPILE error. Kept as a forward-declared interface so NO server code
 * (`@agentkit-cloud/management-core`) — and no fs-reading contract loader — is pulled into the
 * CLI bundle.
 */
export interface ManagementClient {
  request<K extends keyof Operations>(op: RequestSpec<K>): Promise<OperationResponse<K>>;
  /**
   * T-222 step 10b: the RAW wire door (`agkit api <method> <path>`). An escape hatch with NO
   * operation_id that rides the EXACT same credential / guard / refresh / classification / version-fence
   * / redaction pipeline as `request` (never a duplicate), confined by `validateRawPath` to the
   * management namespace outside the OAuth subtree. OPTIONAL so plain test mocks + the pre-10b seam
   * stay valid; the production client (wire-client.ts) always provides it.
   */
  raw?(spec: RawRequestSpec): Promise<RawResult>;
}

/** A raw-door request: a concrete method + an absolute path (validated by `validateRawPath`), an
 *  optional pre-serialized JSON body, and the same per-request custody budget a typed request carries. */
export interface RawRequestSpec {
  readonly method: "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Absolute path (may include a `?query`); confined to `/v1/management` outside the OAuth subtree. */
  readonly path: string;
  /** Pre-serialized JSON request body (bounded by MAX_REQUEST_BYTES), or null/absent for a bodiless verb. */
  readonly bodyBytes?: string | null;
  /**
   * T-222 step 10c: the `--field k=v` query entries (query-ONLY, never a body merge). Each is validated
   * against the raw-query allowlist's closed non-secret validators and deduplicated against the path's
   * inline `?query` (D3). Empty/absent for a call with no `--field`.
   */
  readonly queryFields?: readonly string[];
  readonly budget?: RequestSpec["budget"];
}

/** A raw-door result: the transport status, the parsed JSON body (null for a non-JSON/204 body), and
 *  the verbatim body text (present ONLY for a tolerated non-JSON 2xx, else null). */
export interface RawResult {
  readonly status: number | null;
  readonly body: unknown | null;
  readonly bodyText: string | null;
}

export interface RequestSpec<K extends keyof Operations = keyof Operations> {
  /** N-011 §APX-A operation_id, e.g. "project.list". Must be a real management operation_id. */
  operationId: K;
  /** Path / query / body params — already validated by the command's `args`. */
  params?: Record<string, unknown>;
  /**
   * Optimistic-concurrency preconditions for THIS request (T-211 / A21 / finding 17). Per-request,
   * NOT a client-wide setting — a single client instance issues both unconditioned and conditioned
   * operations, so the precondition must ride on the individual spec. Honored only on the route
   * whose `concurrency` column expects it (prepareRequest rejects a mismatch — §B-9 honor-or-reject).
   */
  preconditions?: { readonly ifMatch?: string; readonly ifNoneMatch?: string };
  /**
   * Per-request idempotency policy (T-212 F-A / A-1). `ignoreClientOverride` makes the client
   * IGNORE the client-wide `--idempotency-key` override for THIS request and auto-generate a
   * fresh UUIDv4 instead — for the ceremony's INTERNAL writes (plan.discard now; the plan.apply
   * leg in S6/S7), where reusing the user's key would deterministically 422
   * (`idempotency_key_conflict`: the key is unique per principal). Additive, per-request —
   * mirrors the `preconditions` pattern; every normal request still honors the override.
   */
  idempotency?: { readonly ignoreClientOverride: true };
  /**
   * Per-request refresh suppression (T-212 S8 / A-9). `false` makes a 401 `refresh_auth`
   * disposition TERMINAL for THIS request — the refresh executor is never invoked, so a
   * zero-mutation instrument (the status pending-plans probe) can never consume a
   * refresh-token rotation. Absent/true keeps the normal single-refresh path. Additive,
   * per-request — mirrors the `preconditions`/`idempotency` pattern.
   */
  refresh?: boolean;
  /**
   * Per-request response-metadata capture (T-213 S12 / PL-13). When `true`, the resolved value
   * is augmented with a `meta.etag` carrying the response's `ETag` header (undefined when the
   * server sent none — never a crash). The token-revoke ceremony's `prepare` reads it to supply
   * the `If-Match` for the follow-up revoke (optimistic concurrency). Additive, per-request —
   * mirrors the `preconditions`/`idempotency`/`refresh` pattern; the transport already reads
   * response headers for the version fence, so this only surfaces one more of them.
   */
  captureMeta?: true;
  /**
   * Per-request custody budget (T-222 S3). Best-effort probes (`agkit version`, `selftest`)
   * bound their OWN wait: `timeoutMs` rides to the transport's per-call watchdog and
   * `retries` overrides the client-wide retry budget for THIS request only (0 = exactly one
   * send). Absent ⇒ the default custody (30 s watchdog × 1+DEFAULT_RETRIES) is unchanged.
   * Additive, per-request — mirrors the `preconditions`/`idempotency`/`refresh`/`captureMeta`
   * pattern.
   */
  budget?: { readonly timeoutMs?: number; readonly retries?: number };
  /**
   * Per-request version-fence mode (T-222 6a / C2). Overrides the client-wide fence mode for
   * THIS request only: `"throw"` makes a major skew on this response terminal (preempts the
   * resend by throwing `version_skew`), `"report"` records the verdict without throwing. The
   * `selftest` client is built REPORT-mode (its `discovery.get` MEASURES skew), but its
   * authenticated/mutating checks ride `fence:"throw"` so a skew appearing only at one of those
   * later responses (rotation / mixed-version LB) throws BEFORE the write is accepted, and its
   * best-effort reconcile rides `fence:"report"` so cleanup still attempts. Absent ⇒ the
   * client-wide mode. Additive, per-request — mirrors `budget`/`refresh`/`idempotency`.
   */
  fence?: "report" | "throw";
}

/** The `meta.etag` shape attached to a `captureMeta` response (T-213 S12). Read via `readCapturedEtag`. */
export interface CapturedResponseMeta {
  readonly meta?: { readonly etag?: string };
}

/**
 * Read the `ETag` a `captureMeta:true` request attached to its resolved value (T-213 S12). Returns
 * `undefined` when the request did not capture meta OR the server sent no ETag — never throws.
 */
export function readCapturedEtag(response: unknown): string | undefined {
  if (response !== null && typeof response === "object") {
    // `meta` may be absent, null (`null !== undefined` — the null must be excluded before any
    // property access), or a non-object; only an object with a non-empty string `etag` yields one.
    const meta = (response as CapturedResponseMeta).meta;
    if (meta !== null && typeof meta === "object" && typeof meta.etag === "string" && meta.etag.length > 0) {
      return meta.etag;
    }
  }
  return undefined;
}

// --- mutation ceremony seam (T-212, canonical L2-CLI-08) ----------------------
// Every mutating remote command declares HOW it executes its write. The dispatch hook
// (build-cli `runSpec`) owns ALL ceremony I/O (plan.create/plan.get, redacted render,
// prompts, halts — it has ShellDeps); the handler stays a pure `ctx.client` call that
// reads the resolved `ctx.ceremony` pass. This seam is CONSUMED by T-213/T-214 — its
// contract is pinned here so those tickets build against it.

/** Which write path a mutation uses. */
export type MutationKind = "plan" | "apply" | "direct_confirm" | "direct";

/**
 * A plan-first mutation (project create/archive, issuer create — retrofitted in S7). The
 * dispatch hook builds a `plan.create` request from `changes(...)`, then renders / prompts /
 * applies per the SERVER plan's danger. Change builders are PURE; `path` is a CONCRETE route
 * path with ids substituted (S7 reuses the typed client's route renderer, A-16).
 *
 * T-217 (R-D): the return widens to `PlanChange[] | Promise<PlanChange[]>` — additive; the ONE
 * call site awaits (`core/plan/ceremony.ts` runPlan). This lets `provider-key rotate`'s builder
 * await the echo-off secret prompt BEFORE `plan.create` (no network write precedes secret
 * resolution). Existing sync builders are unaffected (`await` of a plain array is the array).
 */
export interface PlanMutation {
  readonly kind: "plan";
  changes(input: unknown, ctx: Ctx): PlanChange[] | Promise<PlanChange[]>;
}

/** The `plan apply` binding: fetch the plan by `input.id` (plan.get) instead of creating one. */
export interface ApplyMutation {
  readonly kind: "apply";
}

/**
 * What `DirectConfirmMutation.prepare` resolves — invoked exactly ONCE before any render or
 * prompt (RC-8). `preview` is the redacted human diff-equivalent (no server diff exists for a
 * direct_confirm route). `expectedConfirm` is the fetched confirm value WHEN KNOWN — its
 * presence enables the local pre-send mismatch check (RC-2); absent ⇒ forward verbatim and let
 * the server teach (422 confirm_required). `ifMatch` is the current ETag for If-Match (PL-13),
 * read from the in-body `etag` of that same pre-fetch read (RC-3, no header-capture client edit).
 */
export interface DirectConfirmPrepared {
  readonly preview: { readonly title: string; readonly lines: readonly string[] };
  readonly expectedConfirm?: string;
  readonly ifMatch?: string;
  /**
   * The prepared canonical IDENTITY of the reviewed target (T-213 S12 review — TOCTOU close). A
   * direct_confirm `prepare` that resolves an id-or-prefix (token revoke) resolves it ONCE, previews
   * THAT row, and captures ITS ETag; the ceremony carries this opaque bag onto the pass so the
   * handler acts on the EXACT reviewed resource instead of re-resolving (which could bind a
   * different row if the live listing changed between prepare and handler). Opaque by design — each
   * consumer defines + reads its own keys (token revoke: `{ id }`).
   */
  readonly target?: Record<string, unknown>;
}

/**
 * A direct_confirm mutation (T-213 token revoke = confirm token NAME, T-214 attested-key revoke
 * = confirm keyId — no CHANGE_TABLE keys exist for these, so they are NOT plannable: the wire's
 * deliberate emergency door). NO shipped T-212 command is direct_confirm; the seam ships
 * fixture-tested, consumer-less.
 */
export interface DirectConfirmMutation {
  readonly kind: "direct_confirm";
  prepare(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared>;
}

/**
 * An M-class DIRECT mutation (T-215 Seam-1, canonical L2-CLI-10 — `billing checkout`/`billing
 * portal`). The wire's non-plannable, no-typed-challenge money-path door: it runs EXACTLY the M
 * decision cell (y/N when interactive; `--yes` fuse; non-TTY halt) with no plan and no typed
 * confirm. The registry pins `kind:"direct"` ⇒ danger M ∧ execution remote ∧ NO `confirm` (a
 * typed-confirm op may never ride the no-challenge door). Distinct from `direct_confirm` (the
 * D/PR emergency door, which DOES carry a typed challenge). T-218's `agent sync` (PR/direct — the
 * single allow-listed exception) and T-220's `identity revalidate` will reuse/extend this seam;
 * widening the registry restriction beyond M is their explicitly-gated change, not pre-enabled here.
 */
export interface DirectMutation {
  readonly kind: "direct";
  /**
   * PURE static preview (R-C/R-E): derived ONLY from the parsed input — no wire call, no
   * `prepare`, no post-confirm lookup — shown before the M y/N / `--yes` decision. Rendered
   * through the ceremony's redact + displaySafe chokepoint (a secret-shaped or control-char
   * line masks/escapes, never renders live).
   */
  readonly preview: (input: unknown) => { title: string; lines: readonly string[] };
}

export type MutationBinding = PlanMutation | ApplyMutation | DirectConfirmMutation | DirectMutation;

/**
 * Recovery provenance carried on an apply-mode ceremony pass (A-15) so the WireProblemError
 * catch site picks the EXACT re-plan hint for a plan_stale / plan_expired / plan_already_applied:
 * `fused` supplies the current invocation's argv (re-plan = re-run it, encoded via the one tested
 * argv→shell encoder with confirm values as placeholders, RC-12); `standalone` supplies the plan
 * id (re-plan = a generic teachable + `plan show <id>`).
 */
export type CeremonyRecovery =
  | { readonly source: "fused"; readonly replanArgv: readonly string[] }
  | { readonly source: "standalone"; readonly planId: string };

/**
 * The ceremony outcome the dispatch hook hands the handler on `ctx.ceremony`. A plan-kind spec
 * shares ONE handler (`planMutationHandler`, S6): it runs `plan.apply` (`mode:"apply"`) or
 * returns the plan (`mode:"plan_only"`). A direct_confirm handler (T-213/T-214) forwards
 * `confirm` / `ifMatch` to its own route.
 */
export type CeremonyPass =
  | {
      readonly kind: "plan";
      readonly mode: "apply";
      readonly plan: ManagementPlan;
      readonly confirm?: string;
      readonly recovery: CeremonyRecovery;
    }
  | { readonly kind: "plan"; readonly mode: "plan_only"; readonly plan: ManagementPlan }
  | {
      readonly kind: "direct";
      readonly confirm: string;
      readonly ifMatch?: string;
      /** The prepared canonical target identity (T-213 S12 review — TOCTOU close); see
       * `DirectConfirmPrepared.target`. Threaded verbatim from prepare so the handler acts on
       * EXACTLY the reviewed resource, never a re-resolve. */
      readonly target?: Record<string, unknown>;
    }
  /**
   * The M-direct proceed pass (T-215 Seam-1). Carries NO confirm / ifMatch / target — an M-class
   * `direct` ceremony has no typed challenge and no plan, so an approved decision is a bare
   * "proceed" signal the handler reads before its single write. (The pass-kind literal `"direct"`
   * is already taken by the direct_confirm pass above; `"proceed"` avoids the collision.)
   */
  | { readonly kind: "proceed" };

/**
 * Handler context. Minimal and forward-compatible: T-211 (typed client) extends
 * it further. T-205 added `output` — the resolved output configuration (format
 * mode, projection, compact, color, verbose, the injectable TTY seam, and the
 * shown-once allowlist signal) that the serializer chokepoint reads. T-206 added
 * `credential` — the credential the shell resolved for THIS command (source enum +
 * token + insecure flag). It is `NO_CREDENTIAL` for a local command (e.g.
 * `version`) that consumes none — those NEVER trigger keychain access. Handlers
 * stay PURE: they READ `credential` (never resolve it — that I/O is the shell's)
 * and never touch `process`; only the shell + the chokepoint format and write.
 */
export interface Ctx {
  readonly client: ManagementClient;
  readonly output: OutputConfig;
  readonly credential: ResolvedCredential;
  /**
   * The effective project (F0) — the FULL precedence-resolved value TOGETHER WITH its
   * source (`--project` flag > `AGKIT_PROJECT` env > repo `.agentkit/project.json` >
   * profile default > builtin `null`), resolved ONCE per invocation from the SAME
   * `resolveContext` snapshot the guard + effective-profile chain read (never a re-implemented
   * chain). It is `NO_PROJECT` (builtin `null`) in the base context and while a local command
   * (version/reference) runs — the shell overwrites it with the resolved value for a remote
   * command, EXACTLY as it overwrites `credential` (NO_CREDENTIAL → resolved). A handler that
   * needs an id calls `requireProject(ctx)` (throws the teachable usage_error when null).
   */
  readonly project: Resolved<string | null>;
  /**
   * The validated global client-behavior flags (T-211): `--retries` budget +
   * `--idempotency-key` override, parsed once from raw argv. Present on every Ctx;
   * the typed client reads them when it is wired into the shell (step 7). A malformed
   * value is rejected as `usage_error` (exit 2) at parse time, before any Ctx exists.
   */
  readonly clientFlags?: ClientFlags;
  /**
   * The shell-provided runtime seam (T-208): env, home/cwd, the keychain port, the
   * interactive-TTY signal, a stderr sink, and the resolved `--profile`/`--project`
   * flags. It is OPTIONAL because most commands never need it — the shell injects it
   * ONLY for the commands that read/write local config + keychain + context (`config`,
   * `profile`, `status`). Pure handlers still never touch `process`: they operate over
   * THIS injected seam, exactly as T-206's handlers read the injected `credential`.
   */
  readonly runtime?: CliRuntime;
  /**
   * The auth-command I/O seam (T-213) — the credential WRITE/DELETE + API-URL guard +
   * OAuth-boundary network I/O the `login`/`logout` handlers consume. OPTIONAL because only those
   * two commands need it; the shell injects it for them (build-cli `commandNeedsAuth`). Pure
   * handlers read this seam, never `process` — exactly as they read the injected `credential`.
   */
  readonly auth?: AuthCommandSeam;
  /**
   * The service-plane I/O seam (T-222, S5). The shell injects it ONLY for the service nouns
   * (`commandNeedsService` — `selftest` now; `upgrade`/`dashboard`/`api` as their steps land).
   * A pure handler reads it via `requireService(ctx)`, never touching `process`/`node:fs` —
   * exactly as it reads the injected `runtime`/`auth`.
   */
  readonly service?: ServiceCommandSeam;
  /**
   * The mutation-ceremony outcome (T-212). The dispatch hook resolves this BETWEEN the
   * capability gate and the handler for a spec that declares `mutation`; it is absent for
   * reads, local commands, and the ceremony-exempt `plan discard`. The handler READS it
   * (never performs ceremony I/O itself — that is the shell's, exactly like `credential`).
   */
  readonly ceremony?: CeremonyPass;
  /**
   * T-212 S8 (PL-15 straddle): the shell's replay cell. The wire client records each
   * classified response's `Idempotency-Replayed: true` fact here (LAST write wins, so the
   * cell reflects the invocation's FINAL response); the dispatcher surfaces `meta.replayed:
   * true` on the success envelope when that final response was a stored idempotent replay —
   * an honest "the server did not re-execute this" signal at exit 0.
   */
  readonly replay?: { current: boolean };
}

/**
 * The local-config/context runtime a `config`/`profile`/`status` handler needs
 * (T-208). Every field is an injected seam so the handlers are deterministically
 * testable (mirror the T-206 dependency-injection style). `flags` carries the global
 * `--profile`/`--project` overrides the precedence resolver reads.
 */
export interface CliRuntime extends RuntimeIoSeams {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly cwd: string;
  readonly keyring: KeyringPort;
  /** Interactive terminal (stdin TTY) — gates prompts and the update-notice mirror. */
  readonly isTTY: boolean;
  /** Best-effort stderr sink (diagnostics / update-notice mirror). MUST NOT throw. */
  readonly stderr: (message: string) => void;
  /** The global context selectors from `--profile` / `--project`. */
  readonly flags: { readonly profile?: string; readonly project?: string };
  // The OPTIONAL prompt + fs seams (`promptSecret` / `promptLine` / `confirm` / `readTextFile` /
  // `writeTextFile` / `listDir`) are inherited from `RuntimeIoSeams` — see ./runtime-io.
  /**
   * T-222 (step 5): the running Node.js version (production: `process.version`), consumed
   * by the `version`/`selftest` diagnostics. OPTIONAL so hand-built test runtimes and
   * older seams stay valid — consumers render `null` when absent, never crash.
   */
  readonly nodeVersion?: string;
}

/**
 * Narrow `ctx.runtime` to a present value, or throw a clear internal error. In
 * production the shell ALWAYS injects it for the commands that declare they need it
 * (build-cli `commandNeedsRuntime`), so this only trips a programming error (a
 * handler wired without the seam) — never a user-facing path.
 */
export function requireRuntime(ctx: Ctx): CliRuntime {
  if (!ctx.runtime) {
    throw new Error("agkit: internal — this command requires the runtime seam but it was not injected");
  }
  return ctx.runtime;
}

// T-221: the runtime's OPTIONAL prompt/fs seams + their narrower live in ./runtime-io (the same
// max-lines extraction as ./command-seams below). Re-exported so consumers keep importing ./types.
export type { RuntimeIoSeams };
// T-224: the symlink-FOLLOWING quartet `setup` consumes rides the same module + narrower posture.
export type { FollowSeams } from "./runtime-io";
export { requireWriteTextFile, requireFollowSeams } from "./runtime-io";

// The auth/service command I/O seams live in ./command-seams (extracted to keep this file under the
// packages/cli max-lines cap). Re-exported here so every consumer keeps importing from ./types; the
// interfaces used by `Ctx` below (`AuthCommandSeam`/`ServiceCommandSeam`) are imported at the top.
export type { AuthCommandSeam, ServiceCommandSeam };
export type { ApprovedApiContext, ProfileClearResult, SkillInstallFacts } from "./command-seams";
export { requireAuth, requireService, requireSkillInstallFacts } from "./command-seams";
// T-227 S5b: the MCP-surface override shapes (see ./mcp-surface for the whole rationale).
export type { McpSurface, McpSecretIntake } from "./mcp-surface";

/**
 * The base project context before the shell resolves one — builtin `null`, the exact value
 * `resolveContext` returns when NO source supplies a project. The sibling of `NO_CREDENTIAL`:
 * the shell overwrites it with the precedence-resolved value for a remote command; a local
 * command keeps it and never reads it.
 */
export const NO_PROJECT: Resolved<string | null> = { value: null, source: "builtin" };

/**
 * Narrow `ctx.project` to a concrete project id, or throw the teachable CLI-local
 * `usage_error` (exit 2 — the EXISTING code, no new one minted). Empty/whitespace values are
 * ALREADY dropped by the resolver's `present()` guard (they never land as a value), so this
 * only tests for `null`. The detail + hint TEACH all four sources so the operator can supply
 * one non-interactively (the scriptable path).
 */
export function requireProject(ctx: Ctx): string {
  const project = ctx.project.value;
  if (project === null) {
    throw new CliLocalError("usage_error", {
      detail:
        "no project selected — set one with the --project flag, the AGKIT_PROJECT env var, a repo .agentkit/project.json, or a profile default",
      hint: "agkit <command> --project <id>",
      extra: {
        project_sources: ["--project <id>", "AGKIT_PROJECT", ".agentkit/project.json (repo)", "profile default"],
      },
    });
  }
  return project;
}

// --- result (settled design — serializer-agnostic) ---------------------------
/**
 * What every handler returns. The serialized wire envelope `{ ok, data, meta }`
 * is T-205's serializer's job — this stays serializer-agnostic (just the payload
 * plus optional warnings/meta). Keeping handlers pure over this type is the whole
 * reason ONE registry can drive both the yargs shell and the MCP shell (A1).
 */
export interface CommandResult<T = unknown> {
  data: T;
  warnings?: string[];
  meta?: Record<string, unknown>;
  /**
   * T-222 S4: the diagnostic verdict for a command whose DATA is a report (selftest).
   * The envelope stays a SUCCESS document — the process exit encodes the verdict
   * (serialize.ts: `verdictExit ?? (partial ? 3 : 0)`). Type-restricted to the closed
   * taxonomy's {RETRYABLE, TERMINAL} so no handler can mint an exit code. NEVER for
   * errors — throw instead; usage is locked to the selftest plane by
   * `verdict-exit-lock.test.ts`.
   */
  verdictExit?: typeof EXIT.RETRYABLE | typeof EXIT.TERMINAL;
}

/**
 * A command handler. PURE `(ctx, input) => Promise<CommandResult>` — deliberately
 * NO `process` side effects: no `process.exit`, no direct stdout/stderr writes.
 * The shell (yargs) or the MCP server owns I/O; the handler only computes. This
 * property is what lets the identical registry back both surfaces (A1, T-204 §3).
 */
export type CommandHandler<I = unknown> = (ctx: Ctx, input: I) => Promise<CommandResult>;

// --- the CommandSpec itself --------------------------------------------------
export interface CommandSpec<I = unknown> {
  /** Resource noun, e.g. "project", "issuer". Lower-kebab. */
  noun: string;
  /**
   * Verb from the CLOSED vocabulary (vocab.ts VERB_VOCABULARY). Typed as `string`
   * on purpose: the closed set is enforced at registry-LOAD (a `toggle` verb
   * throws), which is the single source of truth and is what the negative-fixture
   * test exercises — see registry.ts / deliverable 5.
   */
  verb: string;
  /** Alternative invocation names, surfaced in `--help` (deliverable 5). VERB-position aliases
   * (e.g. `project ls` for `project list`) — distinct from `nounAliases`. */
  aliases?: string[];
  /**
   * T-216 (S1): NOUN-position aliases — a second shell token that names this command's NOUN
   * (e.g. `pk` for `publishable-key`, so `agkit pk revoke <id>` ≡ `agkit publishable-key revoke
   * <id>`). Registry-declared per the deliverable; EVERY spec of a noun must declare the IDENTICAL
   * set (a load-check enforces this + kebab-form + collision-freedom against ALL top-level shell
   * tokens). The alias is a build-cli group registration and an alias-aware `extractPositional`
   * head — help + reference render it, but the MCP/dedup/drift surfaces see only the PRIMARY noun
   * (one registry citizen per command). Built generically so a future noun adds an alias by
   * declaration only.
   */
  nounAliases?: readonly string[];
  /** One-line description for help + catalog. */
  summary: string;
  /** zod schema for this command's input. The validation authority. */
  args: ZodType<I>;
  /** Scopes this command requires (N-011 §APX-C). Empty for local commands. */
  scopes: Scope[];
  /** Danger class (drives confirm/plan gating + MCP hints). */
  danger: Danger;
  /** `$id` of the output schema (deliverable 2 + FORBIDDEN: no missing `$id`). */
  outputSchemaId: string;
  /** At least one example; each MUST parse against `args` (invariant test). */
  examples: string[];
  /** Pure handler (no process side effects). */
  handler: CommandHandler<I>;
  /**
   * Bare-command opt-in (T-213 decision (k) / RC round-1 §2). A `bare: true` command surfaces as
   * `agkit <noun>` (like `whoami`/`version`) even though its verb is NOT a read verb — for the
   * non-resource lifecycle commands `login` (`login/create`) and `logout` (`logout/clear`). The
   * registry load-check requires a `bare` command to be the ONLY visible command for its noun
   * (a bare surface can carry no sibling subcommands). Distinct from T-212's verb-alias mechanism.
   */
  bare?: boolean;
  /** Interactive prompts, each with a `flagEquivalent`. */
  prompts?: PromptSpec[];
  /**
   * T-217 (RR-5d / RA-1): input keys whose VALUES must NEVER reproduce in a reconstructed
   * invocation (the plan.create note, replan/halt/decline hints — every argv→shell sink).
   * This is a CUSTODY-ELISION property INDEPENDENT of the secret-NAME pattern (`isSecretFieldName`)
   * and of `prompts:[{secret:true}]`: the `--extra-header` / `--endpoint-url` values are not
   * secret-NAMED and are non-secret BY POLICY, but a mistaken paste could still put a secret in
   * one — and they must never echo in a reconstruction regardless. The ONE chokepoint
   * (`core/plan/invocation.ts` `toInvocationTokens`) collapses each listed key to a single
   * `--<flag> <<flag>>` placeholder. Never a redaction property (reads still echo the values).
   */
  elideFlags?: readonly string[];
  /** Typed-confirm wiring — required for every D / PR command. */
  confirm?: TypedConfirm;
  /**
   * T-212: how this mutating remote command executes its write. Registry load-check: a
   * NON-reserved remote spec with danger ∈ {M,D,PR} MUST declare `mutation` unless its
   * commandKey is in CEREMONY_EXEMPT; a `kind:"direct_confirm"` binding ⇒ danger D/PR.
   */
  mutation?: MutationBinding;
  /**
   * T-212: the single positional surface, e.g. `agkit apply <plan-id>` / `agkit plan show
   * <plan-id>`. `key` MUST be a key in `args`; the dispatcher maps the leftover non-flag
   * token onto `input[key]` before the zod parse (S3). The registry load-check enforces
   * `key ∈ args shape`.
   */
  positional?: {
    readonly key: string;
    readonly name: string;
    /**
     * T-216 (S3): OPTIONAL-mode positional — the token may be omitted (`agkit project get` with no
     * id). When set, `key` must be a PLAIN optional string in `args` (the registry probe rejects a
     * `.default()`/`.transform()`/required key): a missing token parses to an ABSENT key so the
     * handler runs its fallback (e.g. `requireProject`); a present token is mapped as usual. Absent
     * ⇒ required mode (exactly-one token; a missing token is the zod required-key error).
     */
    readonly optional?: true;
  };
  /** Registered-reserved marker; excludes the command from help + MCP. */
  reserved?: BuildFlag;
  /**
   * Where this command executes (T-210 §D). `"local"` = no server call
   * (version/whoami/status/config/profile); `"remote"` = a management call
   * (project/issuer + every reserved command). Explicit metadata — NEVER inferred
   * from scopes. The `version_skew` capability gate (core/capability/gate) reads it:
   * a local command is always ok. The registry load-check requires every RESERVED
   * command to be `"remote"`.
   */
  execution?: "local" | "remote";
  /**
   * CLI-internal capability placeholders this command needs the server to advertise
   * (T-210 §D, PLURAL — the platform embedding-route needs BOTH `admin` + `knowledge`).
   * These are NOT v1.1.0 wire strings: the contract has no capability field; the wire
   * mapping is ratified in T-211 (this is the injected seam). The registry load-check
   * requires every RESERVED command's capabilities to be a NON-EMPTY subset of the
   * closed `RESERVED_CAPABILITIES` vocab (reserved-capabilities.ts).
   */
  requiredCapabilities?: readonly string[];
  /**
   * For a RESERVED command that mirrors a byte-pinned management route: the EXACT
   * contract tuple, preserved verbatim (incl. the compound `"PR+D"` and the kill-switch
   * discriminated pair). The three-way drift-test locks it to `management/v1.1.0`.
   * A load-check enforces `reservedRoute ⇒ reserved` (a route-mirroring spec that lost
   * its `reserved` flag would LEAK into the default build — the negative-control guard).
   */
  reservedRoute?: ReservedRoute;
  /**
   * Provenance of each non-path reserved argument (§G F-r3-4). Documentary metadata:
   * `contract-path-param` / `shared-validator` / `migration-invariant` are grounded;
   * `provisional-cli` args are CLI-only filter sketches that reconcile to the contract
   * before any enable release.
   */
  reservedArgProvenance?: Readonly<Record<string, ArgProvenance>>;
  /**
   * MCP exclusion reason (N-011 §APX-D `EXCL:<reason>` column). Cross-cutting
   * local commands (e.g. `version`) and human-ceremony / secret-bearing commands
   * (`billing checkout`, `token create`) are reachable via the CLI but are NOT
   * projected as MCP tools. Set this to keep them out of the MCP surface while
   * still appearing in the CLI catalog.
   */
  mcpExclude?: string;
  /**
   * T-227 S5b: this command's MCP INPUT GRAMMAR, when it differs from the CLI's (see
   * ./mcp-surface). Declared only by the commands whose secret arrives through an operator
   * CHANNEL on the CLI and as a `SecretRef` object over MCP. Mutually exclusive with
   * `mcpExclude`, and never read by the CLI shell.
   */
  mcpSurface?: McpSurface;
  /**
   * T-222 S1: the stdout-takeover dispatch class (`mcp serve`). REQUIRED REASON STRING
   * when set (the mcpExclude precedent): the handler owns stdout end-to-end (protocol
   * frames only) — the shell writes NOTHING to stdout for this command. Success emits
   * no envelope; every failure renders ONE error JSON document to STDERR. The registry
   * load-check locks the class to local ∧ SR ∧ zero scopes ∧ no mutation ∧ non-empty
   * mcpExclude.
   */
  stdoutTakeover?: string;
}

/** A CommandSpec with its input type erased — the shape the registry stores. */
export type AnyCommandSpec = CommandSpec<unknown>;

/**
 * Author a command with full type inference, then erase its input type for
 * storage. `I` unifies across `args` (a `ZodType<I>`) and `handler` (a
 * `CommandHandler<I>`), so a handler whose input does not match its arg schema is
 * a compile error HERE — while the registry can still hold a homogeneous
 * `AnyCommandSpec[]` (a generic `CommandSpec<I>` is not assignable to
 * `CommandSpec<unknown>` because the handler is contravariant in `I`).
 */
export function defineCommand<I>(spec: CommandSpec<I>): AnyCommandSpec {
  return spec as unknown as AnyCommandSpec;
}
