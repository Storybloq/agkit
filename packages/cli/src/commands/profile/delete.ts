// `profile delete --name <name>` (T-208, deliverable 3 + FORBIDDEN set). Removes
// the profile's keychain entry (the explicit acceptance — asserted via the injected
// keyring fake), its plaintext record, and its config defaults + confirmation
// ledger, resetting the active pointer if it pointed here. NEVER leaves a credential
// behind; NEVER a cross-profile fallback (the keychain delete names EXACTLY `name`).
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { deleteProfile } from "../../core/config";

export const profileDeleteArgs = z.object({ name: z.string().describe("Profile to delete.") }).strict();
export type ProfileDeleteInput = z.infer<typeof profileDeleteArgs>;

export const profileDelete: CommandHandler<ProfileDeleteInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const result = await deleteProfile(
    { env: rt.env, homeDir: rt.homeDir, keyring: rt.keyring, cwd: rt.cwd, flags: rt.flags },
    input.name,
  );
  // Prominently surface a PARTIAL delete: when the keychain backend was unavailable the
  // config/plaintext were removed but a keychain credential may remain (recreating this
  // profile name later could unexpectedly reuse it). Honest about the degraded path.
  const warnings = result.keychain_backend_available
    ? undefined
    : [
        `the OS keychain was unavailable, so a stored credential for '${result.profile}' may REMAIN. ` +
          `Config and plaintext were removed; run 'agkit profile delete --name ${result.profile}' again once ` +
          `the keychain is accessible to clear it.`,
      ];
  return { data: result, warnings };
};
