// `quota get` handler (T-219; N-011 C10, quotas:read, SR). A plain read over `quotas.get`
// (project-singleton — no id, no pagination). The read DTO carries the six config members PLUS the
// read-only usage members (`tokens_used`, `spend_usd`) — rendered verbatim; only the WRITE path
// (merge.ts) strips usage. An absent row is the server's honest 404 ("null ⇒ not_found",
// quotas-deps.ts) — the CLI never fabricates an empty-quota body (FORBIDDEN 6); the wire error
// surfaces unchanged with a teachable hint (D-8 / §2 S-E).
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { WireProblemError } from "../../core/errors";

export const quotaGetArgs = z.object({}).strict();
export type QuotaGetInput = z.infer<typeof quotaGetArgs>;

/** Module constant (A2/R13a: hints this plane authors are STATIC — referential identity testable). */
export const QUOTA_GET_404_HINT =
  "no quotas are configured for this project — caps are unset; configure with `agkit quota set`";

export const quotaGet: CommandHandler<QuotaGetInput> = async (ctx) => {
  const pid = requireProject(ctx);
  try {
    const resp = await ctx.client.request({ operationId: "quotas.get", params: { pid } });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = QUOTA_GET_404_HINT;
    }
    throw err;
  }
};
