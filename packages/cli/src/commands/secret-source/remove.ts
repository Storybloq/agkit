// `agkit secret-source remove --env <VAR_NAME> | --file <PATH>` (T-227 S5b) — withdraw ONE
// declaration from the active profile's allowlist.
//
// REMOVAL IS THE SAFE DIRECTION, which is why it is M-class like its `add` sibling rather than D:
// the effect is that indirect references to this source stop being honored over MCP. Nothing is
// deleted from the filesystem, no env var is unset, and the operator can re-declare at any time —
// so a typed-confirm ceremony would be theatre over a reversible local config write.
//
// A no-match reports `changed:false` rather than refusing: the operator asked for a state ("this is
// not a declared source"), and that state already holds. The FILE selector matches the STORED
// CANONICAL path verbatim — the same comparison resolution uses — so a path that never resolved to a
// declaration cannot be "removed" by accident through a symlink alias.
import { z } from "zod";
import { type CommandHandler } from "../types";
import { removeSecretSource } from "../../core/config";
import { requireSecretSourceSelector, secretSourceSelectorShape } from "./selector";
import { secretSourceDeps, viewSecretSources } from "./store";

export const secretSourceRemoveArgs = z.object({ ...secretSourceSelectorShape }).strict();
export type SecretSourceRemoveInput = z.infer<typeof secretSourceRemoveArgs>;

export const secretSourceRemove: CommandHandler<SecretSourceRemoveInput> = async (ctx, input) => {
  const selector = requireSecretSourceSelector(input);
  const result = removeSecretSource(secretSourceDeps(ctx), selector);
  return {
    data: {
      profile: result.profile,
      kind: selector.kind,
      removed: result.changed,
      changed: result.changed,
      sources: viewSecretSources(result.sources),
      config_path: result.config_path,
    },
  };
};
