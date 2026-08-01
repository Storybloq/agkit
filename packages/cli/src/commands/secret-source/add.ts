// `agkit secret-source add --env <VAR_NAME> | --file <PATH>` (T-227 S5b / D0-H v2).
//
// Declares ONE indirect secret source in the ACTIVE profile's `secret_sources` allowlist. The
// declaration is what makes a `{source:"env"}` / `{source:"file"}` reference honorable over MCP —
// on the CLI the operator typed the flag and IS the authorization, so this command exists purely to
// extend that authorization to a channel where the caller is NOT the operator.
//
// A THIN SHELL. Every check lives in `core/config/secret-sources`: the env-NAME grammar, the
// absolute-path gate, the trusted-parent walk, `O_NOFOLLOW` + `fstat` + post-open `lstat`, the
// owner/mode/size rules, and the config-file lock the read-modify-write runs under. Declaring a file
// READS it through that identical ladder and records the `{dev,ino}` it observed, so a source that
// could never resolve is never stored — and a REPLACED file is re-approved by re-running this
// command (the stored identity is overwritten), never trusted silently.
//
// The byte cap is passed EXPLICITLY: `MAX_SECRET_BYTES` is the single ratified ceiling for every
// source on every channel, and relying on the core's own literal default would let this command and
// the resolver enforce two different numbers if that default ever moved.
import { z } from "zod";
import { type CommandHandler } from "../types";
import { declareEnvSecretSource, declareFileSecretSource } from "../../core/config";
import { MAX_SECRET_BYTES } from "../provider-key/secret-env";
import { requireSecretSourceSelector, secretSourceSelectorShape } from "./selector";
import { secretSourceDeps, viewSecretSources } from "./store";

export const secretSourceAddArgs = z.object({ ...secretSourceSelectorShape }).strict();
export type SecretSourceAddInput = z.infer<typeof secretSourceAddArgs>;

export const secretSourceAdd: CommandHandler<SecretSourceAddInput> = async (ctx, input) => {
  const selector = requireSecretSourceSelector(input);
  const deps = secretSourceDeps(ctx);
  const result =
    selector.kind === "env"
      ? declareEnvSecretSource(deps, selector.name)
      : declareFileSecretSource(deps, selector.path, { maxBytes: MAX_SECRET_BYTES });
  return {
    data: {
      profile: result.profile,
      kind: selector.kind,
      declared: true,
      // `changed:false` is an idempotent re-declaration of an env name — an honest "already there",
      // never a silent no-op the operator reads as a fresh approval.
      changed: result.changed,
      sources: viewSecretSources(result.sources),
      config_path: result.config_path,
    },
  };
};
