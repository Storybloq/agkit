// `route update <id>` args + plan-change builder (T-217 step 7; model_route.update, routes:write,
// danger PR, gating plan_required). The frozen `model_route_update_request` $def is a PARTIAL
// PATCH: every member optional, `minProperties:1`, `additionalProperties:false`, and **`tier` is
// IMMUTABLE** (absent from the $def by design — this surface carries NO --tier flag).
//
//   • the patch body carries ONLY the members whose flags are present (never an undefined key);
//   • ≥1 patch member is required (zod refine — a bare `route update <id>` is a teachable
//     usage_error BEFORE any wire call, mirroring the $def's minProperties);
//   • fallback tri-state: `--fallback-execution-target <v>` sets it; `--clear-fallback-execution-target`
//     sends an explicit `null`; BOTH together is a contradiction → reject;
//   • values pass through VERBATIM (server-owned vocabulary, fail-closed — no client copy).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { CliLocalError } from "../../core/errors";
import { boolFlagArg, toBool } from "./create";

/** The patch-expressing flag keys (kebab) — used by the ≥1-member refine. */
const PATCH_KEYS = [
  "provider",
  "model",
  "execution-target",
  "fallback-execution-target",
  "clear-fallback-execution-target",
  "attestation",
  "enabled",
  "default",
] as const;

export const routeUpdateArgs = z
  .object({
    id: z.string().min(1).describe("Model-route id to update."),
    provider: z.string().min(1).optional().describe("New provider (server-owned vocabulary)."),
    model: z.string().min(1).optional().describe("New model (server-owned vocabulary)."),
    "execution-target": z.string().min(1).optional().describe("New execution target (server-owned registry)."),
    "fallback-execution-target": z
      .string()
      .min(1)
      .optional()
      .describe("New fallback execution target (use --clear-fallback-execution-target to unset)."),
    "clear-fallback-execution-target": boolFlagArg
      .optional()
      .describe("Clear the fallback execution target (sends an explicit null)."),
    attestation: z.string().min(1).optional().describe("New attestation policy (server-owned vocabulary)."),
    enabled: boolFlagArg.optional().describe("Enable/disable the route: --enabled true|false."),
    default: boolFlagArg.optional().describe("Make (or unmake) this route the tier's default: --default true|false."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict()
  .refine((v) => PATCH_KEYS.some((k) => v[k] !== undefined), {
    message: "route update needs at least one patch flag (nothing to change)",
  })
  .refine(
    (v) => !(v["fallback-execution-target"] !== undefined && v["clear-fallback-execution-target"] !== undefined),
    { message: "--fallback-execution-target and --clear-fallback-execution-target contradict each other; pass one" },
  );
export type RouteUpdateInput = z.infer<typeof routeUpdateArgs>;

/**
 * The PURE change builder. Re-parses defensively; the body carries ONLY present members
 * (kebab→snake, verbatim), the clear flag folds to an explicit `fallback_execution_target: null`,
 * and `tier` is unrepresentable (immutable by $def design).
 */
export function routeUpdateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = routeUpdateArgs.parse(input);
  const body: Record<string, unknown> = {};
  if (parsed.provider !== undefined) body.provider = parsed.provider;
  if (parsed.model !== undefined) body.model = parsed.model;
  if (parsed["execution-target"] !== undefined) body.execution_target = parsed["execution-target"];
  if (parsed["fallback-execution-target"] !== undefined) {
    body.fallback_execution_target = parsed["fallback-execution-target"];
  } else if (parsed["clear-fallback-execution-target"] !== undefined && toBool(parsed["clear-fallback-execution-target"])) {
    body.fallback_execution_target = null; // the explicit tri-state null
  }
  if (parsed.attestation !== undefined) body.attestation = parsed.attestation;
  if (parsed.enabled !== undefined) body.enabled = toBool(parsed.enabled);
  if (parsed.default !== undefined) body.default = toBool(parsed.default);
  if (Object.keys(body).length === 0) {
    // Degenerate cell the refine's presence check can't see (`--clear-fallback-execution-target
    // false` alone): the EFFECTIVE patch is empty — teach client-side, mirroring minProperties:1.
    throw new CliLocalError("usage_error", {
      detail: "route update needs at least one patch flag (nothing to change)",
    });
  }
  return [
    {
      action: "update",
      resource: "model_route",
      path: renderRoutePath("model_route.update", { pid: requireProject(ctx), id: parsed.id }),
      body,
    },
  ];
}
