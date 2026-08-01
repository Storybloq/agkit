// T-221 — the `agkit init` handler. A thin shell over the engine: it resolves seams, runs the
// R64 re-run short-circuit, picks the frontend (pure-over-flags vs interactive), takes consent,
// and returns what the engine produced. Every decision of substance lives in the engine, the plan
// leg, the catalog selector, or the drift classifier — this file only sequences them.
//
// AUTH is a PREREQUISITE phase, not part of the orchestration: when the invocation has no
// credential and the terminal is interactive, init announces and runs the EXISTING `login create`
// flow in place, then drops the shell's per-invocation credential memo so the lazily-built wire
// client binds the credential that login just wrote (without the reset every onboarding call
// 401s — the memo still holds the pre-login "none"). This is the ONE documented exception to
// init's zero-mutation-before-consent guarantee: auth state changes, onboarding state does not,
// and the report says so. Under `--yes` there is no interactive channel, so a missing credential
// is a refusal (`not_logged_in`) and NO login is attempted.
import type { CommandHandler, CommandResult, Ctx, CliRuntime } from "../types";
import { requireAuth, requireRuntime } from "../types";
import { CliLocalError } from "../../core/errors";
// T-212 F-D1: every caller-controlled value (--key-name) that reaches an error detail or a prompt
// question renders through the terminal-safe encoder — the same rule the consent summary follows.
import { displaySafe } from "../../core/output/display";
import { discoverRepoProject } from "../../core/config/repo-project";
import { loginCreate } from "../login/create";
import { initRunArgs, toBool, type InitRunInput } from "./args";
import {
  consentSummary,
  executeInit,
  gatherFromFlags,
  gatherInteractive,
  type InitDeps,
  type InitIntent,
} from "./engine";
import { fetchRouteDefaults } from "../../core/catalog/route-defaults";
import { classifyDrift, readProjectState, type ProjectState } from "./drift";
import { journalPath, sdkConfigPath } from "./scaffold";

export { initRunArgs };
export type { InitRunInput };

/**
 * Every management operation_id `init` can send — the version-fence breadth test's COMPENSATING
 * TOOTH (the `SELFTEST_PROBE_OPS` precedent). An orchestrator's spec key (`init.run`) is not a wire
 * op, so the fence test exercises it on ONE representative (`plan.create`, the plan-first
 * convention). Without this list the rest could silently dangle onto contract rows that no longer
 * exist. The test asserts each member resolves via `routeFor`.
 *
 * T-226 D0-i: `model_route.defaults` is no longer init-only — the `route defaults` spec surfaces it
 * as a first-class read, and BOTH go through the ONE shared handler core
 * (`core/catalog/route-defaults.ts`). It therefore also rides the fence test's registry-derived
 * breadth set; it stays listed here because THIS list is the honest inventory of what init sends,
 * not a coverage patch for an otherwise-unreachable op.
 */
export const INIT_ORCHESTRATOR_OPS = [
  "project.list",
  "project.get",
  "publishable_key.list",
  "publishable_key.create",
  "credential.list",
  "model_route.list",
  "model_route.defaults",
  "plan.create",
  "plan.apply",
  "plan.discard",
] as const;

const NOT_LOGGED_IN_DETAIL =
  "no credential is available and --yes cannot run an interactive login";
const NON_INTERACTIVE_DETAIL =
  "this terminal is non-interactive: `agkit init` asks for the project, the key label and the provider before it writes anything";

/** Fail-closed prompt seams: a shell that wired none behaves exactly like a non-interactive one. */
function promptSeams(rt: CliRuntime): {
  promptLine: (q: string) => Promise<string | null>;
  confirm: (q: string) => Promise<boolean>;
} {
  return {
    promptLine: rt.promptLine ?? (async () => null),
    confirm: rt.confirm ?? (async () => false),
  };
}

/**
 * The AUTH phase. Returns true when the run may proceed. Zero ONBOARDING writes either way; an
 * inline login is an auth-state side effect, declared here and reported in the result.
 */
