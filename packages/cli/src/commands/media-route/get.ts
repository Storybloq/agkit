// `media-route get <capability>` handler (T-220; media-routes:read, SR). A plain read over
// `media_route.get` — the capability is the row's natural key (an INTENT word like image/voice,
// user-supplied and uninterpreted; the capability VOCABULARY is server-owned, §5-F9). An unknown
// capability is the server's uniform 404 — no client-side vocabulary check, ever.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";

export const mediaRouteGetArgs = z
  .object({
    capability: z.string().min(1).describe("Media capability key (e.g. image, voice)."),
  })
  .strict();
export type MediaRouteGetInput = z.infer<typeof mediaRouteGetArgs>;

export const mediaRouteGet: CommandHandler<MediaRouteGetInput> = async (ctx, input) => {
  const pid = requireProject(ctx);
  const resp = await ctx.client.request({
    operationId: "media_route.get",
    params: { pid, capability: input.capability },
  });
  return { data: resp };
};
