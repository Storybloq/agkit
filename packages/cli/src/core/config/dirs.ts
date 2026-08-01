// XDG / config-directory resolution (T-208, canonical L2-CLI-06, deliverable 1).
// ONE documented rule for WHERE the non-secret config + state live, over the
// injected env + home dir (mirrors T-206's insecure-file, which takes `homeDir`
// so a test drives a real temp dir):
//
//   config dir  = ${AGKIT_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/agentkit}
//   config file = <config-dir>/config.json      (NON-secrets only, mode 0644)
//   state dir   = <config-dir>/state/           (caches; never secrets)
//
// AGKIT_CONFIG_DIR names the agentkit config DIR itself (it REPLACES the whole
// `.../agentkit` path, per the ticket's `${AGKIT_CONFIG_DIR:-…}/config.json`), so
// a test points it at a mkdtemp dir and reads `<tmp>/config.json`. The credential
// STORE stays in T-206's `~/.agentkit/credentials.json` — deliberately separate:
// this dir holds only non-secrets, so a `token` here is a load-time error (schema.ts).
import { join } from "node:path";
import { readConfigDirEnv, readXdgConfigHome } from "../auth/env";

/**
 * The built-in default management base URL. §A/§C: prod is `api.agkit.cloud`. The
 * API-URL exfiltration guard (url-guard.ts) treats ANY other host as non-default,
 * so this constant is the single source for "is this the trusted default?".
 */
export const DEFAULT_API_URL = "https://api.agkit.cloud";

/** Seams the dir/file resolvers need: the process env + the OS home dir. */
export interface ConfigDirDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

/**
 * Resolve the agentkit config directory (deliverable 1). AGKIT_CONFIG_DIR wins
 * outright; otherwise `${XDG_CONFIG_HOME:-~/.config}/agentkit`. Pure over the
 * injected env + homeDir — no `process` access — so it is deterministically testable.
 */
export function resolveConfigDir(deps: ConfigDirDeps): string {
  const override = readConfigDirEnv(deps.env);
  if (override) return override;
  const xdg = readXdgConfigHome(deps.env);
  const base = xdg ?? join(deps.homeDir, ".config");
  return join(base, "agentkit");
}

/** `<config-dir>/config.json` — the NON-secret, schema-validated config file. */
export function configFilePath(deps: ConfigDirDeps): string {
  return join(resolveConfigDir(deps), "config.json");
}

/** `<config-dir>/state/` — caches (update-check stamp, skill freshness). Never secrets. */
export function stateDirPath(deps: ConfigDirDeps): string {
  return join(resolveConfigDir(deps), "state");
}
