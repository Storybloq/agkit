// `profile list` (T-208, deliverable 3). Lists known profiles (config defaults +
// the active pointer) with an `active` marker. Rows render as a table/TSV/JSON via
// the serializer. No keychain probe here (that is `profile show`), so it is cheap.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { listProfiles } from "../../core/config";

export const profileListArgs = z.object({}).strict();
export type ProfileListInput = z.infer<typeof profileListArgs>;

export const profileList: CommandHandler<ProfileListInput> = async (ctx, _input) => {
  const rt = requireRuntime(ctx);
  const result = listProfiles({ env: rt.env, homeDir: rt.homeDir, keyring: rt.keyring, cwd: rt.cwd, flags: rt.flags });
  return { data: result.profiles, meta: { active: result.active } };
};
