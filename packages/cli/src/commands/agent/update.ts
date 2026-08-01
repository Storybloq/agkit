// `agent update <agent> [config flags]` args + plan-change builder (T-218; agents:write, danger
// PR). Plan-kind over the executable `agent_profile:update` CHANGE_TABLE entry (the wire route is
// plan_required — the only legal write path). The arg surface is `.strict()` with EXACTLY the eight
// `agent_profile_update_request` properties as kebab flags (management-resources.schema.json:115 —
// all optional, minProperties:1) PLUS the two `--clear-*` convenience flags. There is deliberately
// NO `--slug` flag (R13 / FORBIDDEN 9: slug is IMMUTABLE — the row is located by the {id} path param;
// `--slug anything` fails the strict zod parse client-side, ZERO wire calls). The $def's
// `minProperties:1` is mirrored client-side (at least one change flag). Per-member bounds stay
// SERVER-validated (the CLI never re-derives realization).
//
// safety_settings / thinking_config are `["object","null"]`: `--safety-settings <json>` SETS an
// object, `--clear-safety-settings` SETS explicit null (deliberately unset). The two are mutually
// exclusive (setting AND clearing the same member is contradictory → value-free usage_error). The
// change builder is ASYNC: it resolves the slug-or-UUID to an id (ONE profile.list) BEFORE building
// the concrete path (D-7).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { CliLocalError } from "../../core/errors";
import { resolveAgentId } from "./resolve";
import { boolFlagArg, toBool, repeatableStringArg, normalizeList, parseJsonObjectFlag } from "./args-common";

export const agentUpdateArgs = z
  .object({
    agent: z.string().min(1).describe("Agent profile slug or id to update."),
    "display-name": z.string().min(1).optional().describe("Human-readable name for the profile."),
    "static-system-prompt": z.string().optional().describe("The profile's static system prompt (may be empty)."),
    "allowed-tiers": repeatableStringArg.optional().describe("Replace the allowed tiers (repeatable; server-owned vocabulary)."),
    "max-input-tokens": z.coerce.number().int().optional().describe("Max input tokens per request."),
    "max-output-tokens": z.coerce.number().int().optional().describe("Max output tokens per request."),
    enabled: boolFlagArg.optional().describe("Whether the profile is live."),
    "safety-settings": z.string().optional().describe("Safety settings as a JSON object."),
    "clear-safety-settings": boolFlagArg.optional().describe("Set safety settings to null (deliberately unset)."),
    "thinking-config": z.string().optional().describe("Thinking config as a JSON object."),
    "clear-thinking-config": boolFlagArg.optional().describe("Set thinking config to null (deliberately unset)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict()
  .superRefine((val, refCtx) => {
    // Mutual exclusion: --safety-settings AND --clear-safety-settings (and the thinking twins) are
    // contradictory (set vs unset the same member). Value-free — names the flags only.
    if (val["safety-settings"] !== undefined && val["clear-safety-settings"] !== undefined) {
      refCtx.addIssue({ code: "custom", message: "--safety-settings and --clear-safety-settings are mutually exclusive" });
    }
    if (val["thinking-config"] !== undefined && val["clear-thinking-config"] !== undefined) {
      refCtx.addIssue({ code: "custom", message: "--thinking-config and --clear-thinking-config are mutually exclusive" });
    }
    // minProperties:1 mirror — at least one change flag (any config member OR a clear flag).
    const changeFlags = [
      "display-name",
      "static-system-prompt",
      "allowed-tiers",
      "max-input-tokens",
      "max-output-tokens",
      "enabled",
      "safety-settings",
      "clear-safety-settings",
      "thinking-config",
      "clear-thinking-config",
    ] as const;
    const record = val as Record<string, unknown>;
    if (changeFlags.every((k) => record[k] === undefined)) {
      refCtx.addIssue({
        code: "custom",
        message:
          "nothing to update — pass at least one config flag (--display-name, --static-system-prompt, --allowed-tiers, --max-input-tokens, --max-output-tokens, --enabled, --safety-settings/--clear-safety-settings, --thinking-config/--clear-thinking-config)",
      });
    }
  });
export type AgentUpdateInput = z.infer<typeof agentUpdateArgs>;

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC per T-217 R-D). Re-parses defensively,
 * resolves the slug-or-UUID to an id, then realizes ONLY the present members of
 * `agent_profile_update_request` (kebab → snake). `--clear-*` sends explicit null; `--safety-settings`
 * sends the parsed object; neither key appears when the operator passed nothing for that member.
 */
export async function agentUpdateChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = agentUpdateArgs.parse(input);
  const pid = requireProject(ctx);
  const id = await resolveAgentId(ctx, parsed.agent);

  const body: Record<string, unknown> = {};
  if (parsed["display-name"] !== undefined) body.display_name = parsed["display-name"];
  if (parsed["static-system-prompt"] !== undefined) body.static_system_prompt = parsed["static-system-prompt"];
  if (parsed["allowed-tiers"] !== undefined) body.allowed_tiers = normalizeList(parsed["allowed-tiers"] as string | string[]);
  if (parsed["max-input-tokens"] !== undefined) body.max_input_tokens = parsed["max-input-tokens"];
  if (parsed["max-output-tokens"] !== undefined) body.max_output_tokens = parsed["max-output-tokens"];
  if (parsed.enabled !== undefined) body.enabled = toBool(parsed.enabled);
  if (parsed["safety-settings"] !== undefined) body.safety_settings = parseJsonObjectFlag(parsed["safety-settings"], "--safety-settings");
  else if (parsed["clear-safety-settings"] !== undefined && toBool(parsed["clear-safety-settings"])) body.safety_settings = null;
  if (parsed["thinking-config"] !== undefined) body.thinking_config = parseJsonObjectFlag(parsed["thinking-config"], "--thinking-config");
  else if (parsed["clear-thinking-config"] !== undefined && toBool(parsed["clear-thinking-config"])) body.thinking_config = null;

  // Defense in depth: the superRefine guarantees >=1 change, but a `--clear-*` set to `false` yields
  // no body member — refuse an empty patch rather than send a minProperties:1-violating body.
  if (Object.keys(body).length === 0) {
    throw new CliLocalError("usage_error", {
      detail: "nothing to update — the passed flags produced no change",
      hint: "pass at least one config flag with a value (a --clear-* flag set to false changes nothing)",
    });
  }

  return [
    {
      action: "update",
      resource: "agent_profile",
      path: renderRoutePath("profile.update", { pid, id }),
      body,
    },
  ];
}
