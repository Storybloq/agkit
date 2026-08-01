// `voice-identity set <key> --provider <p>` — the secret-bearing dual-mode direct_confirm
// ceremony (T-220 §3 as amended by AM-0a + r2b-2 + r2c-1..3; wire `identity.upsert` = PUT,
// gating direct_confirm, danger PR, idempotency required, secret_bearing request). NOT plannable:
// `voice_identity:create`/`:update` are executable:false in the CHANGE_TABLE (the server
// validates the resource LIVE against the provider — external, non-transactional).
//
// SECRET CUSTODY (r2b-2 — supersedes AM-7 R-E2): the resource id NEVER rides argv. There is NO
// `resource-id` args key at all — the value enters by exactly two out-of-band channels through
// the B0 `resolveWireSecret` resolver: `--resource-id-env <VAR>` (env-NAME indirection; the flag
// carries a non-secret variable NAME) or a hidden TTY prompt. Resolution happens in the HANDLER,
// AFTER prepare + the typed ceremony (r2c-3): a probe failure, an etag-less rebind, or a confirm
// mismatch terminates with promptSecret UNCALLED. Channel AVAILABILITY is asserted in prepare —
// before any wire read — so a channel-less invocation fails static + zero-wire.
//
// Dual-mode preconditions (AM-0a; identity.upsert ∈ B0 DUAL_MODE_CONDITIONAL_OPS): the engine
// REJECTS a header-less PUT (invalid_header), so prepare MODE-DETECTS via ONE same-family
// `identity.get` probe: 404 ⇒ create (`If-None-Match: *`), 200 ⇒ rebind (`If-Match: <etag>`,
// captured ETag REQUIRED — fail closed BEFORE any prompt). D3: the typed confirm is the identity
// KEY (server-verified, direct-confirm.ts:494-499) — known client-side, so `expectedConfirm =
// key` gives the local RC-2 pre-send check with zero extra reads.
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

export const voiceIdentitySetArgs = z
  .object({
    key: z.string().min(1).describe("Identity key (the row's natural key; also the typed confirm value)."),
    provider: z.string().min(1).describe("Provider owning this identity (user-supplied; validation is server-owned)."),
    "resource-id-env": z
      .string()
      .min(1)
      .optional()
      .describe("NAME of an environment variable holding the provider resource id (never the id itself)."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The identity KEY, to confirm (required non-interactively; checked locally and by the server)."),
  })
  .strict();
export type VoiceIdentitySetInput = z.infer<typeof voiceIdentitySetArgs>;

// The resource-id secret-channel configuration (B0 `resolveWireSecret`; T-217 R-H #2 discipline:
// EVERY message is a STATIC constant — zero interpolation of any value or var-name on any branch).
const RESOURCE_ID_SECRET_CONFIG: WireSecretConfig = {
  envArg: "resource-id-env",
  promptQuestion: "Paste the provider resource id (input hidden): ",
  emptyDetail: "no resource id provided.",
  noChannelDetail:
    "provide --resource-id-env <VAR_NAME> (non-interactive), or run in an interactive terminal for a hidden prompt.",
  grammarDetail:
    "--resource-id-env takes the NAME of an environment variable (letters, digits, underscore; not starting with a digit). Export the resource id first (e.g. export MY_VOICE_RESOURCE_ID=...) and pass the variable's NAME.",
  missingEnvDetail: "the environment variable named by --resource-id-env is not set or is empty in this shell.",
};

/** Resolve the resource id (r2b-2 channels): flag-wins → hidden TTY prompt → static channel error. */
export function resolveVoiceIdentityResourceId(ctx: Ctx, parsed: VoiceIdentitySetInput): Promise<string> {
  return resolveWireSecret(ctx, parsed, RESOURCE_ID_SECRET_CONFIG);
}

// Channel AVAILABILITY is asserted in prepare — BEFORE the probe and BEFORE the typed prompt — so
// a non-TTY invocation with no --resource-id-env fails static + zero-wire, never after a ceremony.
function assertSecretChannelAvailable(ctx: Ctx, parsed: VoiceIdentitySetInput): void {
  if (parsed["resource-id-env"] !== undefined) return;
  const runtime = requireRuntime(ctx);
  if (runtime.isTTY && runtime.promptSecret !== undefined) return;
  throw new CliLocalError("usage_error", { detail: RESOURCE_ID_SECRET_CONFIG.noChannelDetail });
}

// AM-0a: an etag-less 200 in rebind mode fails closed BEFORE any prompt — static contract error.
const ETAGLESS_DETAIL =
  "the management API returned this voice identity without an ETag, so the rebind precondition cannot be constructed — this is a server protocol error, not a request you can fix";

/** A current-state preview line from the probe DTO (server values ride the ceremony's displaySafe
 *  chokepoint; the DTO is the resourceId-free projection — F5). */
function stateLine(raw: unknown, member: string): string {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[member];
  return `current ${member}: ${value === undefined ? "(not reported)" : JSON.stringify(value)}`;
}

/**
 * The dual-mode direct_confirm `prepare` (AM-0a mode detection; r2c-3: NO secret resolution here —
 * the preview is secret-free by construction). Channel availability → ONE `identity.get` probe →
 * mode fork. Any non-404 probe error propagates untouched.
 */
export async function prepareVoiceIdentitySet(ctx: Ctx, input: unknown): Promise<DirectConfirmPrepared> {
  const parsed = voiceIdentitySetArgs.parse(input);
  assertSecretChannelAvailable(ctx, parsed);
  const pid = requireProject(ctx);

  const sharedLines = [
    `key: ${parsed.key}`,
    `provider: ${parsed.provider}`,
    "resource id: (provided out-of-band — never displayed)",
    "enabled after set: true (PUT-replace; use `agkit voice-identity disable` to turn it off)",
    "the server validates the resource against the live provider before the binding becomes valid",
  ];

  let raw: unknown;
  try {
    raw = await ctx.client.request({
      operationId: "identity.get",
      params: { pid, provider: parsed.provider, key: parsed.key },
      captureMeta: true,
    });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      return {
        preview: {
          title: "Bind a voice identity (prod-rebinding).",
          lines: ["creates a NEW voice identity binding", ...sharedLines],
        },
        expectedConfirm: parsed.key,
        target: { provider: parsed.provider, key: parsed.key, mode: "create" },
      };
    }
    throw err;
  }

  const etag = readCapturedEtag(raw);
  if (etag === undefined) {
    throw new CliLocalError("usage_error", { detail: ETAGLESS_DETAIL });
  }
  return {
    preview: {
      title: "Bind a voice identity (prod-rebinding).",
      lines: [
        "re-binds a LIVE voice identity: replaces the existing binding",
        stateLine(raw, "enabled"),
        stateLine(raw, "validation_status"),
        ...sharedLines,
      ],
    },
    expectedConfirm: parsed.key,
    ifMatch: etag,
    target: { provider: parsed.provider, key: parsed.key, mode: "replace" },
  };
}

