// `revenuecat set` — the secret-bearing dual-mode direct_confirm ceremony (T-219 §2 S-D; wire
// `revenuecat.upsert` = PUT, gating direct_confirm, danger PR, idempotency required, secret_bearing
// request). NOT plannable: the server validates the api_key LIVE against RevenueCat (external,
// non-transactional — the frozen $comment's own rationale), and the `revenuecat:update` CHANGE_TABLE
// entry is executable:false naming this direct door (S-8 pins it).
//
// D-2 (wire-inexpressible config): the frozen `revenuecat_upsert_request` is CLOSED `{api_key,
// confirm}` — the dashboard-managed config members (required_entitlement_id / user_id_claim /
// cache_ttl_seconds) have NO write surface at this contract version, so this command ships the key
// channels ONLY (env-indirection or hidden TTY prompt; never argv — FORBIDDEN 4/11). They stay
// READ-visible via `revenuecat get`.
//
// Dual-mode preconditions (B0 A1): the server REQUIRES `If-None-Match: *` on create / `If-Match:
// <etag>` on replace (neither/both → invalid_header). `prepare` probes ONE same-family
// `revenuecat.get`: 200 ⇒ replace (ETag REQUIRED — fail closed BEFORE any prompt on an etag-less
// 200; FORBIDDEN 8), 404 ⇒ create. The mode rides `target.mode` (r5-4's discriminated union — a
// pass can never carry both header forms). D-9: the typed confirm is the project NAME the CLI does
// not know — `expectedConfirm` is OMITTED (forward-verbatim; the server verifies and teaches).
import { z } from "zod";
import type { CommandHandler, Ctx, DirectConfirmPrepared } from "../types";
import { requireProject, requireRuntime, readCapturedEtag } from "../types";
import {
  CliLocalError,
  PreClassifiedError,
  WireProblemError,
  allowlistedWireErrorEnvelope,
} from "../../core/errors";
import { resolveWireSecret, type WireSecretConfig } from "../provider-key/secret-env";

export const revenuecatSetArgs = z
  .object({
    "api-key-env": z
      .string()
      .min(1)
      .optional()
      .describe("NAME of an environment variable holding the RevenueCat secret API key (never the key itself)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The project NAME, to confirm (required non-interactively; the server verifies it)."),
  })
  .strict();
export type RevenuecatSetInput = z.infer<typeof revenuecatSetArgs>;

// The RevenueCat secret-channel configuration (B0 `resolveWireSecret`; T-217 R-H #2 discipline:
// EVERY message is a STATIC constant — zero interpolation of any value or var-name on any branch).
const REVENUECAT_SECRET_CONFIG: WireSecretConfig = {
  envArg: "api-key-env",
  promptQuestion: "Paste the RevenueCat secret API key (input hidden): ",
  emptyDetail: "no API key provided.",
  noChannelDetail:
    "provide --api-key-env <VAR_NAME> (non-interactive), or run in an interactive terminal for a hidden prompt.",
  grammarDetail:
    "--api-key-env takes the NAME of an environment variable (letters, digits, underscore; not starting with a digit). Export the key first (e.g. export MY_REVENUECAT_KEY=...) and pass the variable's NAME.",
  missingEnvDetail: "the environment variable named by --api-key-env is not set or is empty in this shell.",
};

/** Resolve the RevenueCat secret (S-B wrapper): flag-wins → hidden TTY prompt → static channel error. */
export function resolveRevenuecatSecret(ctx: Ctx, parsed: RevenuecatSetInput): Promise<string> {
  return resolveWireSecret(ctx, parsed, REVENUECAT_SECRET_CONFIG);
}

// S-D: channel AVAILABILITY is asserted in prepare — BEFORE the read and BEFORE the typed prompt —
// so a non-TTY invocation with no --api-key-env fails static + zero-wire, never after a ceremony.
// The secret VALUE is resolved in the handler AFTER a valid pass (it never rides target/preview).
function assertSecretChannelAvailable(ctx: Ctx, parsed: RevenuecatSetInput): void {
  if (parsed["api-key-env"] !== undefined) return;
  const runtime = requireRuntime(ctx);
  if (runtime.isTTY && runtime.promptSecret !== undefined) return;
  throw new CliLocalError("usage_error", { detail: REVENUECAT_SECRET_CONFIG.noChannelDetail });
}

// FORBIDDEN 8 discipline (provider-key/revoke.ts precedent): an etag-less 200 is a contract-
// integrity fault — fail closed pre-prompt with a STATIC error; never omit-if-absent, never guess.
const ETAGLESS_DETAIL =
  "the management API returned the RevenueCat binding without an ETag, so the replace precondition cannot be constructed — this is a server protocol error, not a request you can fix";

/** The three read-DTO config members shown in the replace preview (the key has no read surface). */
function configLine(raw: unknown, member: string): string {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[member];
  return `${member}: ${value === undefined ? "(not reported)" : JSON.stringify(value)}`;
}

