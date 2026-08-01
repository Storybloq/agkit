// `route create` args + plan-change builder (T-217 step 6; model_route.create, routes:write,
// danger PR, gating plan_required). The frozen `model_route_create_request` $def is REALIZATION-
// COMPLETE: ALL 8 members required, `additionalProperties:false` — the operator EXPRESSES every
// realization member as a USER-SUPPLIED argument (A3: the binary hardcodes NO provider/model/tier/
// execution-target name; a client default for a realization member would be a baked literal — D6).
//
//   • the five realization-bearing flags (--tier --model --provider --execution-target
//     --attestation) are REQUIRED;
//   • --fallback-execution-target is optional ⇒ ABSENT folds to an EXPLICIT `null` (the $def's
//     ["string","null"] member — the executor never defaults a member);
//   • --enabled defaults true / --default defaults false (booleans are not realization names);
//   • every value passes through VERBATIM — vocabulary membership (bindable execution-target
//     registry, off/soft/required attestation, provider/tier sets) is SERVER-owned, fail-closed
//     at the action boundary (no client vocabulary copy — honor-or-reject).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

/** A boolean flag that also accepts an explicit `--flag true|false` value (the tokenizer yields a
 *  bare `true` or the string). Normalized by `toBool` — never `z.coerce.boolean` (Boolean("false")
 *  is true — a silent inversion). */
export const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
export function toBool(value: boolean | "true" | "false"): boolean {
  return value === true || value === "true";
}

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const routeCreateArgs = z
  .object({
    tier: z.string().min(1).describe("The client-visible tier this route binds (server-owned vocabulary)."),
    model: z.string().min(1).describe("The model this tier binds to (server-owned vocabulary)."),
    provider: z.string().min(1).describe("The provider serving the model (server-owned vocabulary)."),
    "execution-target": z
      .string()
      .min(1)
      .describe("Where inference executes (server-owned bindable registry, fail-closed)."),
    "fallback-execution-target": z
      .string()
      .min(1)
      .optional()
      .describe("Fallback execution target; ABSENT sends an explicit null (no fallback)."),
    attestation: z.string().min(1).describe("Attestation policy for this route (server-owned vocabulary)."),
    enabled: boolFlagArg.optional().describe("Whether the route is live (default true)."),
    default: boolFlagArg.optional().describe("Whether this route is the tier's default (default false)."),
    confirm: confirmArg,
  })
  .strict();
export type RouteCreateInput = z.infer<typeof routeCreateArgs>;

/**
 * The PURE change builder (`PlanMutation.changes`). Re-parses defensively, then realizes the
 * frozen all-8 body EXACTLY (kebab flags → snake members, values verbatim; absent fallback ⇒
 * explicit null; boolean defaults applied HERE, visibly, not by zod — the reconstructed
 * invocation carries only what the operator passed).
 */
export function routeCreateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = routeCreateArgs.parse(input);
  return [
    {
      action: "create",
      resource: "model_route",
      path: renderRoutePath("model_route.create", { pid: requireProject(ctx) }),
      body: {
        tier: parsed.tier,
        model: parsed.model,
        provider: parsed.provider,
        execution_target: parsed["execution-target"],
        fallback_execution_target: parsed["fallback-execution-target"] ?? null,
        attestation: parsed.attestation,
        enabled: parsed.enabled === undefined ? true : toBool(parsed.enabled),
        default: parsed.default === undefined ? false : toBool(parsed.default),
      },
    },
  ];
}
