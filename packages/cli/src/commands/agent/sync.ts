// `agent sync --file <f>` — the direct_confirm ceremony (T-218 §3.1, D-3). The ONE ratified
// PR-`direct` exception (OD-5): the wire route `profile.sync` is gating:"direct" (NO CHANGE_TABLE
// key — it is not plannable), Idempotency-Key required, danger PR. It is wrapped in the CLI's
// `direct_confirm` ceremony so the operator reviews a per-profile diff and types a confirm value
// BEFORE any write — every property the ticket's plan/apply prose wanted (reviewable per-slug diff,
// typed confirm at PR, no opaque bulk overwrite) preserved without a server plan.
//
// TWO halves, both pure over injected seams:
//   • `prepareAgentSync` (the mutation binding, RC-8 — invoked EXACTLY once before any render/prompt):
//     read the file through the runtime seam, parse + strict-validate it (ALL zero-wire — R1), fetch
//     live state with EXACTLY ONE `profile.list` (A-9: ZERO `tool.list` — an unbounded fan-out), and
//     compute the per-profile diff. Returns the preview + `expectedConfirm = "sync N profiles"` (the
//     CLI's own PR-danger typed challenge — the wire body has no confirm member) + the TOCTOU-closed
//     `target.payload = {profiles: <the validated file content>}`.
//   • `agentSync` (the handler): assert the direct pass, then EXACTLY ONE `profile.sync` whose body is
//     `pass.target.payload` — the REVIEWED bytes, NEVER a re-read of the file (FORBIDDEN 1 / R8). On a
//     server 400 — and ONLY a 400, the route's one payload-reflecting status — it rebuilds an
//     ALLOWLISTED envelope (A-7/A-12) so a file-derived string in the problem body can never be
//     echoed back; every other status (and every other command) keeps the general renderer.
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, requireRuntime } from "../types";
import { WireProblemError, PreClassifiedError, allowlistedWireErrorEnvelope } from "../../core/errors";
import { readCompleteList } from "../../core/client/paginate";
import { parseSyncFile, computeSyncDiff, SYNC_FILE_MAX_BYTES, type SyncDiff } from "./sync-file";

export const agentSyncArgs = z
  .object({
    file: z.string().min(1).describe("Path to the JSON sync file ({\"profiles\":[…]})."),
    // Per-spec typed-confirm channel (NEVER a global flag — F4 strip-set hazard). On a TTY it is
    // prompted; non-interactively it is REQUIRED (with --yes).
    confirm: z.string().min(1).optional().describe('The confirm value ("sync N profiles"), required non-interactively.'),
  })
  .strict();
export type AgentSyncInput = z.infer<typeof agentSyncArgs>;

/** Render the per-profile diff preview (D-4/A-9/A-13). Slugs / tool names are the operator's OWN file
 *  identifiers — shown through the ceremony's displaySafe chokepoint; the prompt body is a char-count
 *  only, and schema bodies are never previewed. */
function renderSyncPreviewLines(diff: SyncDiff): string[] {
  const lines: string[] = [
    "This SYNCS the file's agent profiles into this project (prod-rebinding).",
    "Sync is UPSERT-ONLY: it never deletes or disables a profile or tool.",
    "",
  ];
  for (const e of diff.entries) {
    let head: string;
    if (e.kind === "create") head = `  + create: ${e.slug}`;
    else if (e.kind === "updated") head = `  ~ profile fields updated: ${e.slug} (changed: ${e.changedFields.join(", ")})`;
    else head = `  = profile fields unchanged: ${e.slug}`;
    lines.push(head);
    if (e.promptCharDelta !== null) {
      lines.push(`      static_system_prompt: changed (${e.promptCharDelta.from} -> ${e.promptCharDelta.to} chars)`);
    }
    if (e.toolNames.length > 0) {
      // A-13: ALWAYS qualify a tool-bearing profile — never a bare "unchanged" (tool writes may occur;
      // tools are not live-diffed).
      lines.push(
        `      tools (from file): ${e.toolNames.join(", ")} — ${e.toolNames.length} declaration(s) will be upserted (live tool diff unavailable)`,
      );
    }
  }
  if (diff.retainedProfiles.length > 0) {
    lines.push("");
    for (const slug of diff.retainedProfiles) {
      lines.push(`  retained: ${slug} (sync never deletes — this profile and its tools are kept; 'agkit agent delete ${slug}' to remove)`);
    }
  }
  lines.push("");
  lines.push("Note: sync cannot change enabled / safety_settings / thinking_config.");
  lines.push("Note: the diff is computed against live state now; sync applies THE FILE CONTENT reviewed above.");
  return lines;
}

