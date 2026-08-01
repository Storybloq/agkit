// The `upgrade` noun (T-222, canonical L2-CLI-20). One BARE command: `agkit upgrade` — an
// evidence-based self-update. Danger M (it can MUTATE the local install via `npm install -g`), but
// `execution:"local"` (no wire call — invariant (i)'s remote-mutation binding rule does not apply)
// and it carries NO `mutation` binding (there is no server plan for a local install). `mcpExclude`
// keeps a self-mutating command out of the agent tool surface.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { upgradeRun, upgradeRunArgs } from "./run";

export const upgradeCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "upgrade",
    verb: "run",
    bare: true, // `agkit upgrade` — the ONLY visible command for the noun (load-check enforced)
    summary: "Update agkit to the latest release (npm-global installs only; others print the command).",
    args: upgradeRunArgs,
    scopes: [],
    danger: "M", // it can mutate the local install (npm install -g)
    outputSchemaId: outputSchemaId("upgrade", "run"),
    examples: ["agkit upgrade"],
    handler: upgradeRun,
    execution: "local", // no wire call — a local package operation
    mcpExclude: "mutates the local install; never an agent tool",
  }),
];
