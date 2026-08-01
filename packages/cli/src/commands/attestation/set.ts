// `attestation set` args + plan-change builder (T-216 R4; projects:write, danger M — the route
// row project.update is AUTHORITATIVE over the ticket's "(PR)" prose, D1). Plan-kind over the
// executable `project:update` entry (D2 — same ratified plan-door as `project rename`; the R18
// cross-layer pin covers this builder too). Body semantics (frozen `project_update_request`):
//   • `--clear`                 ⇒ `app_attest_app_id: null` (null CLEARS the stored App ID —
//                                 fail-closed: enrolled keys stop verifying);
//   • `--app-attest-app-id X`   ⇒ `app_attest_app_id: X`;
//   • `--environment Y`         ⇒ `app_attest_environment: Y` (the exact wire enum);
//   • only PRESENT members ride (partial patch; all-optional additionalProperties:false $def);
//   • NEVER `name` in this body (this surface owns the attestation members only).
// zod refinements (client-teachable BEFORE any wire call): `--clear` + `--app-attest-app-id` are
// contradictory; an empty invocation sets nothing.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const attestationSetArgs = z
  .object({
    "app-attest-app-id": z
      .string()
      .min(1)
      .optional()
      .describe("The App Attest App ID to bind (TEAMID.bundle.id)."),
    environment: z
      .enum(["development", "production"])
      .optional()
      .describe("App Attest environment: development or production."),
    clear: z.boolean().optional().describe("Clear the stored App Attest App ID (fail-closed)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (only needed if the server plan is destructive/prod-rebinding)."),
  })
  .strict()
  .superRefine((val, refCtx) => {
    if (val.clear === true && val["app-attest-app-id"] !== undefined) {
      refCtx.addIssue({
        code: "custom",
        message: "--clear and --app-attest-app-id are contradictory: one clears the App ID, the other sets it — pass exactly one",
      });
    }
    if (val.clear !== true && val["app-attest-app-id"] === undefined && val.environment === undefined) {
      refCtx.addIssue({
        code: "custom",
        message: "nothing to set — pass at least one of --app-attest-app-id, --environment, or --clear",
      });
    }
  });
export type AttestationSetInput = z.infer<typeof attestationSetArgs>;

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function attestationSetChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = attestationSetArgs.parse(input);
  const body: Record<string, unknown> = {};
  if (parsed.clear === true) {
    body.app_attest_app_id = null; // null CLEARS (the $def's documented semantics)
  } else if (parsed["app-attest-app-id"] !== undefined) {
    body.app_attest_app_id = parsed["app-attest-app-id"];
  }
  if (parsed.environment !== undefined) body.app_attest_environment = parsed.environment;
  return [
    {
      action: "update",
      resource: "project",
      path: renderRoutePath("project.update", { pid: requireProject(ctx) }),
      body,
    },
  ];
}
