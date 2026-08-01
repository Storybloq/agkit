// T-221 — the `init` engine: what the operator INTENDS (gather), and what actually happens
// (execute). The handler shell (run.ts) only wires seams and returns what this produces.
//
// PHASE MODEL (the ordering is the safety property, not a style choice):
//
//   AUTH → GATHER → CONSENT → EXECUTE(legA, journal, legB, artifact, legC, legD) → REPORT
//
// GATHER makes ZERO onboarding writes. Everything the operator must decide is decided BEFORE the
// first write, and the CONSENT summary shows all of it at once — so "yes" is informed consent for
// the whole orchestration, not a blind first step.
//
// COMMITTED PARTIAL STATE (the review's central correction): each artifact is written the moment
// its inputs exist, NOT at the end. `.agentkit/project.json` lands right after the project id is
// known; `agentkit.config.json` lands right after the key is minted. A crash, a decline, or a
// failure at leg C/D therefore leaves a repo that POINTS AT the project that was really created
// and HOLDS the key that was really minted — the alternative (write everything at the end) loses
// a shown-once key to any later failure and orphans a project on every abort.
//
// The zero-mutation guarantee is scoped precisely: GATHER and every refusal path perform no
// ONBOARDING writes and create no scaffold files. AUTH is a documented EXCEPTION — an inline
// login writes a credential, which is a prerequisite side effect the operator explicitly
// triggered, and the report says so.
import type { Ctx, CliRuntime } from "../types";
import { requireRuntime } from "../types";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { SHOWN_ONCE_META_KEY } from "../../core/output/envelope";
import { DEFAULT_API_URL } from "../../core/config/dirs";
import type { PlanChange } from "../../core/plan/types";
import { preflightEnvSecret, resolveWireSecret, type WireSecretConfig } from "../provider-key/secret-env";
import { shapePublishableKeyMint } from "../publishable-key/create";
import type { InitRunInput } from "./args";
import { toBool } from "./args";
import { providersNeeded, selectRoutes, type Catalog, type CatalogRow } from "./defaults";
import { fetchRouteDefaults } from "../../core/catalog/route-defaults";
import { credentialCreateChange, credentialRotateChange, modelRouteCreateChanges, projectCreateChange } from "./changes";
import { runPlanLeg, type PlanLegDeps, type PlanLegOutcome } from "./plan-leg";
import { defaultKeyName, probeProjectKind, writeRepoJournal, writeSdkConfig } from "./scaffold";
import { buildSwiftSnippet, nextStepsText } from "./snippet";
import { readAccountProjectIds, readProjectState, type ProjectState } from "./drift";
// The T-212 F-D1 terminal-safe encoder: every EXTERNAL value interpolated into consent text or a
// prompt question routes through it — a project name / key label / provider slug / cwd carrying
// C0 controls or ESC could otherwise forge or hide lines in the security-sensitive summary.
import { displayCapped, displaySafe } from "../../core/output/display";

/** The secret channel for `init`'s provider credential — the T-217 rules, init's own copy text. */
const INIT_SECRET_CONFIG: WireSecretConfig = {
  envArg: "api-key-env",
  promptQuestion: "Paste the provider API key (input hidden): ",
  emptyDetail: "no API key provided.",
  noChannelDetail: "provide --api-key-env <VAR_NAME> (non-interactive), or run in an interactive terminal for a hidden prompt.",
  grammarDetail:
    "--api-key-env takes the NAME of an environment variable (letters, digits, underscore; not starting with a digit). Export the key first (e.g. export MY_PROVIDER_KEY=...) and pass the variable's NAME.",
  missingEnvDetail: "the environment variable named by --api-key-env is not set or is empty in this shell.",
};

/** What the operator decided. NEVER holds a secret — the key is resolved at change-build time. */
export interface InitIntent {
  readonly mode: "create" | "existing";
  /** The existing project's id (`mode:"existing"`), else null. */
  readonly projectId: string | null;
  /** The new project's name (`mode:"create"`), else null. */
  readonly projectName: string | null;
  readonly profile: string;
  readonly keyName: string;
  readonly keyAction: "mint" | "reuse";
  /** The provider credential to store, or null to store none this run. */
  readonly credential: { readonly provider: string; readonly rotate: boolean } | null;
}

