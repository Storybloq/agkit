// The `init` noun (T-221, canonical L2-CLI-21). One BARE command: `agkit init` — the onboarding
// ORCHESTRATOR that takes a developer from a checkout to a project with a key, a credential and
// bound default routes, plus the repo files the SDK reads.
//
// Registry posture, and why each piece is what it is:
//   • danger M — it MUTATES (a project, a key, a credential, routes). Its highest-danger step is a
//     PR plan, but the SPEC's danger is a FLOOR (RC-10): each leg floors against its own plan's
//     server-computed danger at run time, and a PR plan still gets its own typed confirm. Declaring
//     PR here would instead demand a spec-level `confirm` challenge for a command whose confirm
//     value is a per-plan server string that does not exist until mid-run.
//   • NO `mutation` binding, and membership in `NON_CEREMONY_REMOTE_MUTATIONS` — the dispatch hook
//     resolves exactly ONE plan before the handler runs, which cannot express an orchestrator that
//     runs a plan, mints, writes files, then runs a second plan. The ceremonies run INSIDE the
//     handler over the SAME `core/plan` spine (`assertPlanApplyable` / `maxDanger` / `narrowPlan` /
//     `renderPlan`), so no confirmation model is weakened — see commands/init/plan-leg.ts.
//   • `--yes` reaches it through the NAMED `YES_CAPABLE_ORCHESTRATORS` allowlist (build-cli), the
//     one carve-out from the "ceremony flags need a mutation binding" rule; `--plan-only` stays a
//     usage_error (an orchestrator has no single plan to emit).
//   • `mcpExclude` — init prompts, writes repo files, and discloses a shown-once secret. None of
//     that belongs in an agent tool projection.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { initRun, initRunArgs } from "./run";

export const initCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "init",
    verb: "run",
    bare: true, // `agkit init` — the ONLY visible command for the noun (load-check enforced)
    summary: "Set up a project end to end: project, publishable key, provider credential, default routes, repo files.",
    args: initRunArgs,
    scopes: ["projects:write", "keys:write", "provider-keys:write", "routes:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("init", "run"),
    // NOTE: an example may carry only THIS spec's own args — `exampleInput` parses it against
    // `args`, and the ceremony/client globals (`--yes`, `--project`) are stripped at dispatch, not
    // here. So the scripted form is documented in the flag descriptions, not as an example.
    examples: ["agkit init", "agkit init --project-name my-app --key-name my-app"],
    handler: initRun,
    execution: "remote",
    mcpExclude: "interactive onboarding orchestrator: it prompts, writes repo files, and discloses a shown-once key",
  }),
];
