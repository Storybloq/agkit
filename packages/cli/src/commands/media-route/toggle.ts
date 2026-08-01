// `media-route enable|disable <capability>` args + plan-change builders (T-220; media-routes:write,
// danger PR, wire `media_route.toggle` = plan_required PATCH). The change is `action:"invoke"`
// (CHANGE_TABLE `media_route:invoke` → toggle) with body exactly `{enabled}` — the boolean is the
// ONLY difference between the two verbs (one factory, two builders). No prefetch: the plan door
// itself teaches on an absent row. `disable` keeps the binding — the copy never claims removal
// (OD-13 / §5-F2: the relay treating disabled ≡ absent is a wire fact, not a user-facing delete).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const mediaRouteToggleArgs = z
  .object({
    capability: z.string().min(1).describe("Media capability key (e.g. image, voice)."),
    confirm: confirmArg,
  })
  .strict();
export type MediaRouteToggleInput = z.infer<typeof mediaRouteToggleArgs>;

function toggleChanges(enabled: boolean) {
  return async (input: unknown, ctx: Ctx): Promise<PlanChange[]> => {
    const parsed = mediaRouteToggleArgs.parse(input);
    const pid = requireProject(ctx);
    return [
      {
        action: "invoke",
        resource: "media_route",
        path: renderRoutePath("media_route.toggle", { pid, capability: parsed.capability }),
        body: { enabled },
      },
    ];
  };
}

export const mediaRouteEnableChanges = toggleChanges(true);
export const mediaRouteDisableChanges = toggleChanges(false);
