// `config list` (T-208, deliverable 3). Lists the CLOSED set of user-settable keys
// with their current value (null = unset -> the built-in default applies) and a
// one-line description. An array of rows renders as an aligned table (human) / TSV
// (piped) / JSON array (`--json`) through the serializer chokepoint.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { loadConfig, CONFIG_KEYS } from "../../core/config";

export const configListArgs = z.object({}).strict();
export type ConfigListInput = z.infer<typeof configListArgs>;

export const configList: CommandHandler<ConfigListInput> = async (ctx, _input) => {
  const rt = requireRuntime(ctx);
  const { config } = loadConfig({ env: rt.env, homeDir: rt.homeDir });
  const rows = CONFIG_KEYS.map((spec) => {
    const value = spec.get(config);
    return { key: spec.key, value: value ?? null, set: value !== undefined, description: spec.describe };
  });
  return { data: rows };
};
