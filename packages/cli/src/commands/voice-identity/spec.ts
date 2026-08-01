// `voice-identity` noun (T-220; N-011 identities family; alias `voice` — T-216 nounAliases seam,
// declaration-only, identical set on every spec of the noun). The voice-identity binding surface:
// SR reads (list/get → `agkit_voice_identity_read`); direct_confirm PR ceremonies for set (the
// dual-mode secret-bearing upsert) and enable/disable (toggle re-validates live at the provider)
// — every direct_confirm citizen is mcpExclude (D8); the M-direct revalidate (also mcpExclude);
// and the plan-kind bodyless delete (identities:destroy, wire PR+D → CLI PR) which alone projects
// `agkit_voice_identity_plan{delete}`.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { voiceIdentityList, voiceIdentityListArgs } from "./list";
import { voiceIdentityGet, voiceIdentityGetArgs } from "./get";
import { voiceIdentitySet, voiceIdentitySetArgs, prepareVoiceIdentitySet } from "./set";
import {
  voiceIdentityToggleArgs,
  prepareVoiceIdentityEnable,
  prepareVoiceIdentityDisable,
  voiceIdentityEnable,
  voiceIdentityDisable,
} from "./toggle";
import {
  voiceIdentityRevalidate,
  voiceIdentityRevalidateArgs,
  voiceIdentityRevalidatePreview,
} from "./revalidate";
import { voiceIdentityDeleteArgs, voiceIdentityDeleteChanges } from "./delete";
import { planMutationHandler } from "../plan/apply";

export const VOICE_IDENTITY_ALIASES = ["voice"] as const;

export const voiceIdentityCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "voice-identity",
    verb: "list",
    summary: "List the project's voice identities.",
    args: voiceIdentityListArgs,
    scopes: ["identities:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("voice-identity", "list"),
    examples: ["agkit voice-identity list"],
    handler: voiceIdentityList,
    nounAliases: VOICE_IDENTITY_ALIASES,
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "get",
    summary: "Show one voice identity (the resource id never appears in any read).",
    args: voiceIdentityGetArgs,
    scopes: ["identities:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("voice-identity", "get"),
    examples: ["agkit voice-identity get narrator"],
    handler: voiceIdentityGet,
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "set",
    summary: "Bind a voice identity to a provider resource (secret resource id; prod-rebinding).",
    args: voiceIdentitySetArgs,
    scopes: ["identities:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("voice-identity", "set"),
    examples: ["agkit voice-identity set narrator --provider example-voice --resource-id-env MY_VOICE_RESOURCE_ID"],
    handler: voiceIdentitySet,
    confirm: { challenge: "key-id" },
    mutation: { kind: "direct_confirm", prepare: prepareVoiceIdentitySet },
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    mcpExclude:
      "typed-confirm direct ceremony binding a wire-secret resource id (out-of-band channels only) — returns no Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "enable",
    summary: "Enable a voice identity (re-validates live at the provider; prod-rebinding).",
    args: voiceIdentityToggleArgs,
    scopes: ["identities:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("voice-identity", "enable"),
    examples: ["agkit voice-identity enable narrator"],
    handler: voiceIdentityEnable,
    confirm: { challenge: "key-id" },
    mutation: { kind: "direct_confirm", prepare: prepareVoiceIdentityEnable },
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    mcpExclude: "typed-confirm direct ceremony (enable re-validates live at the provider) — returns no Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "disable",
    summary: "Disable a voice identity (the binding is kept; enable restores it).",
    args: voiceIdentityToggleArgs,
    scopes: ["identities:write"],
    danger: "PR",
    outputSchemaId: outputSchemaId("voice-identity", "disable"),
    examples: ["agkit voice-identity disable narrator"],
    handler: voiceIdentityDisable,
    confirm: { challenge: "key-id" },
    mutation: { kind: "direct_confirm", prepare: prepareVoiceIdentityDisable },
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    mcpExclude: "typed-confirm direct ceremony (the toggle path re-validates on enable) — returns no Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "revalidate",
    summary: "Re-check a voice identity against the live provider (records definitive verdicts).",
    args: voiceIdentityRevalidateArgs,
    scopes: ["identities:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("voice-identity", "revalidate"),
    examples: ["agkit voice-identity revalidate narrator"],
    handler: voiceIdentityRevalidate,
    mutation: { kind: "direct", preview: voiceIdentityRevalidatePreview },
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    mcpExclude: "direct external revalidation returning a verdict, not a Plan",
    execution: "remote",
  }),
  defineCommand({
    noun: "voice-identity",
    verb: "delete",
    summary: "HARD delete a voice identity — a live voice bound to this identity re-binds.",
    args: voiceIdentityDeleteArgs,
    scopes: ["identities:destroy"],
    danger: "PR",
    outputSchemaId: outputSchemaId("voice-identity", "delete"),
    examples: ["agkit voice-identity delete narrator"],
    handler: planMutationHandler,
    confirm: { challenge: "confirm-string" },
    mutation: { kind: "plan", changes: voiceIdentityDeleteChanges },
    positional: { key: "key", name: "identity-key" },
    nounAliases: VOICE_IDENTITY_ALIASES,
    execution: "remote",
  }),
];
