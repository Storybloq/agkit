// `project get [id]` handler (T-216 R1; N-011 projects family, projects:read, SR). A plain read
// over `project.get` with the OPTIONAL-MODE positional (S3): when the `[id]` token is present it
// names the project; when ABSENT the handler falls back to the ambient effective project
// (`requireProject(ctx)` — the F0 precedence chain, which throws the teachable usage_error when
// no source supplies one). The returned DTO includes the attestation members (`app_attest_app_id`,
// `app_attest_environment`) — that IS the folded attestation read (`attestation get` projects it).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";

export const projectGetArgs = z
  .object({
    // A PLAIN optional string (S3/RR-4c): a missing positional token parses to an ABSENT key —
    // never a default/transformed value — so the ambient-project fallback below is deliberate.
    id: z.string().min(1).optional().describe("Project id (defaults to the effective project)."),
  })
  .strict();
export type ProjectGetInput = z.infer<typeof projectGetArgs>;

export const projectGet: CommandHandler<ProjectGetInput> = async (ctx, input) => {
  const pid = input.id ?? requireProject(ctx);
  const resp = await ctx.client.request({ operationId: "project.get", params: { pid } });
  return { data: resp };
};
