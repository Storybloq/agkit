// `profile show [--name <name>]` (T-208, deliverable 3). Shows one profile's
// defaults + credential PRESENCE (keychain / plaintext / none — never resolving or
// printing the secret). `--name` defaults to the active profile. Reports presence
// for EXACTLY that profile (no cross-profile fallback).
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { showProfile } from "../../core/config";

export const profileShowArgs = z
  .object({ name: z.string().optional().describe("Profile to show (defaults to the active profile).") })
  .strict();
export type ProfileShowInput = z.infer<typeof profileShowArgs>;

export const profileShow: CommandHandler<ProfileShowInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const detail = await showProfile(
    { env: rt.env, homeDir: rt.homeDir, keyring: rt.keyring, cwd: rt.cwd, flags: rt.flags },
    input.name,
  );
  return { data: detail };
};
