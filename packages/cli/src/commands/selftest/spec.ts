// The `selftest` noun (T-222, canonical L2-CLI-20). One BARE command: `agkit selftest` — the
// end-to-end diagnostic. It is danger M (its write probe performs real `plan.create`/`plan.discard`
// M-class writes — SR would be label-by-reality dishonest) and joins `NON_CEREMONY_REMOTE_MUTATIONS`
// (the probe IS the plan machinery's test, so a ceremony would be theater — the token-create
// rationale). `mcpExclude` keeps a live-write diagnostic out of the MCP tool projection.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { selftestRun, selftestRunArgs } from "./run";

export const selftestCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "selftest",
    verb: "run",
    bare: true, // `agkit selftest` — the ONLY visible command for the noun (load-check enforced)
    summary: "Run end-to-end diagnostics (runtime, keychain, server, read/write path, skill & MCP).",
    args: selftestRunArgs,
    scopes: [], // the probes authenticate through the resolved credential; the spec declares none
    danger: "M",
    outputSchemaId: outputSchemaId("selftest", "run"),
    examples: ["agkit selftest"],
    handler: selftestRun,
    execution: "remote", // it makes authenticated wire calls (auth/read/write probes)
    mcpExclude: "diagnostic aggregate performing a live write probe; not a resource tool",
  }),
];
