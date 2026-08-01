// `agent create <slug>` args + plan-change builder (T-218; N-011 agents family, agents:write,
// danger PR). Plan-kind over the executable `agent_profile:create` CHANGE_TABLE entry (the wire
// route is `plan_required` — plan→apply is the ONLY legal write path). The body is the frozen
// `agent_profile_create_request` $def realized EXACTLY (management-resources.schema.json:98 —
// additionalProperties:false, all NINE members required): the operator EXPRESSES every member
// because the plan executor never defaults one (the realization-complete precedent, same as
// model_route_create_request / route create).
//
//   slug                 → positional <slug>
//   display_name         → --display-name              (required)
//   static_system_prompt → --static-system-prompt      (required)
//   allowed_tiers        → --allowed-tiers <t> (repeatable, >=1; values VERBATIM — no tier
//                          vocabulary client-side, help/examples name NO concrete tier; the tier
//                          set is server-owned, membership validated at the executor)
//   max_input_tokens     → --max-input-tokens          (required int)
//   max_output_tokens    → --max-output-tokens         (required int)
//   enabled              → --enabled                   (boolean, default true — applied visibly here)
//   safety_settings      → --safety-settings <json>    (optional; ABSENT ⇒ explicit null)
//   thinking_config      → --thinking-config <json>    (optional; ABSENT ⇒ explicit null)
//
// safety_settings / thinking_config are `["object","null"]` in the $def (null = deliberately unset —
// the nullable jsonb columns); the $def REQUIRES the members, so an absent flag sends an explicit
// `null`, never omits the key. Per-member bounds (tier membership, length/token caps, safety/thinking
// shape) stay SERVER-side at the executor — the CLI pins only structural shape (bytes over claims).
// Flag names are kebab-case; the wire $def uses snake_case, so the builder maps each verbatim.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { boolFlagArg, toBool, repeatableStringArg, normalizeList, parseJsonObjectFlag } from "./args-common";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const agentCreateArgs = z
  .object({
    slug: z.string().min(1).describe("The agent profile's stable slug (server-owned uniqueness per project)."),
    "display-name": z.string().min(1).describe("Human-readable name for the profile."),
    "static-system-prompt": z.string().describe("The profile's static system prompt (may be empty)."),
    "allowed-tiers": repeatableStringArg.describe("A tier this profile may use (repeatable; server-owned vocabulary)."),
    "max-input-tokens": z.coerce.number().int().describe("Max input tokens per request."),
    "max-output-tokens": z.coerce.number().int().describe("Max output tokens per request."),
    enabled: boolFlagArg.optional().describe("Whether the profile is live (default true)."),
    "safety-settings": z
      .string()
      .optional()
      .describe("Safety settings as a JSON object; ABSENT sends an explicit null (deliberately unset)."),
    "thinking-config": z
      .string()
      .optional()
      .describe("Thinking config as a JSON object; ABSENT sends an explicit null (deliberately unset)."),
    confirm: confirmArg,
  })
  .strict()
  .superRefine((val, refCtx) => {
    // allowed_tiers is REQUIRED with >=1 member (the $def types it as a non-empty realization member).
    if (normalizeList(val["allowed-tiers"] as string | string[] | undefined).length === 0) {
      refCtx.addIssue({
        code: "custom",
        path: ["allowed-tiers"],
        message: "at least one --allowed-tiers is required",
      });
    }
  });
export type AgentCreateInput = z.infer<typeof agentCreateArgs>;

/**
 * The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order —
 * then realizes the frozen `agent_profile_create_request` body EXACTLY: all nine members, kebab flags
 * mapped to snake wire members, the boolean default applied visibly, and absent safety/thinking sent
 * as explicit `null`. A malformed `--safety-settings`/`--thinking-config` is a value-free usage_error
 * BEFORE any wire call.
 */
export function agentCreateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = agentCreateArgs.parse(input);
  const safety =
    parsed["safety-settings"] !== undefined ? parseJsonObjectFlag(parsed["safety-settings"], "--safety-settings") : null;
  const thinking =
    parsed["thinking-config"] !== undefined ? parseJsonObjectFlag(parsed["thinking-config"], "--thinking-config") : null;
  return [
    {
      action: "create",
      resource: "agent_profile",
      path: renderRoutePath("profile.create", { pid: requireProject(ctx) }),
      body: {
        slug: parsed.slug,
        display_name: parsed["display-name"],
        static_system_prompt: parsed["static-system-prompt"],
        allowed_tiers: normalizeList(parsed["allowed-tiers"] as string | string[]),
        max_input_tokens: parsed["max-input-tokens"],
        max_output_tokens: parsed["max-output-tokens"],
        enabled: parsed.enabled === undefined ? true : toBool(parsed.enabled),
        safety_settings: safety,
        thinking_config: thinking,
      },
    },
  ];
}
