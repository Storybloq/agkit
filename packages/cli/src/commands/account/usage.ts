// `account usage` handler (T-215, account.usage, usage:read, SR). A pure passthrough read: send
// `account.usage` with empty params and return the server DTO unchanged. Account-plane — NO
// requireProject (no {pid}; the token anchors the account server-side).
import { z } from "zod";
import type { CommandHandler } from "../types";

export const accountUsageArgs = z.object({}).strict();
export type AccountUsageInput = z.infer<typeof accountUsageArgs>;

export const accountUsage: CommandHandler<AccountUsageInput> = async (ctx) => {
  const data = await ctx.client.request({ operationId: "account.usage", params: {} });
  return { data };
};
