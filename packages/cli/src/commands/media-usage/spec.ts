// `media-usage` noun (T-214 L2-CLI-16, media_usage.summary/costs/requests). A multi-verb
// read-only noun surfaced as `agkit media-usage <summary|costs|requests>`. All usage:read
// SR remote reads. `--days` on summary/costs is a server-grounded addition beyond the ticket
// prose (DEV-10, server allow-list); `requests` carries the frozen 50/200 --limit/--cursor.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { mediaUsageSummary, mediaUsageSummaryArgs } from "./summary";
import { mediaUsageCosts, mediaUsageCostsArgs } from "./costs";
import { mediaUsageRequests, mediaUsageRequestsArgs } from "./requests";

export const mediaUsageCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "media-usage",
    verb: "summary",
    summary: "Show the media-usage summary for the project.",
    args: mediaUsageSummaryArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-usage", "summary"),
    examples: ["agkit media-usage summary", "agkit media-usage summary --days 7"],
    handler: mediaUsageSummary,
    execution: "remote",
  }),
  defineCommand({
    noun: "media-usage",
    verb: "costs",
    summary: "Show media-usage costs for the project.",
    args: mediaUsageCostsArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-usage", "costs"),
    examples: ["agkit media-usage costs", "agkit media-usage costs --days 7"],
    handler: mediaUsageCosts,
    execution: "remote",
  }),
  defineCommand({
    noun: "media-usage",
    verb: "requests",
    summary: "List the media request log for the project (paginated).",
    args: mediaUsageRequestsArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("media-usage", "requests"),
    examples: ["agkit media-usage requests", "agkit media-usage requests --limit 50"],
    handler: mediaUsageRequests,
    execution: "remote",
  }),
];
