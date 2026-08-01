// `api get <path>` — the raw-door SAFE READ (SR, T-222 step 10c). No ceremony, no body; the query
// rides inline in `<path>`. `--input`/`--field` are refused by `.strict()` (a GET carries no body),
// so `agkit api get … --field …` is a usage_error — the acceptance-required GET+`--field` refusal.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { mapRawResult, requireRawDoor } from "./shared";

export const apiGetArgs = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Absolute management path, e.g. /v1/management/audit?limit=50 (query rides inline)."),
  })
  .strict();
export type ApiGetInput = z.infer<typeof apiGetArgs>;

export const apiGet: CommandHandler<ApiGetInput> = async (ctx, input) => {
  const raw = requireRawDoor(ctx);
  const result = await raw({ method: "GET", path: input.path });
  return mapRawResult(result);
};