// Race teaching (S-D precedent): a 412 is terminal for THIS invocation — teach the re-run, never
// auto-retry or auto-pivot the mode. Static module constants.
const HINT_412_CREATE =
  "a voice identity appeared under this key mid-flight — re-run `agkit voice-identity set` (it will now re-bind, reviewing current state)";
const HINT_412_REPLACE =
  "the voice identity changed since the preview — re-run `agkit voice-identity set` to review current state";

// A2/R12: the upsert parses the SECRET-BEARING body, so a 400/422 problem could reflect request
// content. Those two statuses rebuild ALLOWLISTED (server strings DROPPED; static value-free
// detail; the classified code + CLI hint stay teachable). Everything else keeps the general
// renderer (401/403/404/412/5xx reflect nothing from the payload — scrubbing them would relabel
// the failure, §B-9).
const STATIC_REJECT_DETAIL =
  "the server rejected the voice-identity submission (the resource id or the confirm value was not accepted).";

export const voiceIdentitySet: CommandHandler<VoiceIdentitySetInput> = async (ctx, input) => {
  const pass = ctx.ceremony;
  if (pass === undefined || pass.kind !== "direct") {
    throw new Error("agkit: internal — voice-identity set requires a direct_confirm ceremony pass on ctx.ceremony");
  }
  const mode = pass.target?.mode;
  if (mode !== "create" && mode !== "replace") {
    throw new Error("agkit: internal — voice-identity set ceremony pass is missing the prepared mode");
  }
  if (mode === "replace" && typeof pass.ifMatch !== "string") {
    throw new Error("agkit: internal — voice-identity set rebind pass is missing the prepared If-Match ETag");
  }
  // TOCTOU close: provider/key come from the PREPARED target the operator confirmed against —
  // never re-read from input.
  const provider = pass.target?.provider;
  const key = pass.target?.key;
  if (typeof provider !== "string" || typeof key !== "string") {
    throw new Error("agkit: internal — voice-identity set ceremony pass is missing its prepared target");
  }
  const pid = requireProject(ctx);
  const parsed = voiceIdentitySetArgs.parse(input);
  // r2c-3: the secret resolves ONLY here — after prepare AND a passed ceremony. It never rides
  // target/preview/pass, and exists solely as the outbound `resource_id` body member.
  const resourceId = await resolveVoiceIdentityResourceId(ctx, parsed);

  try {
    const resp = await ctx.client.request({
      operationId: "identity.upsert",
      params: { pid, provider, key, resource_id: resourceId, confirm: pass.confirm },
      preconditions: mode === "create" ? { ifNoneMatch: "*" } : { ifMatch: pass.ifMatch },
    });
    return { data: resp };
  } catch (err) {
    if (err instanceof WireProblemError) {
      let hintOverride: string | undefined;
      if (err.problem.status === 412) {
        hintOverride = mode === "create" ? HINT_412_CREATE : HINT_412_REPLACE;
      } else if (err.problem.code === "limit_exceeded") {
        // R-V1: ext.limit rides the hint ONLY when it is a safe non-negative integer.
        const limit = (err.problem.ext as { limit?: unknown } | undefined)?.limit;
        const limitPart =
          typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 ? ` (limit ${limit})` : "";
        hintOverride = `voice identity cap reached for your plan${limitPart} — see \`agkit billing plans\` or remove an identity`;
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
