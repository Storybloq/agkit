// `plan discard <plan-id>` handler (T-212 S6, plans:read — plan.discard A705 is danger M
// gated by plans:read; you can only discard YOUR OWN open plans). Zero side effects on
// managed state: it closes an open plan. CEREMONY-EXEMPT (registry allowlist): running a
// plan ceremony to discard a plan would be circular theater — the durable exemption member.
//
// T-222 hook (doc note only — NOTHING of selftest is built here): the selftest write probe
// composes plan.create(minimal) → plan.discard through THIS handler's route.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const planDiscardArgs = z
  .object({
    id: z.string().min(1).describe("The open plan id to discard."),
  })
  .strict();
export type PlanDiscardInput = z.infer<typeof planDiscardArgs>;

export const planDiscard: CommandHandler<PlanDiscardInput> = async (ctx, input) => {
  const result = await ctx.client.request({ operationId: "plan.discard", params: { id: input.id } });
  return { data: result };
};
