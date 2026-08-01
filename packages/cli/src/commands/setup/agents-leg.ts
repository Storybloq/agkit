// T-224 leg 3 — the PROJECT's `AGENTS.md` (D5 / D5v2 / D-markers-v2).
//
// TARGET: `<cwd>/AGENTS.md`. `setup` provisions the environment the developer runs it in, and
// AGENTS.md is the Codex-convention file that environment's agents read.
//
// CONTAINMENT IS THE BOUNDARY, NOT THE BASENAME (D5v2). `AGENTS.md -> CLAUDE.md` inside the repo
// is a real and common shape, so the leaf link is FOLLOWED — but the resolved target must stay
// inside `realpath(cwd)`. A repo shipping `AGENTS.md -> ~/.bashrc` gets an honest refusal, and it
// gets it from a containment rule rather than from an allowlist of names (a basename is not a
// boundary: `~/evil/AGENTS.md` wears an allowed one).
//
// ONE PARSER DRIVES BOTH ARMS. `--check` renders `spliceAgentsMd(current, snippet)` and compares
// it to the current bytes; apply writes that same string. There is no second "would it change?"
// implementation, so a dry run cannot disagree with the write it predicts.
import { join } from "node:path";
import { CliLocalError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";
import { AgentsMarkerError, agentsSnippet, spliceAgentsMd } from "./agents-md";
import { leg, SETUP_CONFIG_MAX_BYTES, type SetupDeps, type SetupLeg } from "./legs";

const NAME = "agents_md";
const PATH_MAX = 200;
export const AGENTS_FILE = "AGENTS.md";

export async function agentsMdLeg(deps: SetupDeps): Promise<SetupLeg> {
  const path = join(deps.cwd, AGENTS_FILE);
  const shown = displayCapped(path, PATH_MAX);
  // `within: cwd` — the seam realizes it (deepest-existing-ancestor + realpath) itself, so a
  // symlinked checkout is unmasked without this module ever touching node:fs.
  const within = deps.cwd;
  const io = { within, maxBytes: SETUP_CONFIG_MAX_BYTES };

  try {
    const read = await deps.follow.readTextFileFollowing(path, io);
    const current = read.status === "present" ? read.text : null;
    const desired = spliceAgentsMd(current, agentsSnippet());
    const facts = { path, resolved_path: read.resolvedPath };

    if (current === desired) {
      return leg(NAME, "current", `${shown}: the agkit block is present and current`, facts);
    }
    if (deps.check) {
      return leg(
        NAME,
        "would_change",
        current === null ? `${shown}: does not exist` : `${shown}: the agkit block is missing or out of date`,
        facts,
      );
    }

    // The write publishes ONLY over the exact bytes the read above observed (D-bind-v5): the
    // seam re-resolves the link and re-reads the target immediately before renaming, and refuses
    // if either moved. An absent file takes the no-replace `link()` arm (D-create-v5/v6).
    const written = await deps.follow.writeTextFileFollowing(path, desired, {
      ...io,
      expected: {
        resolvedPath: read.resolvedPath,
        identity: read.status === "present" ? read.identity : null,
      },
    });
    // BYTES OVER CLAIMS: a returned write result is a claim. Re-read and compare.
    const verified = await deps.follow.verifyFollowedWrite(path, desired, io);
    if (!verified.ok) {
      return leg(NAME, "refused", `${shown}: ${verified.detail}`, facts);
    }
    return leg(NAME, "done", `${shown}: the agkit block was written`, {
      ...facts,
      resolved_path: written.resolvedPath,
      ...(written.cleanupWarning !== undefined ? { cleanup_warning: written.cleanupWarning } : {}),
    });
  } catch (err) {
    return refusal(err, shown, path);
  }
}

/**
 * The two refusal classes this leg can raise, each turned into a leg record rather than an exit:
 * a malformed marker pair (we will not guess which region is ours) and an fs-seam refusal — a
 * link resolving outside the repo, an oversized or non-regular target, a target that changed
 * under us. Every one of them wrote NOTHING; anything else rethrows.
 */
function refusal(err: unknown, shown: string, path: string): SetupLeg {
  if (err instanceof AgentsMarkerError) {
    return leg(NAME, "refused", `${shown}: ${err.message} — resolve the markers by hand`, {
      path,
      reason: err.reason,
    });
  }
  if (err instanceof CliLocalError) {
    return leg(NAME, "refused", err.detail ?? `${shown}: could not be reconciled`, { path });
  }
  throw err;
}