/** The seams gather + execute run over. All injected; nothing here touches `process`. */
export interface InitDeps {
  readonly ctx: Ctx;
  readonly rt: CliRuntime;
  readonly warn: (message: string) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly promptLine: (question: string) => Promise<string | null>;
  readonly now: () => number;
  readonly yes: boolean;
  readonly profile: string;
  readonly apiUrl: string;
  /**
   * The `--api-key-env` VAR NAME exactly as given (never the key itself, and never a value read
   * from it). The secret resolver reads the named variable at change-build time; absent ⇒ the
   * echo-off TTY prompt is the only channel.
   */
  readonly apiKeyEnv?: string;
}

function usage(detail: string, hint: string): CliLocalError {
  return new CliLocalError("usage_error", { detail, hint });
}

const YES_HINT = "agkit init --yes --project-name <name> --key-name <label>";

// ── GATHER ───────────────────────────────────────────────────────────────────────

/**
 * The `--yes` frontend. PURE over flags: every refusal below is decided from argv alone, so a
 * mis-invoked scripted run costs ZERO wire calls. Each message names the EXACT flag that fixes it.
 */
export function gatherFromFlags(deps: InitDeps, input: InitRunInput): InitIntent {
  const projectFlag = deps.rt.flags.project;
  const projectName = input["project-name"];
  if (projectFlag !== undefined && projectName !== undefined) {
    throw usage(
      "--project selects an EXISTING project and --project-name creates a NEW one — they are contradictory",
      "pass exactly one of --project <id> / --project-name <name>",
    );
  }
  if (projectFlag === undefined && projectName === undefined) {
    throw usage(
      "--yes needs the project stated explicitly: pass --project <id> to initialize an existing project, or --project-name <name> to create one",
      YES_HINT,
    );
  }
  const keyName = input["key-name"];
  if (keyName === undefined) {
    throw usage(
      "--yes needs --key-name <label>: the publishable key's label is not defaulted non-interactively (the default is derived from the directory name, which a CI checkout does not control)",
      YES_HINT,
    );
  }
  if (toBool(input["reuse-key"]) && projectName !== undefined) {
    throw usage(
      "--reuse-key reuses a key on an EXISTING project, but this run creates a NEW one — a project that does not exist yet has no key to reuse",
      "drop --reuse-key, or select the project with --project <id>",
    );
  }
  const provider = input.provider;
  const apiKeyEnv = input["api-key-env"];
  if (provider !== undefined && apiKeyEnv === undefined) {
    throw usage(
      "--provider was given with no key channel: the API key never rides argv, so it must come from a named environment variable",
      "add --api-key-env <VAR_NAME> (the NAME of the variable, not the key)",
    );
  }
  if (apiKeyEnv !== undefined && provider === undefined) {
    throw usage(
      "--api-key-env was given with no --provider: a credential is stored FOR a provider",
      "add --provider <slug>",
    );
  }
  const rotate = toBool(input["rotate-credential"]);
  if (rotate && provider === undefined) {
    throw usage("--rotate-credential names no credential to rotate", "add --provider <slug> --api-key-env <VAR_NAME>");
  }
  if (apiKeyEnv !== undefined) {
    // Refuse a bad env-NAME channel NOW, while it is still a clean usage refusal with zero wire
    // calls — after the shown-once mint the same failure could only be a committed partial. The
    // value is checked and DISCARDED; resolution stays at change-build time.
    preflightEnvSecret(deps.ctx, apiKeyEnv, INIT_SECRET_CONFIG);
  }
  return {
    mode: projectName !== undefined ? "create" : "existing",
    projectId: projectFlag ?? null,
    projectName: projectName ?? null,
    profile: deps.profile,
    keyName,
    keyAction: toBool(input["reuse-key"]) ? "reuse" : "mint",
    credential: provider !== undefined ? { provider, rotate } : null,
  };
}

