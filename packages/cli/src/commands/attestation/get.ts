// `attestation get` handler (T-216 R3; noun RATIFIED by R-G — the 2-token project-scoped
// convention like issuer/token). A SAFE READ over `project.get` (there is NO attestation route on
// the wire — the attestation members live ON the project DTO): fetch the effective project and
// PROJECT the attestation members. Tolerant of absence (absent members → null): the projection is
// label-by-reality over the returned bytes, never a re-derivation.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";

export const attestationGetArgs = z.object({}).strict();
export type AttestationGetInput = z.infer<typeof attestationGetArgs>;

/** A non-empty string member off the raw DTO, else null (tolerant projection). */
function member(raw: unknown, key: string): string | null {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v = r[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const attestationGet: CommandHandler<AttestationGetInput> = async (ctx) => {
  const pid = requireProject(ctx);
  const resp = await ctx.client.request({ operationId: "project.get", params: { pid } });
  return {
    data: {
      project_id: pid,
      app_attest_app_id: member(resp, "app_attest_app_id"),
      app_attest_environment: member(resp, "app_attest_environment"),
    },
  };
};
