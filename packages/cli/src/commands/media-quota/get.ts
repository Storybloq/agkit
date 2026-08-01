// `media-quota get` handler (T-220; quotas:read, SR — D6: only the upsert is PR). The read DTO
// is the project-singleton CLOSED shape; an absent row is a row-honest 404 (D13), taught with
// the next command — never a fabricated zero-shape.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { WireProblemError } from "../../core/errors";

export const mediaQuotaGetArgs = z.object({}).strict();
export type MediaQuotaGetInput = z.infer<typeof mediaQuotaGetArgs>;

/** Module constant (D13): the honest not-configured teaching. */
export const MEDIA_QUOTA_GET_404_HINT =
  "no media quotas are configured for this project — set them with `agkit media-quota set`";

export const mediaQuotaGet: CommandHandler<MediaQuotaGetInput> = async (ctx) => {
  const pid = requireProject(ctx);
  try {
    const resp = await ctx.client.request({ operationId: "media_quotas.get", params: { pid } });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = MEDIA_QUOTA_GET_404_HINT;
    }
    throw err;
  }
};
