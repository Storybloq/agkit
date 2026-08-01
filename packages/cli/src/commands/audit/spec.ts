// `audit` noun (T-214 L2-CLI-16, audit.list). A SINGLETON read noun: its one visible command
// is `list`, so the yargs shell surfaces it BARE as `agkit audit` (DEV-4 — the landed
// singleton-read rule, version/whoami/status precedent; the registry tuple stays (audit,list)).
// The reference/help render the bare path via the shared effective-command-path helper (C-6).
// audit:read SR remote. Filters: --since/--until/--action/--actor (wire filters) + the global
// --project (explicit-only project_id filter, C-2/D-6) + --limit/--cursor/--paginate.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { auditList, auditListArgs } from "./list";

export const auditCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "audit",
    verb: "list",
    summary: "List the account audit log (de-clamped keyset pagination; --project filters to one project).",
    args: auditListArgs,
    scopes: ["audit:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("audit", "list"),
    examples: ["agkit audit", "agkit audit --since 2026-07-01 --action project.create"],
    handler: auditList,
    execution: "remote",
  }),
];
