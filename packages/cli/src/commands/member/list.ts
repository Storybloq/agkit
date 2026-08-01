// `member list` handler (T-215, member.list, account:read, SR — RN-2: `members` folds into the
// `account` scope family; no `members:*` family exists). A plain SINGLE-SHOT passthrough read:
// the route is paginated:false (D-5), so there are NO --limit/--cursor flags — send `member.list`
// with empty params and return the server DTO unchanged. Account-plane — NO requireProject.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const memberListArgs = z.object({}).strict();
export type MemberListInput = z.infer<typeof memberListArgs>;

export const memberList: CommandHandler<MemberListInput> = async (ctx) => {
  const data = await ctx.client.request({ operationId: "member.list", params: {} });
  return { data };
};
