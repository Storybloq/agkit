// `config get --key <key>` (T-208, deliverable 3). Reads ONE registered config key.
// An unknown key -> `usage_error` (exit 2) + the valid-key list (requireConfigKey).
// Like every command in this CLI it is flag-first (the shell tokenizes `--flags`
// only), so the ticket's `<key>` is realized as `--key` — matching project/issuer/etc.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { loadConfig, requireConfigKey } from "../../core/config";

export const configGetArgs = z.object({ key: z.string().describe("The config key to read.") }).strict();
export type ConfigGetInput = z.infer<typeof configGetArgs>;

export const configGet: CommandHandler<ConfigGetInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const spec = requireConfigKey(input.key); // unknown key -> usage_error (exit 2) + valid keys
  const { config } = loadConfig({ env: rt.env, homeDir: rt.homeDir });
  const value = spec.get(config);
  return { data: { key: spec.key, value: value ?? null, set: value !== undefined } };
};
