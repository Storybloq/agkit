// T-221 R64 — the RE-RUN safety layer: read what a project ALREADY has, then classify it.
//
// `init` is not a one-shot. It runs again on a fresh clone, after a partial failure, and against a
// project a human already edited in the dashboard. Every one of those must be safe, and "safe"
// here has a precise meaning: init NEVER writes on a re-run unless something init itself creates
// is genuinely MISSING, and it never touches anything it did not create.
//
// The three outcomes (each with its own exit discipline, decided by the caller):
//   • complete   — everything init creates is present and nothing else drifted. Report it and
//                  stop. ZERO mutating calls.
//   • incomplete — a piece init creates is missing. Interactively, offer to resume ONLY the
//                  missing phases under fresh consent; non-interactively, report the exact resume
//                  state as a partial.
//   • drift_only — everything is present, but the project's shape differs from what init would
//                  have produced (extra tiers bound, extra providers credentialed, a profile the
//                  journal disagrees with, or a pinned project that no longer resolves). REPORT
//                  and MUTATE NOTHING — a human's customization is not init's to reconcile.
//
// Every read here is SR. The listing reads FAIL CLOSED on an incomplete drain: deciding "absent"
// from a truncated list would mint a duplicate key or a duplicate route.
import type { Ctx } from "../types";
import { drainList, readCompleteList } from "../../core/client/paginate";
import { CliLocalError, WireProblemError } from "../../core/errors";
// T-212 F-D1: tier/provider names in drift notes are dashboard-authored external values — they
// render terminal-safe, exactly like the consent summary's interpolations.
import { displaySafe } from "../../core/output/display";
import type { Catalog } from "./defaults";

/** One LIVE publishable key — its id and label, never a secret. */
export interface ProjectKeyRef {
  readonly id: string;
  readonly name: string;
}

/** A project's init-relevant live state. Ids/names/tiers/providers only — never a secret. */
export interface ProjectState {
  readonly projectId: string;
  /** False when the pinned project no longer resolves (404) — a drift fact, never a crash. */
  readonly projectPresent: boolean;
  /** The LIVE (non-revoked) publishable keys. Ids are kept so `--reuse-key` can REPORT the key it
   *  reused instead of a null id — a reuse the report cannot name is a claim, not a fact. */
  readonly keys: readonly ProjectKeyRef[];
  /** Providers with a LIVE credential. */
  readonly credentialProviders: ReadonlySet<string>;
  /** Tiers the project already binds a model route for. */
  readonly boundTiers: ReadonlySet<string>;
}

const INCOMPLETE_LIST_DETAIL =
  "the management API could not return a complete listing for this project — refusing to decide what is missing from a truncated list (re-run in a moment)";

// Codex k06: a malformed row is the SAME hazard as a truncated list — every set built here is
// used to decide ABSENCE (mint a key, create a route, call a project "new"), so a row this CLI
// cannot read must refuse, never silently narrow the set. STATIC message; no server bytes ride it.
const MALFORMED_ROW_DETAIL =
  "the management API returned a listing row this CLI could not read — refusing to decide what is missing from malformed data (server protocol error, not a request you can fix)";

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** FAIL-CLOSED list access: non-array data refuses instead of reading as "no rows". */
function requireRows(data: unknown): readonly unknown[] {
  if (!Array.isArray(data)) throw new CliLocalError("usage_error", { detail: MALFORMED_ROW_DETAIL });
  return data;
}

/** FAIL-CLOSED row access: a non-object item refuses instead of being skipped as absent. */
function requireRow(item: unknown): Record<string, unknown> {
  const row = asObject(item);
  if (row === null) throw new CliLocalError("usage_error", { detail: MALFORMED_ROW_DETAIL });
  return row;
}

/** FAIL-CLOSED field access: a live row missing its identifier refuses, never narrows the set. */
function requireStringField(row: Record<string, unknown>, key: string): string {
  const value = stringField(row, key);
  if (value === null) throw new CliLocalError("usage_error", { detail: MALFORMED_ROW_DETAIL });
  return value;
}