async function ensureCredential(ctx: Ctx, rt: CliRuntime, yes: boolean): Promise<boolean> {
  if (ctx.credential.source !== "none") return false;
  if (yes || !rt.isTTY) {
    throw new CliLocalError("not_logged_in", {
      detail: NOT_LOGGED_IN_DETAIL,
      hint: "agkit login   # then re-run: agkit init --yes …",
    });
  }
  rt.stderr("agkit: not signed in — running `agkit login` first (this is the only thing init changes before you consent).\n");
  await loginCreate(ctx, {});
  // The shell resolved (and memoized) the credential BEFORE dispatch; drop that memo so the wire
  // client binds the one login just stored.
  requireAuth(ctx).invalidateCredential();
  // Disclose the persistent side effect IMMEDIATELY (codex k05): any later phase may throw, and a
  // thrown error never carries the report — this line is the disclosure that survives every exit.
  rt.stderr("agkit: signed in — that credential is stored and remains stored regardless of what follows.\n");
  return true;
}

/** The R64 short-circuit. Returns a finished result when the repo is already initialized. */
async function reRunShortCircuit(
  deps: InitDeps,
  pinnedProjectId: string,
  pinnedProfile: string | null,
): Promise<{ done: CommandResult } | { resume: ProjectState }> {
  const state = await readProjectState(deps.ctx, pinnedProjectId);
  const catalog = state.projectPresent
    ? await fetchRouteDefaults(deps.ctx, pinnedProjectId)
    : { catalogVersion: "", rows: [] };
  const report = classifyDrift({
    state,
    catalog,
    journalProfile: pinnedProfile,
    effectiveProfile: deps.profile,
  });

  if (report.verdict === "incomplete") {
    if (!deps.yes && deps.rt.isTTY) return { resume: state };
    // Non-interactive: state the EXACT resume position and stop. Zero writes.
    return {
      done: {
        data: {
          project: { id: pinnedProjectId, created: false },
          profile: deps.profile,
          status: "incomplete",
          missing: {
            publishable_key: report.missingKey,
            provider_credentials: report.missingCredentials,
            model_route_tiers: report.creatableTiers,
            // Codex k12: unbound tiers whose provider lacks a credential — named HERE so the tier
            // does not vanish behind its provider (an operator adding the credential out-of-band
            // would otherwise believe the routes were done).
            blocked_model_route_tiers: report.blockedTiers,
          },
          notes: report.notes,
          resume_command: "agkit init --project " + pinnedProjectId,
        },
        meta: { partial: true },
        warnings: [
          "this repo is already bound to a project, but what `agkit init` creates is not all there — nothing was changed",
          ...report.notes,
        ],
      },
    };
  }

  const alreadyDetail =
    report.verdict === "complete"
      ? "already initialized — every resource `agkit init` creates is present; nothing was changed"
      : "already initialized — this project has drifted from what `agkit init` produces; nothing was changed";
  return {
    done: {
      data: {
        project: { id: pinnedProjectId, created: false },
        profile: deps.profile,
        status: report.verdict,
        files: { journal: journalPath(deps.rt.cwd), sdk_config: sdkConfigPath(deps.rt.cwd) },
        notes: report.notes,
      },
      warnings: [alreadyDetail, ...report.notes],
    },
  };
}

/**
 * A reuse must name EXACTLY ONE live key: zero matches would report a reuse that never happened,
 * and duplicate labels (legal — see the conflict prompt below) make "the" key ambiguous. Refused
 * PRE-CONSENT, so nothing has been written when this throws.
 */
function requireExactlyOneReusableKey(intent: InitIntent, state: ProjectState): void {
  const matches = state.keys.filter((k) => k.name === intent.keyName);
  if (matches.length === 1) return;
  if (matches.length === 0) {
    throw new CliLocalError("usage_error", {
      detail: `no live publishable key labelled "${displaySafe(intent.keyName)}" exists on this project — there is nothing to reuse`,
      hint: "agkit publishable-key list   # or drop --reuse-key to mint one",
    });
  }
  throw new CliLocalError("usage_error", {
    detail: `${matches.length} live publishable keys share the label "${displaySafe(intent.keyName)}" — reuse cannot decide which one it is reporting`,
    hint: "revoke the duplicates, or --key-name <other-label> to mint a distinctly-labelled key",
  });
}

/**
 * Resolve the publishable-key label decision on an EXISTING project. Two duties, both honor-or-
 * reject: a requested reuse must name exactly one live key (never report a reuse that did not
 * happen), and a mint whose label a live key ALREADY carries never silently mints a second one —
 * a duplicate label is how a key inventory becomes unauditable.
 */
