// `config set --key <key> --value <value>` (T-208, deliverable 3). Sets ONE
// registered key, validating the value per its type (bad value -> usage_error). An
// unknown key -> usage_error (exit 2) + valid keys. There is NO `token` key (schema),
// so a credential can never be written here (FORBIDDEN). `default_profile` is set via
// this key too — `profile use` is the friendlier alias that also ensures the entry.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { loadConfig, saveConfig, requireConfigKey, isDefaultApiUrl } from "../../core/config";

export const configSetArgs = z
  .object({
    key: z.string().describe("The config key to set."),
    value: z.string().describe("The new value (validated per the key's type)."),
  })
  .strict();
export type ConfigSetInput = z.infer<typeof configSetArgs>;

export const configSet: CommandHandler<ConfigSetInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const spec = requireConfigKey(input.key); // unknown key -> usage_error (exit 2) + valid keys
  const value = spec.parse(input.value); // invalid value -> usage_error
  const deps = { env: rt.env, homeDir: rt.homeDir };
  const { config } = loadConfig(deps);
  const path = saveConfig(deps, spec.set(config, value));

  const warnings: string[] = [];
  if (spec.key === "api_url" && typeof value === "string" && !isDefaultApiUrl(value)) {
    warnings.push(
      "this is a non-default API host — credential-consuming commands will ask you to confirm sending credentials to it (once, per profile).",
    );
  }
  return { data: { key: spec.key, value, set: true, config_path: path }, warnings };
};
