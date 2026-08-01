// `config unset --key <key>` (T-208, deliverable 3). Removes ONE registered key,
// reverting it to its built-in default. An unknown key -> usage_error (exit 2) + the
// valid-key list (requireConfigKey) — an unknown key is NEVER silently ignored.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { loadConfig, saveConfig, requireConfigKey } from "../../core/config";

export const configUnsetArgs = z.object({ key: z.string().describe("The config key to remove.") }).strict();
export type ConfigUnsetInput = z.infer<typeof configUnsetArgs>;

export const configUnset: CommandHandler<ConfigUnsetInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const spec = requireConfigKey(input.key); // unknown key -> usage_error (exit 2) + valid keys
  const deps = { env: rt.env, homeDir: rt.homeDir };
  const { config } = loadConfig(deps);
  const path = saveConfig(deps, spec.unset(config));
  return { data: { key: spec.key, unset: true, config_path: path } };
};