async function ask(deps: InitDeps, question: string): Promise<string> {
  const answer = await deps.promptLine(question);
  if (answer === null) throw usage("no input — initialization was cancelled", "agkit init");
  return answer.trim();
}

/** The interactive gather. Every prompt has the flag named in `args.ts` as its equivalent. */
export async function gatherInteractive(deps: InitDeps, input: InitRunInput): Promise<InitIntent> {
  const projectFlag = deps.rt.flags.project;
  const projectName = input["project-name"];
  if (projectFlag !== undefined && projectName !== undefined) {
    throw usage(
      "--project selects an EXISTING project and --project-name creates a NEW one — they are contradictory",
      "pass exactly one of --project <id> / --project-name <name>",
    );
  }

  let mode: "create" | "existing";
  let projectId: string | null = null;
  let name: string | null = null;
  if (projectName !== undefined) {
    mode = "create";
    name = projectName;
  } else if (projectFlag !== undefined) {
    mode = "existing";
    projectId = projectFlag;
  } else if (deps.ctx.project.value !== null) {
    // A project is already selected by the precedence chain (env / repo / profile default). Offer
    // it rather than silently adopting it — adopting an ambient project is how init would write
    // into the wrong one.
    const selected = deps.ctx.project.value;
    if (await deps.confirm(`Initialize the already-selected project ${displaySafe(selected)} (source: ${deps.ctx.project.source})? [y/N] `)) {
      mode = "existing";
      projectId = selected;
    } else {
      mode = "create";
      name = await ask(deps, "Name for the NEW project: ");
    }
  } else {
    mode = "create";
    name = await ask(deps, "Name for the NEW project: ");
  }
  if (mode === "create" && (name === null || name.length === 0)) {
    throw usage("a project name is required to create a project", "agkit init --project-name <name>");
  }

  if (toBool(input["reuse-key"]) && mode === "create") {
    // The same honor-or-reject rule as the --yes frontend: reuse-on-create is a claim about a key
    // that CANNOT exist. Refused here (post-prompt — `mode` may be prompt-decided) with zero wire
    // calls and zero writes.
    throw usage(
      "--reuse-key reuses a key on an EXISTING project, but this run creates a NEW one — a project that does not exist yet has no key to reuse",
      "drop --reuse-key, or select the project with --project <id>",
    );
  }
  const apiKeyEnvFlag = input["api-key-env"];
  if (apiKeyEnvFlag !== undefined) {
    // Same GATHER-time refusal as the --yes frontend: a bad env-NAME channel must fail before any
    // mutation, not after the shown-once mint. Checked and discarded; resolved at change-build.
    preflightEnvSecret(deps.ctx, apiKeyEnvFlag, INIT_SECRET_CONFIG);
  }
  const keyName = input["key-name"] ?? defaultKeyName(deps.rt.cwd);
  let provider = input.provider ?? null;
  if (provider === null) {
    // Honor-or-reject: `--api-key-env` / `--rotate-credential` are EXPLICIT credential intent —
    // a blank provider answer must not silently no-op them (the `--yes` frontend already rejects
    // the same combinations; this is the interactive mirror).
    const credFlagGiven = input["api-key-env"] !== undefined || toBool(input["rotate-credential"]);
    const answer = await ask(
      deps,
      credFlagGiven
        ? "Provider slug to store the API key for (required — a credential flag was given): "
        : "Provider slug to store an API key for now (server-owned vocabulary; leave blank to skip): ",
    );
    provider = answer.length > 0 ? answer : null;
    if (provider === null && credFlagGiven) {
      throw usage(
        "--api-key-env/--rotate-credential were given but no provider was named — a credential is stored FOR a provider",
        "add --provider <slug>, or answer the provider prompt with a slug",
      );
    }
  }
  return {
    mode,
    projectId,
    projectName: name,
    profile: deps.profile,
    keyName,
    keyAction: toBool(input["reuse-key"]) ? "reuse" : "mint",
    credential: provider !== null ? { provider, rotate: toBool(input["rotate-credential"]) } : null,
  };
}

