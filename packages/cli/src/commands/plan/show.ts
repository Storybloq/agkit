// `plan show <plan-id>` handler (T-212 S6, plans:read). A pure plan.get passthrough:
// `--json` emits the contract Plan verbatim (the STABLE diff schema — A-12 pins the
// byte-stable non-secret twin), while the chokepoint's D5 rule masks any server
// `(secret)` diff sentinel to `(sensitive)` on the way out.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const planShowArgs = z
  .object({
    id: z.string().min(1).describe("The plan id to inspect."),
  })
  .strict();
export type PlanShowInput = z.infer<typeof planShowArgs>;

export const planShow: CommandHandler<PlanShowInput> = async (ctx, input) => {
  const plan = await ctx.client.request({ operationId: "plan.get", params: { id: input.id } });
  return { data: plan };
};