/**
 * The direct_confirm ceremony binding's `prepare` (RC-8, invoked once before any render/prompt).
 * Steps 1-5 happen with ZERO wire calls (read + parse + strict-validate + caps + duplicates + per-tool
 * schema); step 6 is EXACTLY ONE `profile.list`; step 7 is the pure diff. A file mutated after this
 * returns cannot affect the write — the handler sends `pass.target.payload` (the reviewed bytes).
 */
export async function prepareAgentSync(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = input as AgentSyncInput;
  const pid = requireProject(ctx);
  const runtime = requireRuntime(ctx);
  if (runtime.readTextFile === undefined) {
    throw new Error("agkit: internal — agent sync requires the readTextFile seam but it was not injected");
  }

  // 1-5: read + parse + validate — a missing/dir/oversize/invalid-UTF-8 file (the reader) or any
  // structural / cap / duplicate / schema violation (parseSyncFile) is a value-free usage_error here,
  // BEFORE any wire call (R1).
  const text = await runtime.readTextFile(parsed.file, { maxBytes: SYNC_FILE_MAX_BYTES });
  const { profiles } = parseSyncFile(text);

  // 6: EXACTLY ONE live read (A-9 — no tool.list). Read STRICTLY: a shape-invalid or truncated
  // envelope is a terminal protocol error, NEVER a silently-empty live state. Degrading to `[]`
  // here would render every file profile as a `create` and drop every `retained:` line — an
  // operator would type the confirm value against a review computed from a server fault.
  const page = await ctx.client.request({ operationId: "profile.list", params: { pid } });
  const serverProfiles = readCompleteList(page);

  // 7: the pure per-profile diff → preview.
  const diff = computeSyncDiff(profiles, serverProfiles);
  const lines = renderSyncPreviewLines(diff);

  return {
    preview: { title: "Sync agent profiles from the file into this project (prod-rebinding, upsert-only).", lines },
    // Client-authored PR-danger typed challenge (the wire body has no confirm member). Displayed by
    // the ceremony's `confirm value:` line and validated by its `validate_confirm` cell.
    expectedConfirm: `sync ${profiles.length} profiles`,
    // TOCTOU close: the handler sends THIS payload — never a re-read of --file.
    target: { payload: { profiles } },
  };
}

export const agentSync: CommandHandler<AgentSyncInput> = async (ctx, _input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    throw new Error("agkit: internal — agent sync requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  const payload = pass.target?.payload;
  if (payload === null || typeof payload !== "object") {
    throw new Error("agkit: internal — agent sync ceremony pass is missing the prepared target payload");
  }
  const pid = requireProject(ctx);

  try {
    // EXACTLY ONE write — `{pid}` is the path param, `profiles` becomes the JSON body `{profiles}`; the
    // ceremony confirm is NOT sent (the wire body has no confirm member). Idempotency-Key auto-added.
    const result = await ctx.client.request({
      operationId: "profile.sync",
      params: { pid, ...(payload as Record<string, unknown>) },
    });
    return {
      data: result,
      warnings: [
        "sync is upsert-only — it never deletes or disables; use 'agkit agent delete <slug>' to remove a profile",
      ],
    };
  } catch (err) {
    // A-7/A-12: a profile.sync 400 could echo file-derived text through its problem body — the api
    // maps `ProfileSyncValidationError` to `managementProblem("invalid_request", {detail: err.message})`
    // (routes/management/profiles.ts), the ONE payload-reflecting status on this route. Rebuild an
    // ALLOWLISTED envelope for it (validated code/status/request_id/retry + a STATIC value-free
    // detail) — server title/detail/extensions are DROPPED. Sync-specific; every other command is
    // untouched.
    //
    // ONLY 400. Every other wire failure keeps the general renderer: a 401/403 is decided upstream
    // of payload processing (it reflects nothing), a 404 names the project, and a 5xx is generic AND
    // RETRYABLE — scrubbing those would relabel an auth failure or a transient outage as "the server
    // rejected the sync payload", which is false (§B-9 label-by-reality) and buries the real remedy.
    if (err instanceof WireProblemError && err.problem.status === 400) {
      throw new PreClassifiedError(
        allowlistedWireErrorEnvelope(err.problem, { staticDetail: "the server rejected the sync payload" }),
      );
    }
    throw err;
  }
};
