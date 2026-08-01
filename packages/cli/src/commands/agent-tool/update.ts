// `agent-tool update <tool> --agent <agent> [--description --parameter-schema --enabled]` args +
// plan-change builder (T-218; agents:write, danger PR). Plan-kind over the executable `tool:update`
// CHANGE_TABLE entry (the wire route is plan_required — the only legal write path). The arg surface
// is `.strict()` with EXACTLY the three `tool_update_request` properties (management-resources
// .schema.json:142 — all optional, minProperties:1) as flags. There is deliberately NO `--tool-name`
// flag (R13 / FORBIDDEN 9: tool_name is IMMUTABLE — the natural key; `--tool-name anything` fails the
// strict zod parse client-side, ZERO wire calls). `--parameter-schema`, when present, is validated
// CLIENT-SIDE before any wire call (R3). The builder is ASYNC: it resolves the `--agent` slug-or-UUID
// to a profile id and the `<tool>` name-or-UUID to a tool id (D-7) BEFORE building the concrete path.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveAgentId, resolveToolId } from "../agent/resolve";
import { boolFlagArg, toBool, parseJsonObjectFlag } from "../agent/args-common";
import { assertToolParameterSchema } from "../agent/tool-schema";

export const agentToolUpdateArgs = z
  .object({
    tool: z.string().min(1).describe("The tool name or id to update."),
    agent: z.string().min(1).describe("The parent agent profile (slug or id)."),
    description: z.string().min(1).optional().describe("What the tool does."),
    "parameter-schema": z.string().optional().describe("The tool's JSON-Schema parameter object (a JSON object)."),
    enabled: boolFlagArg.optional().describe("Whether the tool is active."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict()
  .superRefine((val, refCtx) => {
    // minProperties:1 mirror — at least one of {description, parameter_schema, enabled}.
    if (val.description === undefined && val["parameter-schema"] === undefined && val.enabled === undefined) {
      refCtx.addIssue({
        code: "custom",
        message: "nothing to update — pass at least one of --description, --parameter-schema, --enabled",
      });
    }
  });
export type AgentToolUpdateInput = z.infer<typeof agentToolUpdateArgs>;

/** The PURE change builder (`PlanMutation.changes`, ASYNC). Resolves profile + tool ids, validates a
 *  present parameter_schema (value-free failure), then emits ONLY the present members of `tool:update`. */
export async function agentToolUpdateChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = agentToolUpdateArgs.parse(input);

  // LOCAL validation FIRST — the R3 gate promises a mis-shaped/over-cap schema costs ZERO wire
  // calls. Resolving first would spend TWO requests (`profile.list` + `tool.list`) before
  // rejecting input we can reject offline. Order: parse → build+validate body → resolve ids.
  const body: Record<string, unknown> = {};
  if (parsed.description !== undefined) body.description = parsed.description;
  if (parsed["parameter-schema"] !== undefined) {
    const parameterSchema = parseJsonObjectFlag(parsed["parameter-schema"], "--parameter-schema");
    assertToolParameterSchema(parameterSchema, "--parameter-schema");
    body.parameter_schema = parameterSchema;
  }
  if (parsed.enabled !== undefined) body.enabled = toBool(parsed.enabled);

  const pid = requireProject(ctx);
  const profileId = await resolveAgentId(ctx, parsed.agent);
  const toolId = await resolveToolId(ctx, profileId, parsed.tool);

  return [
    {
      action: "update",
      resource: "tool",
      path: renderRoutePath("tool.update", { pid, id: profileId, tool_id: toolId }),
      body,
    },
  ];
}