/**
 * The dual-mode direct_confirm `prepare` (RC-8, invoked once before any render/prompt). Channel
 * availability → ONE `revenuecat.get` probe → mode fork. Any non-404 probe error propagates
 * untouched; an etag-less 200 fails closed BEFORE any prompt.
 */
export async function prepareRevenuecatSet(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = revenuecatSetArgs.parse(input);
  assertSecretChannelAvailable(ctx, parsed);
  const pid = requireProject(ctx);

  let raw: unknown;
  try {
    raw = await ctx.client.request({ operationId: "revenuecat.get", params: { pid }, captureMeta: true });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      // CREATE mode: no binding yet — no precondition to capture (the handler sends If-None-Match:*).
      return {
        preview: {
          title: "Set the RevenueCat secret API key for this project (prod-rebinding).",
          lines: [
            "no RevenueCat binding exists — this CREATES one (config members get server defaults; entitlement/claim/TTL config is dashboard-managed at this contract version).",
            "the key is validated live against RevenueCat before it is stored.",
          ],
        },
        target: { mode: "create" },
      };
    }
    throw err;
  }

  const etag = readCapturedEtag(raw);
  if (etag === undefined) {
    throw new CliLocalError("usage_error", { detail: ETAGLESS_DETAIL });
  }
  // REPLACE mode: show current state (the server cannot even send the key — masked by omission).
  return {
    preview: {
      title: "Replace the RevenueCat secret API key for this project (prod-rebinding).",
      lines: [
        "a RevenueCat binding EXISTS — this REPLACES its secret API key (full-replace; stored config members are preserved server-side):",
        configLine(raw, "enabled"),
        configLine(raw, "required_entitlement_id"),
        configLine(raw, "user_id_claim"),
        configLine(raw, "cache_ttl_seconds"),
        "the current key cannot be shown (the server never returns it).",
      ],
    },
    ifMatch: etag,
    target: { mode: "replace" },
  };
}

// Race teaching (S-D): a 412 is terminal for THIS invocation — teach the re-run, never auto-retry
// or auto-pivot the mode (FORBIDDEN 8). Static module constants (A2/R13a).
const HINT_412_CREATE =
  "a RevenueCat binding appeared mid-flight — re-run `agkit revenuecat set` (it will now replace the existing key)";
const HINT_412_REPLACE =
  "the RevenueCat binding changed since the preview — re-run `agkit revenuecat set` to review current state";
const HINT_CONFIRM_MISMATCH = "the confirm value is the project's NAME exactly as `agkit project get` shows";

// A2/R12 (the T-218 sync precedent): the upsert parses the SECRET-BEARING body, so a 400/422
// problem could reflect request content (incl. upstream RevenueCat preflight text). Those two
// statuses rebuild ALLOWLISTED (server title/detail/extensions DROPPED; static value-free detail;
// the classified code + CLI hint stay teachable). Everything else keeps the general renderer —
// 401/403 are decided upstream of the payload, 404 reflects nothing, 412 is the header gate, and
// a 5xx is generic AND retryable; scrubbing those would relabel the failure (§B-9).
const STATIC_REJECT_DETAIL =
  "the server rejected the RevenueCat submission (the key or the confirm value was not accepted).";

export const revenuecatSet: CommandHandler<RevenuecatSetInput> = async (ctx, input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    throw new Error("agkit: internal — revenuecat set requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  const mode = pass.target?.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error("agkit: internal — revenuecat set ceremony pass is missing the prepared mode");
  }
  if (mode === "replace" && typeof pass.ifMatch !== "string") {
    throw new Error("agkit: internal — revenuecat set replace pass is missing the prepared If-Match ETag");
  }
  const pid = requireProject(ctx);
  // The secret resolves ONLY after a valid ceremony pass — it never rides target/preview/pass, and
  // it exists solely as the chokepoint-masked `api_key` body member from here to the wire.
  const apiKey = await resolveRevenuecatSecret(ctx, input);

  try {
    const resp = await ctx.client.request({
      operationId: "revenuecat.upsert",
      params: { pid, api_key: apiKey, confirm: pass.confirm },
      preconditions: mode === "create" ? { ifNoneMatch: "*" } : { ifMatch: pass.ifMatch },
    });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError) {
      let hintOverride: string | undefined;
      if (err.problem.status === 412) {
        hintOverride = mode === "create" ? HINT_412_CREATE : HINT_412_REPLACE;
      } else if (err.problem.code === "confirm_mismatch") {
        hintOverride = HINT_CONFIRM_MISMATCH;
      }
      if (err.problem.status === 400 || err.problem.status === 422) {
        throw new PreClassifiedError(
          allowlistedWireErrorEnvelope(err.problem, { staticDetail: STATIC_REJECT_DETAIL, hintOverride }),
        );
      }
      if (hintOverride !== undefined) err.hintOverride = hintOverride;
    }
    throw err;
  }
};
