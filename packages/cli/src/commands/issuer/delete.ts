// `issuer delete <id>` args + plan-change builder (T-216 R11; issuers:destroy, wire danger
// "PR+D" → CLI `"PR"` (D3 — the CLI Danger union has no compound member; D and PR share the
// decision matrix, PR additionally fires the PROD-REBINDING banner)). Plan-kind BODYLESS delete
// (the archive/GAP-12 shape: a bodyless change carries NO `body` key at all) over the executable
// `issuer:delete` CHANGE_TABLE entry — locks out live end-users, so the plan's typed
// confirm-string ceremony is the only path.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

export const issuerDeleteArgs = z
  .object({
    id: z.string().min(1).describe("Trusted-issuer id to delete."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type IssuerDeleteInput = z.infer<typeof issuerDeleteArgs>;

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function issuerDeleteChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const { id } = issuerDeleteArgs.parse(input);
  // issuer:delete is BODYLESS — no `body` key at all (GAP 12).
  return [
    {
      action: "delete",
      resource: "issuer",
      path: renderRoutePath("issuer.delete", { pid: requireProject(ctx), id }),
    },
  ];
}
