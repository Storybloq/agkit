// `audit list` handler (T-214, audit.list, audit:read, SR). This is an ACCOUNT-scoped read
// (GET /account/audit-log — NO {pid} path param), de-clamped server-side (keyset created_at
// DESC + id DESC, default 50 / max 200, unbounded via cursor). It drains through the T-211
// pipeline with FULL --limit/--cursor/--paginate; the drain has NO row cap and this handler
// imposes none — re-imposing the legacy 500/50 dashboard clamps is FORBIDDEN (CLI-12 R18).
//
// C-2 / D-6 — the `project_id` FILTER binds ONLY from an EXPLICIT project selection (the
// `--project` flag or the AGKIT_PROJECT env). A repo `.agentkit/project.json` or a profile
// default must NEVER silently narrow the account-wide audit trail — that would hide rows from
// an operator who asked for the account view (honesty: never silently filter). Project-SCOPED
// routes need a project (requireProject, full chain); audit's project_id is an OPTIONAL filter,
// explicit-only. When it binds, meta.filters names it (label-by-reality).
import { z } from "zod";
import type { CommandHandler, CommandResult } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const auditListArgs = z
  .object({
    since: z.string().optional().describe("Only events at/after this ISO-8601 date or datetime (server validates)."),
    until: z.string().optional().describe("Only events at/before this ISO-8601 date or datetime (server validates)."),
    action: z.string().optional().describe("Filter by action string."),
    actor: z.string().optional().describe("Filter by actor."),
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows per page (server max 200)."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type AuditListInput = z.infer<typeof auditListArgs>;

export const auditList: CommandHandler<AuditListInput> = async (ctx, input) => {
  const params: Record<string, unknown> = { ...input };

  // Explicit-only project filter (C-2/D-6): flag or env source ONLY.
  const explicitProject =
    ctx.project.value !== null && (ctx.project.source === "flag" || ctx.project.source === "env")
      ? ctx.project.value
      : null;
  if (explicitProject !== null) params.project_id = explicitProject;

  const result: CommandResult = ctx.clientFlags?.paginate
    ? await drainList(ctx.client, "audit.list", params)
    : singlePageResult(await ctx.client.request({ operationId: "audit.list", params }));

  // Label the applied filter in meta WITHOUT disturbing a resumable next_cursor (which drives
  // partial:true / exit 3). No project bound ⇒ no meta.filters entry at all.
  if (explicitProject !== null) {
    return { ...result, meta: { ...result.meta, filters: { project_id: explicitProject } } };
  }
  return result;
};
