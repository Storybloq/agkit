// `profile use --name <name>` (T-208, deliverable 3). Selects the active profile by
// persisting `default_profile` (and ensuring a listable entry). A `--profile`/env
// override still wins at resolution time; this sets the durable default.
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { useProfile } from "../../core/config";

export const profileUseArgs = z.object({ name: z.string().describe("Profile to make active.") }).strict();
export type ProfileUseInput = z.infer<typeof profileUseArgs>;

export const profileUse: CommandHandler<ProfileUseInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const result = useProfile(
    { env: rt.env, homeDir: rt.homeDir, keyring: rt.keyring, cwd: rt.cwd, flags: rt.flags },
    input.name,
  );
  return { data: result };
};