async function resolveKeyConflict(deps: InitDeps, intent: InitIntent, state: ProjectState): Promise<InitIntent> {
  if (intent.keyAction === "reuse") {
    requireExactlyOneReusableKey(intent, state);
    return intent;
  }
  if (!state.keys.some((k) => k.name === intent.keyName)) return intent;
  if (deps.yes || !deps.rt.isTTY) {
    throw new CliLocalError("usage_error", {
      detail: `this project already has a live publishable key labelled "${displaySafe(intent.keyName)}", and --yes will not decide between reusing it and minting a second one`,
      hint: "pass --reuse-key to reuse it, or --key-name <other-label> to mint a distinctly-labelled key",
    });
  }
  const mintAnyway = await deps.confirm(
    `A publishable key labelled "${displaySafe(intent.keyName)}" already exists. Mint a SECOND key with the same label? [y/N] `,
  );
  if (mintAnyway) return { ...intent, keyAction: "mint" };
  const reuse: InitIntent = { ...intent, keyAction: "reuse" };
  requireExactlyOneReusableKey(reuse, state); // a declined mint over DUPLICATE labels is ambiguous too
  return reuse;
}

export const initRun: CommandHandler<InitRunInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const auth = requireAuth(ctx);
  const yes = ctx.clientFlags?.yes === true;
  const { promptLine, confirm } = promptSeams(rt);

  const loggedInDuringRun = await ensureCredential(ctx, rt, yes);
  if (!yes && !rt.isTTY) {
    throw new CliLocalError("usage_error", {
      detail: NON_INTERACTIVE_DETAIL,
      hint: "agkit init --yes --project-name <name> --key-name <label>",
    });
  }

  // The guard-approved API context — memoized, shared with the wire client, so this prompts
  // nothing extra. It supplies BOTH the effective profile and the SDK config's `apiUrl`.
  const approved = await auth.ensureApiUrl();
  const deps: InitDeps = {
    ctx,
    rt,
    warn: rt.stderr,
    confirm,
    promptLine,
    now: () => Date.now(),
    yes,
    profile: approved.profile,
    apiUrl: approved.apiUrl,
    ...(input["api-key-env"] !== undefined ? { apiKeyEnv: input["api-key-env"] } : {}),
  };

  // R64: a repo that ALREADY carries a binding is verified against ground truth before anything
  // else — a re-run must never blindly create a second project for the same checkout.
  const discovered = discoverRepoProject(rt.cwd);
  const pinned = discovered?.project.projectId;
  let resumeState: ProjectState | null = null;
  if (pinned !== undefined && input["project-name"] === undefined && rt.flags.project === undefined) {
    const outcome = await reRunShortCircuit(deps, pinned, discovered?.project.profile ?? null);
    if ("done" in outcome) return withAuthNote(outcome.done, loggedInDuringRun);
    resumeState = outcome.resume;
    rt.stderr(
      "agkit: this repo is already bound to a project, but part of what init creates is missing — only the missing pieces are offered below.\n",
    );
  }

  let intent = yes ? gatherFromFlags(deps, input) : await gatherInteractive(deps, input);

  // An EXISTING project's live state gates the key-label decision AND the absent-only route
  // filter. Read once, here, and hand the SAME snapshot to the engine.
  let state: ProjectState | null = resumeState;
  if (intent.mode === "existing" && intent.projectId !== null) {
    state ??= await readProjectState(deps.ctx, intent.projectId);
    if (!state.projectPresent) {
      throw new CliLocalError("usage_error", {
        detail: "the selected project does not resolve for this credential — nothing was changed",
        hint: "agkit project list",
      });
    }
    intent = await resolveKeyConflict(deps, intent, state);
  }

  // CONSENT — the whole orchestration, shown before its first write.
  rt.stderr(consentSummary(intent, rt.cwd));
  if (!yes && !(await confirm("Proceed? [y/N] "))) {
    return withAuthNote(
      {
        data: { status: "cancelled", project: null, files_written: [] },
        warnings: ["initialization was cancelled before any change — no project, no key, no files"],
      },
      loggedInDuringRun,
    );
  }

  const result = await executeInit(deps, intent, state);
  return withAuthNote({ data: result.data, meta: result.meta, warnings: result.warnings }, loggedInDuringRun);
};

/** Surface the AUTH-phase side effect honestly on EVERY outcome, including a cancellation. */
function withAuthNote(result: CommandResult, loggedIn: boolean): CommandResult {
  if (!loggedIn) return result;
  return {
    ...result,
    data: { ...(result.data as Record<string, unknown>), signed_in_during_init: true },
    warnings: [
      ...(result.warnings ?? []),
      "you were signed in as part of this run — that credential is stored and remains stored regardless of what followed",
    ],
  };
}

/** Re-exported for the spec's `toBool` parity check in tests. */
export { toBool };
