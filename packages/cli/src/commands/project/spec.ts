// `project` noun (N-011 A201–A205 → T-212 S7 plan-first retrofit). A multi-verb noun:
// the yargs generator surfaces it as `agkit project <list|create|archive>` (NOT a bare
// command, since it has more than one visible command). Exercises every generator branch:
//   - `list`    : SR read, an alias (`ls`) -> MCP `agkit_project_read`
//   - `create`  : M mutation, an interactive prompt -> MCP `agkit_project_plan{create}`
//   - `archive` : D destroy, typed-confirm wiring     -> MCP `agkit_project_plan{archive}`
// S7: `create`/`archive` declare `mutation: {kind:"plan"}` — the dispatch hook runs the
// FUSED plan.create→apply ceremony and the shared `planMutationHandler` applies the pass.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { projectList, projectListArgs } from "./list";
import { projectGet, projectGetArgs } from "./get";
import { projectSummary, projectSummaryArgs } from "./summary";
import { projectCreateArgs, projectCreateChanges } from "./create";
import { projectRenameArgs, projectRenameChanges } from "./rename";
import { projectArchiveArgs, projectArchiveChanges } from "./archive";
import { planMutationHandler } from "../plan/apply";

export const projectCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "project",
    verb: "list",
    aliases: ["ls"],
    summary: "List projects.",
    args: projectListArgs,
    scopes: ["projects:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("project", "list"),
    examples: ["agkit project list", "agkit project list --limit 50"],
    handler: projectList,
    // T-210: LIVE remote command — baseline v1.1.0 surface, no capability gate
    // (execution:"remote" + no requiredCapabilities ⇒ the version_skew gate passes it).
    execution: "remote",
  }),
  // T-216 R1: SR read with the OPTIONAL-MODE positional (S3) — `agkit project get proj_123` names
  // a project; bare `agkit project get` falls back to the ambient effective project. BOTH forms are
  // examples (each passes the registry example loop — optional mode is zero-or-one cardinality).
  defineCommand({
    noun: "project",
    verb: "get",
    summary: "Show a project (defaults to the effective project).",
    args: projectGetArgs,
    scopes: ["projects:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("project", "get"),
    examples: ["agkit project get proj_123", "agkit project get"],
    handler: projectGet,
    positional: { key: "id", name: "project-id", optional: true },
    execution: "remote",
  }),
  // T-299 R1: the project-summary read (`project.summary`) — the last of the 4 UNSURFACED_OPS on
  // this plane. Same OPTIONAL-MODE positional as `get`; it folds into the EXISTING
  // `agkit_project_read` as a third verb rather than minting a tool.
  defineCommand({
    noun: "project",
    verb: "summary",
    summary: "Show a project's resource summary (defaults to the effective project).",
    args: projectSummaryArgs,
    scopes: ["projects:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("project", "summary"),
    examples: ["agkit project summary", "agkit project summary proj_123"],
    handler: projectSummary,
    positional: { key: "id", name: "project-id", optional: true },
    execution: "remote",
  }),
  defineCommand({
    noun: "project",
    verb: "create",
    summary: "Create a project.",
    args: projectCreateArgs,
    scopes: ["projects:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("project", "create"),
    examples: ["agkit project create --name Acme"],
    handler: planMutationHandler,
    prompts: [{ name: "name", message: "Project name", flagEquivalent: "--name" }],
    mutation: { kind: "plan", changes: projectCreateChanges },
    execution: "remote",
  }),
  // T-216 R2: M plan-kind rename over the executable `project:update` entry (D2 ratified plan
  // door; R18 pins the key→operationId→executable→defName binding through resolveChange).
  defineCommand({
    noun: "project",
    verb: "rename",
    summary: "Rename a project.",
    args: projectRenameArgs,
    scopes: ["projects:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("project", "rename"),
    examples: ["agkit project rename proj_123 --name NewName"],
    handler: planMutationHandler,
    mutation: { kind: "plan", changes: projectRenameChanges },
    positional: { key: "id", name: "project-id" },
    execution: "remote",
  }),
  defineCommand({
    noun: "project",
    verb: "archive",
    summary: "Archive a project (bricks its apps — destructive).",
    args: projectArchiveArgs,
    scopes: ["projects:destroy"],
    danger: "D",
    outputSchemaId: outputSchemaId("project", "archive"),
    // T-216 R17: MIGRATED to the ticket's positional grammar (`--id` still parses for scripts,
    // but help/hints/examples never teach it — F-G2 note; flag+positional together is the R20
    // dual-source usage_error).
    examples: ["agkit project archive proj_123"],
    handler: planMutationHandler,
    // S7: the typed value is the PLAN's confirm_string (shown by the ceremony), no
    // longer the project name — the plan is the displayed authority (L-010).
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: projectArchiveChanges },
    positional: { key: "id", name: "project-id" },
    execution: "remote",
  }),
];
