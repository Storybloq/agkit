// `issuer get <id>` handler (T-216 R9; N-011 issuers family, issuers:read, SR). A plain read over
// `issuer.get` with a REQUIRED-mode positional id; the pid comes from the resolved project context
// (F0: `requireProject(ctx)` throws the teachable usage_error BEFORE any wire call).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";

export const issuerGetArgs = z
  .object({
    id: z.string().min(1).describe("Trusted-issuer id."),
  })
  .strict();
export type IssuerGetInput = z.infer<typeof issuerGetArgs>;

export const issuerGet: CommandHandler<IssuerGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const resp = await ctx.client.request({ operationId: "issuer.get", params: { pid, id: input.id } });
  return { data: resp };
};
