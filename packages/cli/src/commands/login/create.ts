// `login create` handler — the bare `agkit login` (T-213 S7, D1). Orchestrates the whole login
// lifecycle over the PURE injected seams (ctx.runtime + ctx.auth):
//
//   1. parse + MEMBERSHIP-validate `--scopes` (CSV) against the contract registry (decision h);
//   2. auto-detect the flow (browser vs device) and announce it on stderr (SSH caveat too, A5/G);
//   3. run the API-URL guard (ctx.auth.ensureApiUrl) — the SAME memoized guard the client shares;
//   4. read the PRIOR stored record (B-7b) so the old grant can be revoked after the new one lands;
//   5. run the chosen flow → a FULL CredentialRecord (login-flow.ts);
//   6. store it via T-206's write API (keychain, or the 0600 file under --insecure-storage);
//   7. ensure a listable profile config entry (B-4) so `logout --all-profiles` reaches it;
//   8. best-effort revoke the OLD refresh token (orphan-grant hygiene, B-7b);
//   9. emit exactly one secret-free result envelope (profile / source / flow / scopes / expiry).
//
// The handler stays pure (no `process`): all I/O rides ctx.runtime + ctx.auth. Error mapping
// (B-9): a TransportError → the retryable exit-1 rendering; a terminal flow/metadata/loopback
// failure → `usage_error` (exit 2) with an `agkit login` hint. No new codes.
import { z } from "zod";
import { requireAuth, requireRuntime, type CommandHandler, type CommandResult } from "../types";
import { parseCsvScopes, validateScopeMembership } from "../scope-validate";
import { insecureStorageSurface, validatedIssuerOrigin } from "../../core/auth";
import { selectLoginFlow } from "../../core/auth/flow-select";
import {
  runBrowserLogin,
  runDeviceLogin,
  LoginFlowError,
  type LoginFlowResult,
} from "../../core/auth/login-flow";
import { TransportError } from "../../core/auth/oauth-http";
import { AsMetadataError } from "../../core/auth/as-metadata";
import { DeviceAuthorizationError } from "../../core/auth/device-flow";
import { OpenUrlError } from "../../core/auth/open-url";
import { LoopbackTimeoutError, LoopbackClosedError } from "../../core/auth/loopback";
import { RetryableTransportError } from "../../core/client/retry";
import { CliLocalError } from "../../core/errors";

export const loginCreateArgs = z
  .object({
    device: z.coerce.boolean().optional().describe("Force the RFC 8628 device flow (no local browser)."),
    "no-browser": z.coerce.boolean().optional().describe("Do not open a browser; use the device flow."),
    scopes: z.string().optional().describe("Comma-separated scopes to request (family:verb)."),
    "insecure-storage": z.coerce.boolean().optional().describe("Store in a 0600 plaintext file instead of the OS keychain."),
  })
  .strict();
export type LoginCreateInput = z.infer<typeof loginCreateArgs>;

/** Map a thrown login-flow error to an EXISTING code (B-9). Never mints a new code. */
function mapLoginError(err: unknown): never {
  // Transport failure/timeout → the existing retryable exit-1 rendering (login does not route
  // through the typed client, so we wrap the raw TransportError the oauth-http helper threw).
  if (err instanceof TransportError) {
    throw new RetryableTransportError(err.kind, null, err.message);
  }
  // Every RFC-terminal outcome (denied/expired/skew/bad-scheme/watchdog) → usage_error + login hint.
  if (
    err instanceof LoginFlowError ||
    err instanceof AsMetadataError ||
    err instanceof DeviceAuthorizationError ||
    err instanceof OpenUrlError ||
    err instanceof LoopbackTimeoutError ||
    err instanceof LoopbackClosedError
  ) {
    throw new CliLocalError("usage_error", { detail: err.message, hint: "agkit login" });
  }
  throw err; // unknown → run.ts's generic usage_error fallback (never a smuggled exit)
}

export const loginCreate: CommandHandler<LoginCreateInput> = async (ctx, input) => {
  const rt = requireRuntime(ctx);
  const auth = requireAuth(ctx);
  const io = auth.loginIo;

  // 1. Parse + validate scopes BEFORE any network I/O (nothing sent on an unknown scope).
  const scopes = input.scopes ? parseCsvScopes(input.scopes) : [];
  validateScopeMembership(scopes);

  // 2. Auto-detect the flow + announce it (interactive progress → stderr, decision G).
  const decision = selectLoginFlow({
    deviceFlag: Boolean(input.device),
    noBrowserFlag: Boolean(input["no-browser"]),
    isTTY: rt.isTTY,
    platform: io.platform,
    env: rt.env,
  });
  rt.stderr(`agkit: ${decision.announcement}\n`);
  if (decision.caveat) rt.stderr(`agkit: ${decision.caveat}\n`);

  // 3. Guard the destination host (memoized; at most one prompt per invocation).
  const approved = await auth.ensureApiUrl();

  // 4. B-7b: read the PRIOR stored record (store-scoped) so we can revoke its grant afterwards.
  const prior = await auth.readStoredRecord(approved.profile);

  // 5. Run the chosen flow → a full record.
  let result: LoginFlowResult;
  try {
    result =
      decision.flow === "browser"
        ? await runBrowserLogin(io, { apiUrl: approved.apiUrl, scopes })
        : await runDeviceLogin(io, { apiUrl: approved.apiUrl, scopes });
  } catch (err) {
    mapLoginError(err);
  }

  // 6. Store via T-206's write API. A missing keychain backend throws the loud two-remedy
  //    KeychainUnavailableError (classify → keychain_unavailable, naming --insecure-storage +
  //    AGKIT_TOKEN); nothing is written on that path.
  const source = await auth.store(result.record, { insecureStorage: Boolean(input["insecure-storage"]) });

  // 7. B-4: ensure a listable profile config entry (does NOT touch default_profile).
  auth.ensureProfileEntry(approved.profile);

  // 8. B-7b: best-effort revoke the OLD refresh token (orphan-grant hygiene). Never blocks login.
  //    X1: revocation targets ONLY the prior record's OWN VALIDATED issuer (the SHARED
  //    core/auth/issuer-origin rule — logout applies the same one) — never the newly guard-approved
  //    origin (if the profile's API URL changed between logins, sending the old secret there would
  //    be a cross-origin credential disclosure AND leave the real grant live). A legacy record with
  //    a missing/invalid issuer SKIPS remote revocation entirely (warned).
  const warnings: string[] = [];
  const priorRefresh = prior?.refresh_token ?? null;
  if (priorRefresh !== null && priorRefresh !== result.record.refresh_token) {
    const priorOrigin = validatedIssuerOrigin(prior?.issuer);
    if (priorOrigin === null) {
      warnings.push(
        "could not revoke the previous grant — its issuer is unknown; revoke it from the dashboard if it should not remain valid",
      );
    } else {
      const revoked = await auth.revoke(priorOrigin, priorRefresh);
      warnings.push(
        revoked
          ? "the previous login's grant was revoked server-side"
          : "could not revoke the previous login's grant server-side — it may remain valid until it expires",
      );
    }
  }

  // 9. Exactly one secret-free result envelope (no token/refresh_token — only display facts).
  const data = {
    profile: approved.profile,
    credential_source: source,
    flow: result.flow,
    scopes: result.record.scopes,
    expires_at: result.record.access_expires_at,
    api_url: approved.apiUrl,
  };
  const out: CommandResult = { data };
  if (warnings.length > 0) out.warnings = warnings;
  if (source === "insecure_file") out.meta = insecureStorageSurface().meta;
  return out;
};
