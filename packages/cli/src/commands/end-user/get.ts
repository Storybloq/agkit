// `end-user get` handler (T-214, end_user.get, usage:read, SR). Unpaginated singleton read:
// pass the server bytes through — the response EMBEDS a `models[]` per-model breakdown
// (DEV-2: a separate `end-user models` command would be a client-side re-projection
// masquerading as a wire surface, so it is OMITTED — the reference documents the `--jq
// .models` projection recipe instead). The route path is /projects/{pid}/end-users/{user_hash}:
// {pid} rides from the resolved project (F0), {user_hash} from `--user-hash` (DEV-8, flags-first).
// The 64-hex format is the SERVER's authority (non-64-hex → uniform 404) — the client mirrors
// only "non-empty" and lets the server 404 teach.
import { z } from "zod";
import { requireProject, type CommandHandler } from "../types";

export const endUserGetArgs = z
  .object({
    "user-hash": z.string().min(1).describe("The end-user's external_user_id_hash (server 404s a non-64-hex value)."),
  })
  .strict();
export type EndUserGetInput = z.infer<typeof endUserGetArgs>;

export const endUserGet: CommandHandler<EndUserGetInput> = async (ctx, input) => {
  const data = await ctx.client.request({
    operationId: "end_user.get",
    params: { pid: requireProject(ctx), user_hash: input["user-hash"] },
  });
  return { data };
};
