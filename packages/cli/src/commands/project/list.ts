// `project list` handler (N-011 A201 / A203, projects:read). Pure: it delegates
// to the forward-declared ManagementClient (typed in T-211) and returns the rows
// as data. No process side effects.
//
// T-211 step 4 — pagination: `--paginate` (a global client flag, on `ctx.clientFlags`)
// drains EVERY page through the client seam (`drainList`, which maps the server list
// envelope → the CLI's `meta.next_cursor` and honors A8/A9/A10/A35). WITHOUT it, one page
// is fetched and mapped by `singlePageResult` — decision G: a truncated single page
// surfaces `meta.next_cursor` and so exits 3, while a complete page exits 0. `--limit` /
// `--cursor` stay PER-SPEC route args (plan decision F); `--paginate` is client-behavior.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { drainList, singlePageResult } from "../../core/client/paginate";

export const projectListArgs = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional().describe("Max rows to return."),
    cursor: z.string().optional().describe("Opaque pagination cursor."),
  })
  .strict();
export type ProjectListInput = z.infer<typeof projectListArgs>;

export const projectList: CommandHandler<ProjectListInput> = async (ctx, input) => {
  if (ctx.clientFlags?.paginate) {
    // Drain the whole list: each page rides the retry engine via the client seam.
    return drainList(ctx.client, "project.list", { ...input });
  }
  const page = await ctx.client.request({ operationId: "project.list", params: input });
  return singlePageResult(page);
};
