// The `setup` noun (T-224, canonical L2-CLI-18). One BARE command: `agkit setup` — the LOCAL
// provisioning command that installs the skill tree, registers this CLI as an MCP server with the
// developer's clients, and splices the agent block into the project's AGENTS.md.
//
// Registry posture, and why each piece is what it is:
//   • danger M — it MUTATES the developer's machine (files under `~/.claude`, the project's
//     AGENTS.md, optionally `~/.codex/config.toml`). SR would be a lie. NOT D: every leg is
//     idempotent and byte-surgical, nothing is destroyed, and a re-run converges — the same
//     argument `config set` / `secret-source add` make for a local M.
//   • `execution: "local"`, `scopes: []` — it sends NO management operation, so it consumes no
//     credential, needs no URL guard, and claims no contract op (the bijection domain is
//     untouched). It is therefore exempt from the remote-mutation ceremony invariant by
//     construction and must NOT join `NON_CEREMONY_REMOTE_MUTATIONS` (that allowlist's teeth
//     require `execution:"remote"` and would throw at LOAD).
//   • `bare: true` — `agkit setup` is the whole surface. `--check` is a FLAG, deliberately not a
//     `setup check` verb: a second visible verb would break the bare rule, and `check` is not in
//     the closed verb vocabulary.
//   • `mcpExclude` — see SETUP_MCP_EXCLUDE below. This is the one command an MCP host must never
//     be able to call: it rewrites the host's OWN client wiring.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { setupRunArgs } from "./args";
import { setupRun } from "./run";

/**
 * The exclusion REASON, exported beside the spec it protects (the `SECRET_SOURCE_MCP_EXCLUDE`
 * precedent — the rationale travels with the code that depends on it, and the golden's `reason`
 * field is this string verbatim).
 *
 * The security property: `setup` writes the very files an MCP host reads to decide which servers
 * it launches. A host that could invoke it as a TOOL could rewrite its own server table, its own
 * pre-approval list, and the repo's agent instructions — a privilege-escalation door with no
 * human in it. Excluding it costs an agent nothing: provisioning a workstation is a human act.
 */
export const SETUP_MCP_EXCLUDE =
  "local environment provisioning: writes ~/.claude/skills, the project's AGENTS.md and ~/.codex/config.toml — an MCP host must never rewrite its own client wiring; not an MCP tool";

export const setupCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "setup",
    verb: "run",
    bare: true, // `agkit setup` — the ONLY visible command for the noun (load-check enforced)
    summary:
      "Provision this machine for agents: install the agkit skill, register the MCP server, and add the agkit block to AGENTS.md.",
    args: setupRunArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("setup", "run"),
    // reference.md renders NO flag descriptions — the example fence is the ONLY place `--check`
    // and `--client` reach the shipped skill docs, so both appear here deliberately.
    examples: ["agkit setup", "agkit setup --check", "agkit setup --client codex"],
    handler: setupRun,
    execution: "local",
    mcpExclude: SETUP_MCP_EXCLUDE,
  }),
];
