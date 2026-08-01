// `media-job` noun (T-214 L2-CLI-16, CLI-31 NEW-SURFACE gated on the D1 routes existing).
// Ships list + get at v1 (both media_job.* routes are implemented on the wire). The noun is
// a MIXED one: list/get are visible here, while `media-job cancel` stays REGISTERED-RESERVED
// (commands/reserved/media.ts — no-contract, jobs:write, D) and never enters this file, so a
// default build surfaces `agkit media-job <list|get>` with cancel byte-absent (ACCEPTANCE 2).
// Both are jobs:read SR remote reads.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { mediaJobList, mediaJobListArgs } from "./list";
import { mediaJobGet, mediaJobGetArgs } from "./get";

export const mediaJobCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "media-job",
    verb: "list",
    summary: "List the project's media jobs (paginated).",
    args: mediaJobListArgs,
    scopes: ["jobs:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-job", "list"),
    examples: ["agkit media-job list", "agkit media-job list --status completed --limit 50"],
    handler: mediaJobList,
    execution: "remote",
  }),
  defineCommand({
    noun: "media-job",
    verb: "get",
    summary: "Show one media job.",
    args: mediaJobGetArgs,
    scopes: ["jobs:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-job", "get"),
    examples: ["agkit media-job get --id mj_123"],
    handler: mediaJobGet,
    execution: "remote",
  }),
];