/**
 * The CONSENT summary — everything the run will do, before it does any of it. Every EXTERNAL
 * value (flag, prompt answer, dirname-derived label, cwd) renders through `displaySafe`: a
 * newline or ESC in a project name must never forge or hide a line of this summary.
 */
export function consentSummary(intent: InitIntent, cwd: string): string {
  const lines = ["agkit init will:"];
  lines.push(
    intent.mode === "create"
      ? `  1. create a project named "${displaySafe(intent.projectName ?? "")}" (a plan you will see and approve)`
      : `  1. use the existing project ${displaySafe(intent.projectId ?? "")}`,
  );
  lines.push(`  2. ${intent.keyAction === "mint" ? `mint a publishable key labelled "${displaySafe(intent.keyName)}" (shown once)` : `reuse the publishable key labelled "${displaySafe(intent.keyName)}"`}`);
  lines.push(
    intent.credential === null
      ? "  3. store NO provider credential (default routes needing one will be skipped)"
      : `  3. ${intent.credential.rotate ? "ROTATE" : "store"} the provider credential for ${displaySafe(intent.credential.provider)}`,
  );
  lines.push("  4. create the recommended default model routes that are missing (a second plan you will see and approve)");
  lines.push(`  5. write .agentkit/project.json (and agentkit.config.json for a JS/TS repo) under ${displaySafe(cwd)}`);
  lines.push(`  profile: ${displaySafe(intent.profile)}`);
  return lines.join("\n") + "\n";
}

// ── EXECUTE ──────────────────────────────────────────────────────────────────────

/** The mutable accumulation of what actually happened. Every field is a FACT, not a plan. */
interface Outcome {
  projectId: string | null;
  projectCreated: boolean;
  keyId: string | null;
  keyMinted: string | null;
  keyReused: boolean;
  credentialStatus: "created" | "rotated" | "pending" | "skipped" | "none";
  routesCreated: string[];
  routesPending: string[];
  routesBlocked: string[];
  routesAlreadyBound: string[];
  filesWritten: string[];
  openPlan: { id: string; danger: string; show_command: string; apply_command: string; reason: string } | null;
  declined: string | null;
  notes: string[];
  // ── COMMITTED-STATE custody flags. Each marks a run that landed a mutation it could not fully
  // deliver on — every one forces `partial` (exit 3), because the operator has a follow-up to do.
  /** The project journal could not be written after the project was CREATED. */
  journalWriteFailed: boolean;
  /** The SDK config could not be written after a shown-once mint — the report is the key's ONLY carrier. */
  keyPersistFailed: boolean;
  /** The mint replayed: the key exists but no secret was disclosed — a fresh mint is the follow-up. */
  keyMintReplayed: boolean;
  /** A leg AFTER a shown-once mint threw; caught so the report (and the key in it) still renders. */
  postKeyLegFailed: boolean;
}

/** A short, terminal-safe, width-bounded label for a caught error — for notes, never for control flow. */
function errorLabel(err: unknown): string {
  if (err instanceof WireProblemError) return `wire: ${err.problem.code}`;
  // A CLI-local detail is a STATIC constant by construction (the closed-set discipline), so it is
  // safe to carry into a note — and it is the message the operator needs to fix the follow-up.
  if (err instanceof CliLocalError) return err.detail !== undefined ? `${err.code}: ${displayCapped(err.detail, 200)}` : err.code;
  return displayCapped(err instanceof Error ? `${err.name}: ${err.message}` : String(err), 120);
}

function planDeps(deps: InitDeps): PlanLegDeps {
  return {
    ctx: deps.ctx,
    warn: deps.warn,
    confirm: deps.confirm,
    promptLine: deps.promptLine,
    isTTY: deps.rt.isTTY,
    now: deps.now,
    yes: deps.yes,
  };
}

