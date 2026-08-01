// `kill-switch` noun (T-219; N-011 C11/A505-A506 — the per-project traffic kill switch). THE
// asymmetric surface (§1 D-1/D-5, registry-encoded): `status` (SR read over `kill_switch.get`,
// verb per D-8), `activate` (ENGAGE: danger D + direct_confirm + MANDATORY --reason — halting
// traffic is the protective direction, ONE direct POST, incident speed), `deactivate` (DISENGAGE:
// danger PR + plan_required — resuming traffic is a prod re-bind, full plan ceremony + banner).
// The S-A registry teeth make `requireReason` machine-checked data; the plane fixture cross-derives
// BOTH branches from the RT row's `{engage, disengage}` danger/gating objects.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { killSwitchStatus, killSwitchStatusArgs } from "./status";
import { killSwitchActivate, killSwitchActivateArgs, prepareKillSwitchActivate } from "./activate";
import { killSwitchDeactivateArgs, killSwitchDeactivateChanges } from "./deactivate";
import { planMutationHandler } from "../plan/apply";

export const killSwitchCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "kill-switch",
    verb: "status",
    summary: "Show the project's kill-switch state (active, reason, attribution).",
    args: killSwitchStatusArgs,
    scopes: ["killswitch:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("kill-switch", "status"),
    examples: ["agkit kill-switch status"],
    handler: killSwitchStatus,
    execution: "remote",
  }),
  // ENGAGE (D-1): D + direct_confirm + requireReason — the wire-required typed project-name
  // confirm; ONE direct POST (no plan round-trip). mcpExcluded: engaging a kill switch stays a
  // human act.
  defineCommand({
    noun: "kill-switch",
    verb: "activate",
    summary: "ENGAGE the kill switch — halts ALL end-user traffic for this project immediately (requires --reason).",
    args: killSwitchActivateArgs,
    scopes: ["killswitch:write"],
    danger: "D",
    outputSchemaId: outputSchemaId("kill-switch", "activate"),
    examples: ['agkit kill-switch activate --reason "provider incident"'],
    handler: killSwitchActivate,
    confirm: { challenge: "project-name", requireReason: true },
    mutation: { kind: "direct_confirm", prepare: prepareKillSwitchActivate },
    mcpExclude:
      "incident-response direct_confirm ceremony — typed project-name confirm + mandatory reason; engaging a kill switch stays a human act; returns no Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "kill-switch",
    verb: "deactivate",
    summary: "Disengage the kill switch — resumes end-user traffic (prod-rebinding; prior attribution is preserved).",
    args: killSwitchDeactivateArgs,
    scopes: ["killswitch:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("kill-switch", "deactivate"),
    examples: ["agkit kill-switch deactivate"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: killSwitchDeactivateChanges },
    execution: "remote",
  }),
];
