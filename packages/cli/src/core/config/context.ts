// THE precedence resolver (T-208, deliverable 2). ONE documented chain, applied
// per context value, returning each effective value TOGETHER WITH ITS SOURCE so
// `status` (and agents) never have to guess where a value came from:
//
//   flags (--profile/--project)
//     > env (AGKIT_PROFILE / AGKIT_PROJECT / AGKIT_API_URL)
//       > repo .agentkit/project.json
//         > active profile defaults (config.profiles[<active>])
//           > global config.json settings
//             > built-ins
//
// The `source` a value reports is the layer it was drawn from. Six labels realize
// the chain: `flag | env | repo | profile | config | builtin`. `profile` = the
// ACTIVE profile's own stored defaults; `config` = a global config.json setting —
// splitting the ticket's "active profile defaults" layer so a per-profile default
// (which beats a global default) is attributable distinctly. Pure over its inputs.
import { readEnvApiUrl, readEnvProfile, readEnvProject } from "../auth/env";
import { DEFAULT_API_URL } from "./dirs";
import type { ConfigData } from "./schema";
import type { RepoProject } from "./repo-project";

/** WHERE an effective context value came from (the precedence layer). */
export type ContextSource = "flag" | "env" | "repo" | "profile" | "config" | "builtin";

/** An effective value paired with the layer it was drawn from. */
export interface Resolved<T> {
  readonly value: T;
  readonly source: ContextSource;
}

/** One candidate layer for a value; `value` absent/empty means "this layer has nothing". */
interface Layer<T> {
  readonly source: ContextSource;
  readonly value: T | null | undefined;
}

/** Is this layer's value usable (present, non-null, non-empty-string)? */
function present<T>(value: T | null | undefined): value is T {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim().length === 0) return false;
  return true;
}

/** First usable layer wins, carrying its source; else the built-in default (source `builtin`). */
function pick<T>(layers: readonly Layer<T>[], builtin: T): Resolved<T> {
  for (const layer of layers) {
    if (present(layer.value)) return { value: layer.value, source: layer.source };
  }
  return { value: builtin, source: "builtin" };
}

/** The overrides carried by the global `--profile` / `--project` flags. */
export interface ContextFlags {
  readonly profile?: string;
  readonly project?: string;
}

/** Everything the resolver reads (all injected — no `process` access). */
export interface ContextInputs {
  readonly flags: ContextFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly repo: RepoProject | null;
  readonly config: ConfigData;
}

/** The three effective context values, each with its source. */
export interface ResolvedContext {
  readonly profile: Resolved<string>;
  readonly project: Resolved<string | null>;
  readonly apiUrl: Resolved<string>;
}

/**
 * Resolve profile, project, and api_url through the ONE precedence chain. Profile
 * is resolved FIRST because the project + api_url "active profile defaults" layer
 * reads `config.profiles[<active-profile>]`.
 */
export function resolveContext(inputs: ContextInputs): ResolvedContext {
  const { flags, env, repo, config } = inputs;

  const profile = pick<string>(
    [
      { source: "flag", value: flags.profile },
      { source: "env", value: readEnvProfile(env) },
      { source: "repo", value: repo?.profile },
      { source: "config", value: config.default_profile },
    ],
    "default",
  );

  const activeDefaults = config.profiles?.[profile.value];

  const project = pick<string | null>(
    [
      { source: "flag", value: flags.project },
      { source: "env", value: readEnvProject(env) },
      { source: "repo", value: repo?.projectId },
      { source: "profile", value: activeDefaults?.project },
    ],
    null,
  );

  const apiUrl = pick<string>(
    [
      { source: "env", value: readEnvApiUrl(env) },
      { source: "profile", value: activeDefaults?.api_url },
      { source: "config", value: config.api_url },
    ],
    DEFAULT_API_URL,
  );

  return { profile, project, apiUrl };
}