/** Re-hint a plan-cap 403 at the plan the operator can actually buy (the voice-identity pattern). */
function rehintLimitExceeded(err: unknown): never {
  if (err instanceof WireProblemError && err.problem.code === "limit_exceeded") {
    err.hintOverride = "your plan's project limit is reached — `agkit billing checkout --plan pro`, or initialize an existing project with `agkit init --project <id>`";
  }
  throw err;
}

const UNIDENTIFIABLE_PROJECT_DETAIL =
  "the project plan applied, but the new project could not be identified unambiguously — nothing was written to this repo; run `agkit project list` to find its id, then `agkit init --project <id>`";

/**
 * Identify the project the just-applied plan created, by DIFFING the account's live project ids
 * around the apply. `plan.apply` returns no created-resource id by design (drift.ts
 * `readAccountProjectIds` documents the byte evidence), and matching on name is unsound — project
 * names are not unique. Exactly one new id is the only acceptable answer: zero (someone else
 * archived it, or the listing raced) and two-or-more (a concurrent create) both FAIL CLOSED
 * (null), with no repo file written for a project init cannot name.
 *
 * The caller records null as a COMMITTED-PARTIAL outcome (exit 3 via `partial:true`), NEVER a
 * usage_error: the plan DID apply, and exit 2 means "terminal — fix the invocation", which a
 * script could answer by re-running the identical create and minting a SECOND project.
 * Residual (accepted, from the ratified set-diff design): an actor that BOTH archives the
 * just-created project AND creates another inside this one window yields one wrong id — the
 * zero/many arms fail closed, and that pairing requires a concurrent writer with full account
 * access, who could misdirect init more directly than this.
 */
function identifyCreatedProject(before: ReadonlySet<string>, after: ReadonlySet<string>): string | null {
  const fresh = [...after].filter((id) => !before.has(id));
  return fresh.length === 1 ? (fresh[0] as string) : null;
}

/** leg A: create the project (or adopt the selected one) and journal it IMMEDIATELY. */
async function legProject(deps: InitDeps, intent: InitIntent, out: Outcome): Promise<boolean> {
  if (intent.mode === "existing") {
    out.projectId = intent.projectId;
  } else {
    // The BEFORE snapshot — an SR read, taken before the plan so the diff below is meaningful.
    const before = await readAccountProjectIds(deps.ctx);
    let leg: PlanLegOutcome;
    try {
      leg = await runPlanLeg(planDeps(deps), {
        note: "agkit init: create project",
        changes: [projectCreateChange(intent.projectName ?? "")],
        preConsented: true, // the CONSENT summary covered this exact change
        floor: "M",
      });
    } catch (err) {
      rehintLimitExceeded(err);
    }
    if (leg.kind === "declined") {
      out.declined = "the project plan was declined — nothing was created and no files were written";
      return false;
    }
    if (leg.kind === "open") {
      out.openPlan = { id: leg.planId, danger: leg.danger, show_command: leg.showCommand, apply_command: leg.applyCommand, reason: leg.reason };
      out.notes.push("the project was NOT created: its plan is still open, so nothing was written to this repo");
      return false;
    }
    // The plan APPLIED — that is a fact regardless of whether the diff below can name the id.
    out.projectCreated = true;
    const created = identifyCreatedProject(before, await readAccountProjectIds(deps.ctx));
    if (created === null) {
      // COMMITTED PARTIAL: report it (exit 3 via `partial`), write nothing, hand the operator
      // the explicit resume path. Never a usage_error after a mutation landed.
      out.notes.push(UNIDENTIFIABLE_PROJECT_DETAIL);
      return false;
    }
    out.projectId = created;
  }
  if (out.projectId === null) return false;
  try {
    out.filesWritten.push(writeRepoJournal(deps.rt, deps.rt.cwd, out.projectId, intent.profile));
  } catch (err) {
    // On the ADOPT path nothing has been mutated, so the raw failure keeps its full fidelity.
    if (!out.projectCreated) throw err;
    // COMMITTED PARTIAL: the project EXISTS but this repo could not record it. Stop with the
    // explicit resume path — running further legs for a project the repo cannot name would leave
    // the next run unable to find any of it.
    out.journalWriteFailed = true;
    out.notes.push(
      `the project was created (id ${displaySafe(out.projectId)}) but .agentkit/project.json could not be written (${errorLabel(err)}) — fix the filesystem, then resume with \`agkit init --project ${displaySafe(out.projectId)}\``,
    );
    return false;
  }
  return true;
}

