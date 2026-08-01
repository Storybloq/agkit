// `usage` noun (T-214 L2-CLI-16, A-register usage.series/requests/top_users). A multi-verb
// read-only noun surfaced as `agkit usage <series|requests|top-users>` (NOT bare — it has
// more than one visible command, and none of its verbs is in READ_VERBS). All three are
// usage:read SR remote reads: `commandConsumesCredential` fires from the scope, so the shell
// resolves the credential + threads the {pid} bridge automatically — no ceremony, no --yes.
// Flag names bind from the WIRE (D-2): the days/dimension/top-N-limit knobs are the server
// allow-list (router.ts EXTRA_QUERY_PARAMS), NOT contract query bytes; the paginated
// `requests` route carries the frozen 50/200 --limit/--cursor.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { usageSeries, usageSeriesArgs } from "./series";
import { usageRequests, usageRequestsArgs } from "./requests";
import { usageTopUsers, usageTopUsersArgs } from "./top-users";

export const usageCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "usage",
    verb: "series",
    summary: "Show the usage time-series for the project.",
    args: usageSeriesArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("usage", "series"),
    examples: ["agkit usage series", "agkit usage series --days 30 --dimension execution_target"],
    handler: usageSeries,
    execution: "remote",
  }),
  defineCommand({
    noun: "usage",
    verb: "requests",
    summary: "List the request log for the project (paginated).",
    args: usageRequestsArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("usage", "requests"),
    examples: ["agkit usage requests", "agkit usage requests --limit 50"],
    handler: usageRequests,
    execution: "remote",
  }),
  defineCommand({
    noun: "usage",
    verb: "top-users",
    summary: "Show the top-N end-users by usage for the project.",
    args: usageTopUsersArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("usage", "top-users"),
    examples: ["agkit usage top-users", "agkit usage top-users --limit 10"],
    handler: usageTopUsers,
    execution: "remote",
  }),
];