/** A resource row is LIVE unless it carries a non-null `revoked_at`. */
function isLive(row: Record<string, unknown>): boolean {
  const revoked = row["revoked_at"];
  return revoked === undefined || revoked === null;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Is this wire failure a 404 (the pinned project is gone)? Anything else propagates. */
function isNotFound(err: unknown): boolean {
  return err instanceof WireProblemError && err.problem.status === 404;
}

/**
 * Read the project's live state with FOUR SR calls. A 404 on `project.get` short-circuits to
 * `projectPresent:false` (no further reads — they would 404 too); every other failure propagates.
 */
export async function readProjectState(ctx: Ctx, pid: string): Promise<ProjectState> {
  try {
    await ctx.client.request({ operationId: "project.get", params: { pid } });
  } catch (err) {
    if (isNotFound(err)) {
      return {
        projectId: pid,
        projectPresent: false,
        keys: [],
        credentialProviders: new Set(),
        boundTiers: new Set(),
      };
    }
    throw err;
  }

  // publishable_key.list is the one PAGINATED read here — drain it, and refuse to decide from a
  // resumable partial (a truncated key list would hide the name conflict we are checking for).
  const keys = await drainList(ctx.client, "publishable_key.list", { pid });
  if (keys.meta?.["next_cursor"] !== undefined && keys.meta["next_cursor"] !== null) {
    throw new CliLocalError("usage_error", { detail: INCOMPLETE_LIST_DETAIL });
  }
  const liveKeys: ProjectKeyRef[] = [];
  for (const item of requireRows(keys.data)) {
    const row = requireRow(item);
    if (!isLive(row)) continue; // a DEAD row decides nothing — skipping it is safe
    liveKeys.push({ id: requireStringField(row, "id"), name: requireStringField(row, "name") });
  }

  const credentialProviders = new Set<string>();
  for (const item of readCompleteList(await ctx.client.request({ operationId: "credential.list", params: { pid } }))) {
    const row = requireRow(item);
    if (!isLive(row)) continue;
    credentialProviders.add(requireStringField(row, "provider"));
  }

  const boundTiers = new Set<string>();
  for (const item of readCompleteList(await ctx.client.request({ operationId: "model_route.list", params: { pid } }))) {
    boundTiers.add(requireStringField(requireRow(item), "tier"));
  }

  return { projectId: pid, projectPresent: true, keys: liveKeys, credentialProviders, boundTiers };
}

/**
 * Every LIVE project id on the account.
 *
 * [BRIEF-vs-BYTES, byte-verified] This read exists because `plan.apply` deliberately does NOT
 * return the created resource's id: `results[]` carries only the CLOSED literal vocabulary
 * (`APPLY_RESULT_VOCABULARY` — "created"/"updated"/… — management-core plan-execute.ts, whose G1
 * comment states "nothing dynamic ever escapes"), and the frozen golden
 * `management-plan.apply.response.json` confirms it. So the plan that creates a project cannot
 * name it. Init snapshots the id set BEFORE the plan and diffs it AFTER — matching on NAME would
 * bind the wrong project whenever two projects share one, which is legal.
 *
 * The read FAILS CLOSED on an incomplete drain: a truncated "before" set would make an
 * already-existing project look new.
 */
export async function readAccountProjectIds(ctx: Ctx): Promise<Set<string>> {
  const listed = await drainList(ctx.client, "project.list", {});
  if (listed.meta?.["next_cursor"] !== undefined && listed.meta["next_cursor"] !== null) {
    throw new CliLocalError("usage_error", { detail: INCOMPLETE_LIST_DETAIL });
  }
  const ids = new Set<string>();
  // FAIL CLOSED on malformed rows: an id silently dropped from the BEFORE snapshot would make an
  // already-existing project look new — the diff would then bind the WRONG project.
  for (const item of requireRows(listed.data)) {
    ids.add(requireStringField(requireRow(item), "id"));
  }
  return ids;
}

export type InitVerdict = "complete" | "incomplete" | "drift_only";

export interface DriftReport {
  readonly verdict: InitVerdict;
  /** Providers the catalog needs a credential for that the project does not have. */
  readonly missingCredentials: readonly string[];
  /** Catalog tiers that are unbound AND creatable now (their provider IS credentialed). */
  readonly creatableTiers: readonly string[];
  /**
   * Catalog tiers that are unbound but NOT creatable now — their provider has no credential
   * (codex k12): a `missing` report that named only the provider would HIDE the tier, and an
   * operator who then added the credential out-of-band would believe the routes were done.
   */
  readonly blockedTiers: readonly string[];
  /** True when the project has no live publishable key at all. */
  readonly missingKey: boolean;
  /** Non-actionable observations. Present ⇒ init reports them and mutates nothing. */
  readonly notes: readonly string[];
}

export interface ClassifyInput {
  readonly state: ProjectState;
  readonly catalog: Catalog;
  /** The profile the repo journal pinned, or null when it pinned none. */
  readonly journalProfile: string | null;
  /** The profile this invocation actually resolved. */
  readonly effectiveProfile: string;
}

/**
 * Classify a project against what init creates. PURE — the caller owns every decision that
 * follows from the verdict.
 */
export function classifyDrift(input: ClassifyInput): DriftReport {
  const { state, catalog } = input;
  const notes: string[] = [];
  if (!state.projectPresent) {
    notes.push(
      "the project pinned by .agentkit/project.json no longer resolves — nothing was changed; re-point it with `agkit init --project <id>` or remove the file",
    );
    return {
      verdict: "drift_only",
      missingCredentials: [],
      creatableTiers: [],
      blockedTiers: [],
      missingKey: false,
      notes,
    };
  }

  const missingCredentials: string[] = [];
  const creatableTiers: string[] = [];
  const blockedTiers: string[] = [];
  const catalogTiers = new Set<string>();
  const catalogProviders = new Set<string>();
  for (const row of catalog.rows) {
    catalogTiers.add(row.tier);
    catalogProviders.add(row.requiresCredential);
    if (state.boundTiers.has(row.tier)) continue;
    if (state.credentialProviders.has(row.requiresCredential)) {
      creatableTiers.push(row.tier);
    } else {
      // The TIER is tracked independently of the provider dedup (codex k12): two blocked tiers
      // sharing one uncredentialed provider are still two blocked tiers.
      blockedTiers.push(row.tier);
      if (!missingCredentials.includes(row.requiresCredential)) {
        missingCredentials.push(row.requiresCredential);
      }
    }
  }
  const missingKey = state.keys.length === 0;

  if (input.journalProfile !== null && input.journalProfile !== input.effectiveProfile) {
    notes.push(
      "the profile pinned by .agentkit/project.json is not the profile this invocation resolved — nothing was changed; pass --profile to match, or update the file",
    );
  }
  for (const tier of state.boundTiers) {
    if (!catalogTiers.has(tier)) {
      notes.push(`this project binds a tier the defaults catalog does not: ${displaySafe(tier)}`);
    }
  }
  for (const provider of state.credentialProviders) {
    if (!catalogProviders.has(provider)) {
      notes.push(`this project holds a credential the defaults catalog does not require: ${displaySafe(provider)}`);
    }
  }

  if (missingKey || missingCredentials.length > 0 || creatableTiers.length > 0) {
    return { verdict: "incomplete", missingCredentials, creatableTiers, blockedTiers, missingKey, notes };
  }
  return {
    verdict: notes.length > 0 ? "drift_only" : "complete",
    missingCredentials,
    creatableTiers,
    blockedTiers,
    missingKey,
    notes,
  };
}