/** leg B: mint the publishable key, then write the SDK artifact IMMEDIATELY. */
async function legKey(deps: InitDeps, intent: InitIntent, out: Outcome, pid: string, state: ProjectState | null): Promise<void> {
  if (intent.keyAction === "reuse") {
    out.keyReused = true;
    // `resolveKeyConflict` admits a reuse only when EXACTLY ONE live key carries the label (and
    // both gather frontends refuse --reuse-key on the create flow), so this lookup is total on
    // every reachable path; the null fallback keeps the report honest rather than crashing if
    // that invariant ever breaks.
    out.keyId = state?.keys.find((k) => k.name === intent.keyName)?.id ?? null;
    out.notes.push(
      `no publishable key was minted (reusing "${displaySafe(intent.keyName)}") — its secret was shown only at its own mint, so no SDK config file was written`,
    );
    return;
  }
  const resp = await deps.ctx.client.request({
    operationId: "publishable_key.create",
    params: { pid, name: intent.keyName },
  });
  const shaped = shapePublishableKeyMint(resp);
  const data = shaped.data as Record<string, unknown>;
  const id = data["id"];
  out.keyId = typeof id === "string" ? id : null;
  const key = data["key"];
  if (data["shown_once"] === true && typeof key === "string" && key.length > 0) {
    out.keyMinted = key;
    // COMMITTED PARTIAL STATE: the shown-once value reaches disk BEFORE any further leg can fail.
    // A Swift repo writes NO config file (the SDK is wired in code — see the snippet), so its key
    // exists ONLY in this one report; say so rather than let it be lost silently.
    const kind = probeProjectKind(deps.rt, deps.rt.cwd);
    if (kind === "swift") {
      out.notes.push(
        "this looks like a Swift package/app, so no SDK config FILE was written — the publishable key below appears in this report only; paste it into the snippet now",
      );
    } else {
      try {
        out.filesWritten.push(
          writeSdkConfig(deps.rt, deps.rt.cwd, {
            projectId: pid,
            publishableKey: key,
            ...(deps.apiUrl === DEFAULT_API_URL ? {} : { apiUrl: deps.apiUrl }),
          }),
        );
        // Label by reality (codex k04): an `unknown` repo still gets the file — it is the durable
        // carrier of the shown-once key, and JSON-config runtimes without a top-level package.json
        // (Deno/Bun, monorepo subdirs) are legal readers — but the report must not imply the SDK
        // is wired when no marker says anything here reads it.
        if (kind === "unknown") {
          out.notes.push(
            "no JS/TS or Swift project markers were detected — agentkit.config.json was written as the identity handoff, but nothing here is KNOWN to read it; if this runtime does not consume it, wire the key from the snippet and delete the file",
          );
        }
      } catch (err) {
        // COMMITTED PARTIAL: the key is already minted and shown-once — a failed artifact write
        // must not throw the report away, because the report is now the key's ONLY carrier.
        out.keyPersistFailed = true;
        out.notes.push(
          `the SDK config file could not be written (${errorLabel(err)}) — the publishable key in this report is its ONLY copy; record it now, then wire it manually (see the snippet)`,
        );
      }
    }
  } else {
    // The mint REPLAYED: the key exists server-side but no secret was disclosed, so this run
    // cannot finish what it promised — a follow-up mint is required. That is a PARTIAL, exactly
    // like a route blocked on a missing credential.
    out.keyMintReplayed = true;
    out.notes.push(
      "the publishable-key mint replayed a previous request, so no secret was disclosed — mint a fresh key with `agkit publishable-key create --name <label>` if you need one",
    );
  }
}

