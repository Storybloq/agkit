// `account get` handler (T-215, account.get, account:read, SR). A pure passthrough read on the
// whoami/usage-series template: send `account.get` with empty params and return the server DTO
// UNCHANGED (Acceptance-3: `account get --json` passes the DTO through verbatim — label by reality,
// never re-projected; unknown/forward-added fields survive through the redaction chokepoint). The
// account plane carries NO {pid}: the token anchors the account server-side (billing.ts), so there
// is NO requireProject here.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const accountGetArgs = z.object({}).strict();
export type AccountGetInput = z.infer<typeof accountGetArgs>;

export const accountGet: CommandHandler<AccountGetInput> = async (ctx) => {
  const data = await ctx.client.request({ operationId: "account.get", params: {} });
  return { data };
};
