// Repo-local project binding discovery (T-208, deliverable 1 + 2). A repo commits
// `.agentkit/project.json` = `{ projectId?, profile? }` — NON-secret, checked into
// the user's repo so a checkout carries its project/profile intent. We discover it
// by walking UP from cwd to the filesystem root, stopping at the FIRST hit (the
// nearest enclosing repo wins — like git/.gitignore resolution).
//
// It is a precedence LAYER (between env and the active profile's defaults), so it
// never holds secrets: `.strict()` rejects a stray `token`, and a bad file fails
// LOUD (ConfigError, usage_error) rather than silently mis-binding the project.
import { readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors";

/** The committed repo binding. NON-secret: project id + which profile to use. */
export const repoProjectSchema = z
  .object({
    projectId: z.string().max(256).optional(),
    profile: z.string().max(256).optional(),
  })
  .strict();
export type RepoProject = z.infer<typeof repoProjectSchema>;

/** What discovery returns: the parsed binding + the file it came from. */
export interface DiscoveredRepoProject {
  readonly project: RepoProject;
  readonly path: string;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

/**
 * Walk UP from `cwd` looking for `.agentkit/project.json`; return the first hit's
 * parsed binding (or null if none up to the root). A present-but-malformed file
 * (bad JSON, unknown/secret key) throws `ConfigError` — a committed binding that is
 * wrong should be loud, not silently skipped.
 */
export function discoverRepoProject(cwd: string): DiscoveredRepoProject | null {
  let dir = cwd;
  const { root } = parsePath(cwd);
  // Bound the loop by the path depth (defensive against a pathological cwd).
  for (let guard = 0; guard < 4096; guard++) {
    const file = join(dir, ".agentkit", "project.json");
    let text: string | null = null;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (errCode(err) !== "ENOENT" && errCode(err) !== "ENOTDIR") throw err;
    }
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConfigError(`${file} is not valid JSON`);
      }
      if (parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed as object, "token")) {
        throw new ConfigError(
          `${file} contains a forbidden 'token' key — the repo project binding is committed and NON-secret`,
        );
      }
      const result = repoProjectSchema.safeParse(parsed);
      if (!result.success) {
        throw new ConfigError(`${file} is not a valid .agentkit/project.json (expected { projectId?, profile? })`);
      }
      return { project: result.data, path: file };
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the top (defensive)
    dir = parent;
  }
  return null;
}