/** legs C+D: fetch the catalog, select absent-only rows, and run the project-plane plan. */
async function legRoutes(
  deps: InitDeps,
  intent: InitIntent,
  out: Outcome,
  pid: string,
  state: ProjectState | null,
): Promise<void> {
  const catalog: Catalog = await fetchRouteDefaults(deps.ctx, pid);
  const boundTiers = state?.boundTiers ?? new Set<string>();
  const existingCredentials = state?.credentialProviders ?? new Set<string>();
  const credentialed = new Set(existingCredentials);

  // The credential decision, made BEFORE the selection so a route whose provider this run is about
  // to credential is not skipped as "dead".
  let credentialChange: PlanChange | null = null;
  if (intent.credential !== null) {
    const { provider, rotate } = intent.credential;
    if (existingCredentials.has(provider) && !rotate) {
      out.credentialStatus = "skipped";
      out.notes.push(
        `a credential for ${displaySafe(provider)} already exists and was left untouched — pass --rotate-credential to replace it deliberately`,
      );
    } else {
      // The secret resolves HERE: after consent, before the first write of this leg, and only
      // into the change body. It never enters InitIntent, argv, a note, or an error.
      const apiKey = await resolveWireSecret(deps.ctx, { "api-key-env": deps.apiKeyEnv }, INIT_SECRET_CONFIG);
      credentialChange = rotate
        ? credentialRotateChange(pid, provider, apiKey)
        : credentialCreateChange(pid, provider, apiKey);
      credentialed.add(provider);
    }
  } else {
    out.credentialStatus = "none";
  }

  const selection = selectRoutes({ catalog, boundTiers, credentialedProviders: credentialed });
  out.routesAlreadyBound = selection.alreadyBound.map((r: CatalogRow) => r.tier);
  out.routesBlocked = selection.blockedOnCredential.map((r: CatalogRow) => r.tier);
  if (out.routesBlocked.length > 0) {
    const providers = providersNeeded(catalog, boundTiers).filter((p) => !credentialed.has(p));
    out.notes.push(
      `${out.routesBlocked.length} recommended route(s) were NOT created because no credential exists for: ${displaySafe(providers.join(", "))} — a route without a credential is a dead route`,
    );
  }

  const changes = [
    ...(credentialChange !== null ? [credentialChange] : []),
    ...modelRouteCreateChanges(pid, selection.create.map((r: CatalogRow) => r.route)),
  ];
  if (changes.length === 0) {
    if (out.credentialStatus === "none" && selection.create.length === 0) {
      out.notes.push("no default routes were missing — nothing to bind");
    }
    return;
  }

  const leg = await runPlanLeg(planDeps(deps), {
    note: "agkit init: provider credential + default model routes",
    changes,
    // NEVER pre-consented: this leg re-binds live traffic, so it gets its OWN diff + confirm.
    preConsented: false,
    floor: "M",
  });
  const tiers = selection.create.map((r: CatalogRow) => r.tier);
  if (leg.kind === "applied") {
    out.routesCreated = tiers;
    // Label by reality: an applied ROTATION replaced an existing credential — it did not create one.
    if (credentialChange !== null) out.credentialStatus = intent.credential?.rotate === true ? "rotated" : "created";
    return;
  }
  // NOTHING in the plan landed — the credential is INSIDE it, so it is PENDING, never "created".
  out.routesPending = tiers;
  if (credentialChange !== null) out.credentialStatus = "pending";
  if (leg.kind === "open") {
    out.openPlan = { id: leg.planId, danger: leg.danger, show_command: leg.showCommand, apply_command: leg.applyCommand, reason: leg.reason };
  } else {
    out.declined = `the credential + routes plan was declined${leg.discarded ? " and discarded" : " (it could not be discarded and remains open until the server TTL)"} — nothing in it was applied`;
  }
}

/**
 * Run the whole orchestration and shape the report. `state` is the pre-read live state of an
 * EXISTING project (null on the create flow — a project that does not exist yet has none).
 */
