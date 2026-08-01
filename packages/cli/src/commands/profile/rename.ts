// `profile rename --old <old> --new <new>` (T-208, deliverable 3). Migrates the
// config defaults, the active pointer, and the API-URL confirmation ledger, AND
// moves the credential (keychain + any plaintext record) so nothing is orphaned.
// Refuses if `--new` already exists.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { renameProfile } from "../../core/config";

export const profileRenameArgs = z
  .object({
    old: z.string().describe("Current profile name."),
    new: z.string().describe("New profile name."),
  })
  .strict();
export type ProfileRenameInput = z.infer<typeof profileRenameArgs>;

export const profileRename: CommandHandler<ProfileRenameInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const result = await renameProfile(
    { env: rt.env, homeDir: rt.homeDir, keyring: rt.keyring, cwd: rt.cwd, flags: rt.flags },
    input.old,
    input.new,
  );
  return { data: result };
};
