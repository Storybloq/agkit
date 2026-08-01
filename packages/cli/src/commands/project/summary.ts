// `project summary [project-id]` handler (T-299 R1; project.summary, projects:read, SR). The
// project-summary read (GET /v1/management/projects/{pid}/summary), served since the projects plane
// landed and — until now — reachable from no CLI/MCP surface at all (the recorded UNSURFACED_OPS
// finding). Output discipline is `project get`'s exactly: JSON-first, ceremony-free, no `--yes`.
//
// The OPTIONAL-MODE positional (S3 idiom): when the `[project-id]` token is present it names the
// project; when ABSENT the handler falls back to the ambient effective project (`requireProject` —
// the F0 precedence chain, which throws the teachable usage_error when no source supplies one).
//
// PASS THE SERVER BYTES THROUGH. There is no `project_summary` `$def` in the frozen resources
// schema — the server hand-builds `{object:"project_summary", project, resources}` — so the CLI
// must not invent a client-side shape for it (§B-10: cloud owns the wire). The row is
// `paginated:false`, so the command advertises no pagination flags.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";

export const projectSummaryArgs = z
  .object({
    // A PLAIN optional string (S3/RR-4c): a missing positional token parses to an ABSENT key —
    // never a default/transformed value — so the ambient-project fallback below is deliberate.
    id: z.string().min(1).optional().describe("Project id (defaults to the effective project)."),
  })
  .strict();
export type ProjectSummaryInput = z.infer<typeof projectSummaryArgs>;

export const projectSummary: CommandHandler<ProjectSummaryInput> = async (ctx, input) => {
  const pid = input.id ?? requireProject(ctx);
  const resp = await ctx.client.request({ operationId: "project.summary", params: { pid } });
  return { data: resp };
};