export async function executeInit(
  deps: InitDeps,
  intent: InitIntent,
  state: ProjectState | null,
): Promise<{ data: Record<string, unknown>; meta: Record<string, unknown>; warnings: string[] }> {
  const out: Outcome = {
    projectId: null,
    projectCreated: false,
    keyId: null,
    keyMinted: null,
    keyReused: false,
    credentialStatus: "none",
    routesCreated: [],
    routesPending: [],
    routesBlocked: [],
    routesAlreadyBound: [],
    filesWritten: [],
    openPlan: null,
    declined: null,
    notes: [],
    journalWriteFailed: false,
    keyPersistFailed: false,
    keyMintReplayed: false,
    postKeyLegFailed: false,
  };

  if (await legProject(deps, intent, out)) {
    const pid = out.projectId as string;
    await legKey(deps, intent, out, pid, state);
    try {
      await legRoutes(deps, intent, out, pid, state);
    } catch (err) {
      // A shown-once key exists ONLY in this report: once a mint disclosed a secret, no later
      // failure may throw the report away. Without one, the raw error keeps its full fidelity
      // (exit taxonomy, problem doc) — the journal on disk already records the committed leg-A
      // state, so nothing unrecoverable is lost by propagating. (A process kill mid-leg is the
      // accepted residual: no catch can save a report that never renders.)
      if (out.keyMinted === null) throw err;
      out.postKeyLegFailed = true;
      out.notes.push(
        `the credential/routes leg failed after the key was minted (${errorLabel(err)}) — the key in this report is still valid; resume with \`agkit init --project ${displaySafe(pid)}\``,
      );
    }
  }

  const partial =
    out.openPlan !== null ||
    out.declined !== null ||
    out.routesPending.length > 0 ||
    out.routesBlocked.length > 0 ||
    out.credentialStatus === "pending" ||
    // A project was created but could not be identified (the set-diff fail-closed arm): the run
    // committed a mutation it cannot continue from — partial, with the resume path in `notes`.
    (out.projectCreated && out.projectId === null) ||
    // Committed-state custody: a mutation landed that this run could not fully deliver on.
    out.journalWriteFailed ||
    out.keyPersistFailed ||
    out.keyMintReplayed ||
    out.postKeyLegFailed;

  const warnings: string[] = [...out.notes];
  if (out.keyMinted !== null) warnings.push("the publishable key is shown ONCE — record it now; revoke + re-mint to recover");
  if (out.declined !== null) warnings.push(out.declined);

  return {
    data: {
      project: { id: out.projectId, created: out.projectCreated },
      profile: intent.profile,
      publishable_key:
        out.keyReused || out.keyId !== null
          ? {
              id: out.keyId,
              name: intent.keyName,
              ...(out.keyMinted !== null ? { key: out.keyMinted, shown_once: true } : { shown_once: false }),
              reused: out.keyReused,
            }
          : null,
      provider_credential:
        intent.credential === null ? null : { provider: intent.credential.provider, status: out.credentialStatus },
      model_routes: {
        created: out.routesCreated,
        pending: out.routesPending,
        skipped_no_credential: out.routesBlocked,
        already_bound: out.routesAlreadyBound,
      },
      files_written: out.filesWritten,
      pending_plan: out.openPlan,
      swift_snippet: buildSwiftSnippet({ apiUrl: deps.apiUrl, publishableKey: out.keyMinted }),
      next_steps: nextStepsText({
        // "outstanding" means STILL NOT IN PLACE. A credential that already existed (`skipped`)
        // is in place; one that is only inside an open plan (`pending`) is not.
        credentialOutstanding: out.credentialStatus === "pending" || out.credentialStatus === "none",
        routesOutstanding: out.routesPending.length > 0 || out.routesBlocked.length > 0,
      }),
    },
    meta: {
      ...(partial ? { partial: true } : {}),
      ...(out.keyMinted !== null ? { [SHOWN_ONCE_META_KEY]: out.keyMinted } : {}),
    },
    warnings,
  };
}

/** Re-export for the handler: the live-state read is part of the engine's contract. */
export { readProjectState };
