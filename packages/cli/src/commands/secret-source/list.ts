// `agkit secret-source list` (T-227 S5b) — the ACTIVE profile's declared indirect secret sources.
//
// DECLARATIONS ONLY. This command reads `config.json` and nothing else: it never reads an env var,
// never opens a declared file, and never reports whether one currently resolves. That is not a
// missing feature — a "does it resolve?" probe would turn a safe read into an oracle over the
// operator's environment and filesystem, and the resolution ladder's own refusals (which run at the
// moment a secret is actually needed) are the honest place for that answer.
import { z } from "zod";
import { type CommandHandler } from "../types";
import { activeSecretSourceProfile, configFilePath, declaredSecretSourcesFromConfig, loadConfig } from "../../core/config";
import { secretSourceDeps, viewSecretSources } from "./store";

export const secretSourceListArgs = z.object({}).strict();
export type SecretSourceListInput = z.infer<typeof secretSourceListArgs>;

export const secretSourceList: CommandHandler<SecretSourceListInput> = async (ctx) => {
  const deps = secretSourceDeps(ctx);
  // ONE config read, shared by the profile resolution and the lookup (S8 relay fold: the sources
  // come FROM this snapshot — a second load could pair this snapshot's profile with a concurrent
  // writer's sources). An absent config file is the empty allowlist (which refuses every indirect
  // reference over MCP), never an error.
  const { config } = loadConfig(deps);
  const profile = activeSecretSourceProfile(deps, config);
  const sources = declaredSecretSourcesFromConfig(config, profile);
  return {
    data: {
      profile,
      count: sources.length,
      sources: viewSecretSources(sources),
      config_path: configFilePath(deps),
    },
  };
};
