// `billing info` handler (T-215, billing.get, billing:read, SR). A pure passthrough read: send
// `billing.get` (D-4: the CLI verb is `info` for ticket fidelity, but the wire op snake-folds to
// `billing.get`, bound via a SPEC_OP_OVERRIDES entry in the version fence) with empty params and
// return the server DTO unchanged. Account-plane — NO requireProject.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const billingInfoArgs = z.object({}).strict();
export type BillingInfoInput = z.infer<typeof billingInfoArgs>;

export const billingInfo: CommandHandler<BillingInfoInput> = async (ctx) => {
  const data = await ctx.client.request({ operationId: "billing.get", params: {} });
  return { data };
};
