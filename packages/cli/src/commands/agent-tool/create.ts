// `agent-tool create <name> --agent <agent> --description <d> --parameter-schema <json>` args +
// plan-change builder (T-218; agents:write, danger PR). Plan-kind over the executable `tool:create`
// CHANGE_TABLE entry (the wire route is plan_required — the only legal write path). The body is the
// frozen `tool_create_request` $def realized EXACTLY (management-resources.schema.json:131 — required
// {tool_name, description, parameter_schema}, additionalProperties:false). `parameter_schema` is a
// JSON object supplied inline (the F0 issuer-PEM precedent — no file seam for a single tool) and
// validated CLIENT-SIDE by the shared tool-schema validator BEFORE any wire call (Deliverable 2 /
// R3): an over-cap / mis-shaped schema is a value-free usage_error (exit 2, ZERO sends), never a
// server 400 on every invocation. The server's stored-schema caps stay the FINAL authority.
// The builder is ASYNC: it resolves the `--agent` slug-or-UUID to a profile id (ONE profile.list)
// BEFORE building the concrete path (D-7).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveAgentId } from "../agent/resolve";
import { parseJsonObjectFlag } from "../agent/args-common";
import { assertToolParameterSchema } from "../agent/tool-schema";

export const agentToolCreateArgs = z
  .object({
    name: z.string().min(1).describe("The tool's name (unique per profile; immutable once created)."),
    agent: z.string().min(1).describe("The parent agent profile (slug or id)."),
    description: z.string().describe("What the tool does (may be empty)."),
    "parameter-schema": z.string().describe("The tool's JSON-Schema parameter object (a JSON object)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type AgentToolCreateInput = z.infer<typeof agentToolCreateArgs>;

/** The PURE change builder (`PlanMutation.changes`, ASYNC). Resolves the parent profile id, parses +
 *  validates the parameter_schema (value-free failure), then emits the `tool:create` change. */
export async function agentToolCreateChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = agentToolCreateArgs.parse(input);
  // LOCAL validation FIRST — the R3 gate promises a mis-shaped/over-cap schema costs ZERO wire
  // calls. `resolveAgentId` sends a `profile.list` for a SLUG `--agent`, so validating after it
  // would spend a request to reject input we can reject offline. Order: parse → validate → resolve.
  const parameterSchema = parseJsonObjectFlag(parsed["parameter-schema"], "--parameter-schema");
  assertToolParameterSchema(parameterSchema, "--parameter-schema");
  const pid = requireProject(ctx);
  const profileId = await resolveAgentId(ctx, parsed.agent);
  return [
    {
      action: "create",
      resource: "tool",
      path: renderRoutePath("tool.create", { pid, id: profileId }),
      body: {
        tool_name: parsed.name,
        description: parsed.description,
        parameter_schema: parameterSchema,
      },
    },
  ];
}
