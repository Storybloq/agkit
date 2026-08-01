// `media-route set <capability> --provider <p> --model <m> [--config-json <path>] [--disabled]`
// args + plan-change builder (T-220; media-routes:write, danger PR, wire `media_route.upsert` =
// plan_required — plan→apply is the ONLY write path). `--model` is REQUIRED (D2: the frozen
// $def requires {provider, model}; a model-less grammar would teach a 422). Both values are
// user-supplied, uninterpreted strings — realization vocabulary is server-owned (§5-F5).
//
// AM-0b (presence congruence): plan.create REJECTS an `update` change on an ABSENT row and a
// `create` on a PRESENT one, so the builder prefetches `media_route.get` (same-family read) and
// forks the action honestly: 404 ⇒ `create`, present ⇒ `update`. T-276: the two keys resolve
// the same `media_route.upsert` operation but dispatch DIFFERENT executables — create is
// INSERT-ONLY, so the create arm's insert race is fail-LOUD server-side
// (conflict/already_exists), never a silent overwrite of a row that landed between our probe
// and apply.
// AM-0c (mandatory `enabled`): the plan executor REQUIRES `enabled` in the upsert body even
// though the wire $def marks it optional — the body ALWAYS carries it: create ⇒ true, rebind ⇒
// the probe's current value (preserve), `--disabled` (an explicit true/false bool flag)
// overriding in BOTH modes.
// S1 ordering: the config file is read+parsed BEFORE the probe, so every `--config-json`
// failure (missing/oversize/malformed/non-object) is a usage_error with ZERO wire calls.
import { z } from "zod";
import { requireProject, requireRuntime, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { CONFIG_JSON_READ_CAP_BYTES, parseConfigJsonObject } from "./config-json";

/** A boolean flag that also accepts an explicit `--flag true|false` (route-plane precedent).
 *  Never `z.coerce.boolean` (Boolean("false") is true — a silent inversion; L-053 class). */
export const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
export function toBool(value: boolean | "true" | "false"): boolean {
  return value === true || value === "true";
}

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const mediaRouteSetArgs = z
  .object({
    capability: z.string().min(1).describe("Media capability key (e.g. image, voice)."),
    provider: z.string().min(1).describe("Provider slug for this capability (user-supplied; the dashboard owns realization)."),
    model: z.string().min(1).describe("Model id at the provider (required by the wire contract)."),
    "config-json": z
      .string()
      .min(1)
      .optional()
      .describe("Path to a JSON file whose object REPLACES the stored config wholesale; omit to leave the stored config untouched."),
    disabled: boolFlagArg
      .optional()
      .describe("Bind the route disabled (`--disabled` / `--disabled true`); default: enabled on create, current state preserved on rebind."),
    confirm: confirmArg,
  })
  .strict();
export type MediaRouteSetInput = z.infer<typeof mediaRouteSetArgs>;

// AM-0c fail-closed preserve: rebind mode needs the CURRENT `enabled` from the probe DTO — a
// row without a boolean `enabled` member is a server protocol violation, never a guessed value.
const ENABLED_PROTOCOL_DETAIL =
  "the management API returned this media route without a boolean `enabled` member, so the current state cannot be preserved — this is a server protocol error, not a request you can fix";

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC). Order: parse → resolve `--config-json`
 * (zero wire on any file failure) → ONE same-family probe (`media_route.get`) → presence-forked
 * change whose body ALWAYS carries `enabled`.
 */
export async function mediaRouteSetChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = mediaRouteSetArgs.parse(input);
  const pid = requireProject(ctx);

  let config: Record<string, unknown> | undefined;
  const configPath = parsed["config-json"];
  if (configPath !== undefined) {
    const runtime = requireRuntime(ctx);
    if (runtime.readTextFile === undefined) {
      throw new Error("agkit: internal — media-route set requires the readTextFile seam but it was not injected");
    }
    const text = await runtime.readTextFile(configPath, { maxBytes: CONFIG_JSON_READ_CAP_BYTES });
    config = parseConfigJsonObject(text, configPath);
  }

  let base: unknown | null;
  try {
    base = await ctx.client.request({ operationId: "media_route.get", params: { pid, capability: parsed.capability } });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      base = null; // no route yet for this capability — the create arm (AM-0b)
    } else {
      throw err;
    }
  }

  let enabled: boolean;
  if (parsed.disabled !== undefined) {
    enabled = !toBool(parsed.disabled);
  } else if (base === null) {
    enabled = true;
  } else {
    const current = (base as { enabled?: unknown }).enabled;
    if (typeof current !== "boolean") {
      throw new CliLocalError("usage_error", { detail: ENABLED_PROTOCOL_DETAIL });
    }
    enabled = current;
  }

  const body: Record<string, unknown> = { provider: parsed.provider, model: parsed.model, enabled };
  if (config !== undefined) body.config = config;

  return [
    {
      action: base === null ? "create" : "update",
      resource: "media_route",
      path: renderRoutePath("media_route.upsert", { pid, capability: parsed.capability }),
      body,
    },
  ];
}
