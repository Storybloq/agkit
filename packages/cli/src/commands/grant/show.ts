// `grant show <grant-id>` handler (T-299 R2; oauth.grant.get, tokens:read, SR). An ACCOUNT-tier
// single-resource read (GET /v1/management/oauth/grants/{id} — no {pid}). The frozen row is
// `paginated:false`, so the command advertises ZERO pagination flags.
//
// Server bytes pass through verbatim: the `oauth_grant` projection carries NO token material of any
// kind (D-GMT.1 absence-on-the-wire) — the get-only `tokens` array is per-child-token METADATA
// (id / class / timestamps, `additionalProperties:false`), never a plaintext, hash, prefix or
// masked display. There is nothing here for the CLI to redact, and nothing for it to invent.
import { z } from "zod";
import type { CommandHandler } from "../types";

export const grantShowArgs = z
  .object({
    id: z.string().min(1).describe("Grant id."),
  })
  .strict();
export type GrantShowInput = z.infer<typeof grantShowArgs>;

export const grantShow: CommandHandler<GrantShowInput> = async (ctx, input) => {
  const resp = await ctx.client.request({ operationId: "oauth.grant.get", params: { id: input.id } });
  return { data: resp };
};
