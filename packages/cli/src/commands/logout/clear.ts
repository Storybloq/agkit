// `logout clear` handler — the bare `agkit logout` (T-213 S8, D2). Best-effort server-side
// revocation + LOCAL credential clear. Never fails locally when the server revoke is unreachable
// (FORBIDDEN row): a revocation failure is a LOUD warning, the local clear proceeds, exit stays 0.
//
// Per profile (the active one, or every known profile under --all-profiles): read the STORED
// record (B-7c — bypasses AGKIT_TOKEN + the credential-helper), best-effort RFC 7009 revoke its
// refresh token (else its access token) at the record's OWN VALIDATED issuer origin BEFORE
// deleting it (the shared X1 rule — a missing/invalid issuer skips revocation; the token is never
// sent to any other origin), then clear the keychain + plaintext entries. A profile with no stored
// credential is a no-op (logout is housekeeping, not an auth probe). AGKIT_TOKEN, when set, cannot
// be cleared by the CLI — the output says so (hint: `unset AGKIT_TOKEN`).
//
// --all-profiles (B-15): the clear loop tolerates a per-profile failure (a locked keychain →
// continue, collect a warning), but the invocation fails (exit 1, retryable) IFF the ACTIVE
// profile's credential could not be cleared — a stale active credential must never be reported as
// a clean logout.
import { z } from "zod";
import { requireAuth, requireRuntime, type CommandHandler, type CommandResult } from "../types";
import { readEnvToken, validatedIssuerOrigin } from "../../core/auth";
import { safeErrorMessage } from "../../core/errors";
import { RetryableTransportError } from "../../core/client/retry";

export const logoutClearArgs = z
  .object({
    "all-profiles": z.coerce.boolean().optional().describe("Log out of every known profile, not just the active one."),
  })
  .strict();
export type LogoutClearInput = z.infer<typeof logoutClearArgs>;

export const logoutClear: CommandHandler<LogoutClearInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const auth = requireAuth(ctx);
  const allProfiles = Boolean(input["all-profiles"]);
  const active = auth.effectiveProfile();
  const targets = allProfiles ? auth.listProfiles() : [active];

  const cleared: string[] = [];
  const warnings: string[] = [];
  let activeFailed = false;

  for (const profile of targets) {
    // X2: EVERY per-profile step sits inside THIS profile's own fault boundary — one malformed
    // credential file / unavailable keychain must never abort the loop before the REMAINING
    // profiles clear, and `activeFailed` derives ONLY from whether the ACTIVE profile's CLEAR
    // actually succeeded (a failed read alone never fails the invocation).

    // B-7c: read the STORED record (store-scoped) so its token can be revoked BEFORE deletion.
    // A throwing read (malformed document, broken backend) is a profile-scoped warning — no
    // secret/path detail beyond the profile name — and the local clear below STILL runs.
    let record: Awaited<ReturnType<typeof auth.readStoredRecord>> = null;
    try {
      record = await auth.readStoredRecord(profile);
    } catch {
      warnings.push(
        `could not read the stored credential for '${profile}' — skipping its revocation; still clearing it locally`,
      );
    }

    const revokeToken = record?.refresh_token ?? record?.access_token ?? null;
    if (revokeToken !== null) {
      // Round 2: revoke ONLY at the record's OWN VALIDATED issuer — the SHARED X1 rule
      // (core/auth/issuer-origin: https, or cleartext http to a literal loopback IP; userinfo and
      // `localhost` rejected). A missing/empty/invalid issuer SKIPS revocation entirely: the token
      // is sent NOWHERE — in particular never the guard-approved origin, which may be a DIFFERENT
      // host than the one that minted this token (the exact cross-origin credential disclosure X1
      // closed in login). The local clear below still proceeds; exit semantics are unchanged.
      const origin = validatedIssuerOrigin(record?.issuer);
      if (origin === null) {
        warnings.push(`could not revoke '${profile}' server-side — its issuer is unknown; clearing locally`);
      } else {
        try {
          const revoked = await auth.revoke(origin, revokeToken);
          if (!revoked) {
            warnings.push(
              `could not revoke '${profile}' server-side — the token may remain valid until it expires ` +
                `(revoke it from the dashboard to force it)`,
            );
          }
        } catch {
          // An unexpected throw on the revocation leg is best-effort too (the FORBIDDEN row: a
          // revocation failure never blocks the local clear or the loop).
          warnings.push(
            `could not revoke '${profile}' server-side — the token may remain valid until it expires ` +
              `(revoke it from the dashboard to force it)`,
          );
        }
      }
    }

    // Local clear (best-effort). A locked keychain is collected as a warning, never a throw.
    try {
      const res = await auth.clear(profile);
      if (res.keychain_backend_available) {
        if (res.keychain_removed || res.insecure_removed) cleared.push(profile);
        // else: nothing was stored for this profile → already clean (no-op).
      } else {
        warnings.push(
          `could not clear '${profile}': the OS keychain was unavailable, so a stored credential may remain`,
        );
        if (profile === active) activeFailed = true;
      }
    } catch (err) {
      warnings.push(`could not clear '${profile}': ${safeErrorMessage(err)}`);
      if (profile === active) activeFailed = true;
    }
  }

  // B-15: under --all-profiles, a failure to clear the ACTIVE profile is a non-zero (retryable)
  // exit — a stale active credential is never reported as a clean logout. Single-profile logout
  // stays exit 0 (housekeeping; the FORBIDDEN "never fail locally" row).
  if (allProfiles && activeFailed) {
    throw new RetryableTransportError(
      "server",
      null,
      `logout could not clear the active profile '${active}' (the OS keychain was unavailable); ` +
        `cleared profiles: [${cleared.join(", ")}] — retry when the keychain is accessible`,
    );
  }

  // AGKIT_TOKEN cannot be cleared by the CLI (decision g) — say so; else an honest empty result.
  let note: string | undefined;
  if (readEnvToken(rt.env)) {
    note =
      "AGKIT_TOKEN is set in your environment and cannot be cleared by the CLI — run `unset AGKIT_TOKEN` to stop using it.";
  } else if (cleared.length === 0) {
    note = "no stored credential was found — nothing to clear.";
  }

  const data = { cleared, active, all_profiles: allProfiles };
  const out: CommandResult = { data };
  if (warnings.length > 0) out.warnings = warnings;
  if (note) out.meta = { note };
  return out;
};
