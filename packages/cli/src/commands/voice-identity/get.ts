// `voice-identity get <key> [--provider <p>]` handler (T-220; identities:read, SR). A plain
// read over `identity.get` — with `--provider` the S3 resolver is BYPASSED entirely (zero extra
// reads); without it the provider comes from the bounded honor-or-reject scan (resolve.ts).
// The read DTO is the resourceId-free projection (F5: the secret never leaves the server on any
// read) and carries an ETag header the toggle prepares pin against.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { resolveIdentityProvider } from "./resolve";

export const voiceIdentityGetArgs = z
  .object({
    key: z.string().min(1).describe("Identity key (the row's natural key, with its provider)."),
    provider: z.string().min(1).optional().describe("Provider owning the key (skips the list scan)."),
  })
  .strict();
export type VoiceIdentityGetInput = z.infer<typeof voiceIdentityGetArgs>;

export const voiceIdentityGet: CommandHandler<VoiceIdentityGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const provider = input.provider ?? (await resolveIdentityProvider(ctx, input.key)).provider;
  const resp = await ctx.client.request({
    operationId: "identity.get",
    params: { pid, provider, key: input.key },
  });
  return { data: resp };
};
