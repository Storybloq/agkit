// The MCP INPUT GRAMMAR for `provider-key add` / `rotate` (T-227 S5b, ticket req 7 — the ratified
// S5 deviation-of-record that un-excludes both commands over MCP).
//
// WHY THE EXCLUSION FELL. Both specs carried `mcpExclude: "secret-bearing credential write
// (env-name/TTY-prompt channels unavailable to an MCP host)"`. That rationale WAS the gap `SecretRef`
// closes: `{source:"env",name}` / `{source:"file",path}` are exactly an env-name / path indirection an
// MCP host can express, and `{source:"inline",value}` is the honest last resort. So the exclusion
// falls WITH the mechanism that closes it, not before and not after.
//
// WHAT THE MCP CALLER SEES, and what it can never see:
//   • `api_key: SecretRef` — the three-member strict union, projected as a nested union of closed
//     objects. There is NO raw-string secret member on this surface: a caller cannot type the
//     material into a tool argument even by accident, because no member of that type exists.
//   • NO `--api-key-env` / `--api-key-file` / hidden-prompt affordance. Those are the CLI's OPERATOR
//     channels; over MCP the caller is not the operator, and an argument that names an arbitrary env
//     var or path would be a general-purpose read primitive pointed at the operator's machine. The
//     `SecretRef` env/file arms are honored only against the profile's pre-declared `secret_sources`
//     allowlist (`resolveSecretRef` with `channel:"mcp"`), which is writable from the CLI alone.
//   • NO `confirm`. A derived MCP mutation tool is `planOnly`: it CREATES a plan and returns it, and
//     the caller applies it through the gated executor with the plan's own confirm string.
//
// WHY BOTH VERBS ARE PLAN-KIND HERE, including `add`. On the CLI, `provider-key add` is an M-class
// DIRECT write (the wire route `credential.create` is `gating:"direct"`, and T-217 ratified the
// no-ceremony door for it). The MCP surface has no direct write door at all — every derived mutation
// tool is annotated "writes nothing itself; it returns a Plan the gated executor applies" — so
// surfacing `add` with its CLI write path would have made that annotation a lie and handed an MCP
// host the roster's only ungated credential write. The plannable equivalent exists on the wire
// (`provider_credential:create` is an executable CHANGE_TABLE row whose `defName` is the SAME
// `provider_credential_create_request` the direct route takes), so over MCP `add` builds that change
// and the applied plan performs the identical server-side create. Same effect, one more gate.
//
// THE RESOLVED SECRET NEVER LANDS HERE. `dispatch.ts` resolves the reference and registers the value
// in the call's suppression registry BEFORE calling either builder, so what these builders receive is
// already `{api_key: "<the value>"}` — and every surface that could render it subtracts it. The
// builders re-parse defensively (the `rotate.ts` idiom) against the RESOLVED shape, so a caller that
// somehow reached one without the resolution step fails the parse rather than shipping a `[object
// Object]` into a credential body.
import { z } from "zod";
import type { Ctx, McpSecretIntake } from "../types";
import { requireProject } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { buildByoConfig, EXTRA_HEADER_HELP } from "./byo-form";
import { SECRET_REF_INLINE_WARNING, secretRefSchema } from "./secret-ref";
import { MCP_MIN_SECRET_BYTES, resolveSecretRef } from "./secret-env";

/** The optional BYO-endpoint members, identical in KEY and meaning to the CLI flags they mirror —
 *  `buildByoConfig` reads these exact kebab keys, so one form-check serves both surfaces. */
const byoMembers = {
  "endpoint-url": z
    .string()
    .min(1)
    .optional()
    .describe("Custom BYO endpoint: the full endpoint URL (the server owns https-only and egress policy)."),
  "auth-style": z
    .string()
    .min(1)
    .optional()
    .describe("Custom BYO endpoint: the auth style (server-owned closed vocabulary)."),
  "header-name": z
    .string()
    .min(1)
    .optional()
    .describe("Custom BYO endpoint: the auth header name (e.g. api-key)."),
  "extra-header": z.union([z.string(), z.array(z.string())]).optional().describe(EXTRA_HEADER_HELP),
};

/** `provider-key add` over MCP: the provider slug + the secret REFERENCE + the BYO members. */
export const providerKeyAddMcpArgs = z
  .object({
    provider: z.string().min(1).describe("The provider slug to store a credential for (server-owned vocabulary)."),
    api_key: secretRefSchema,
    ...byoMembers,
  })
  .strict();

/** `provider-key rotate` over MCP — the same grammar (the rotate change body IS the create body). */
export const providerKeyRotateMcpArgs = z
  .object({
    provider: z.string().min(1).describe("The provider slug whose credential to rotate."),
    api_key: secretRefSchema,
    ...byoMembers,
  })
  .strict();

/**
 * The POST-RESOLUTION shape both change builders re-parse. It differs from the advertised grammar in
 * exactly one member — `api_key` is the resolved VALUE, not a reference — which is the contract
 * `dispatch.ts` fulfils and the only shape a change body may be built from.
 */
const providerKeyResolvedMcpArgs = z
  .object({
    provider: z.string().min(1),
    api_key: z.string().min(1),
    ...byoMembers,
  })
  .strict();

/**
 * The `SecretRef` intake both verbs declare. ONE object, shared: the policy is a property of the
 * CHANNEL (mcp) and of the ratified floor, never of the verb.
 *
 * `channel:"mcp"` is the trust boundary — env/file are honored only when the operator pre-declared
 * the exact name/path in the active profile's `secret_sources`, checked BEFORE any read, so a
 * hostile caller cannot even probe which variables or paths exist. `minBytes` fails a degenerate
 * "secret" CLOSED, before the wire: a 2-byte value pushed through the suppression machinery would
 * mask ordinary prose in every subsequent render of the call.
 */
export const providerKeyMcpSecret: McpSecretIntake = {
  arg: "api_key",
  resolve: (ctx: Ctx, ref: unknown): string =>
    // Re-parsed here, not trusted from the caller frame: this is the ONE place the reference shape
    // is turned into the resolver's typed input, so a smuggled second source is a parse failure.
    resolveSecretRef(ctx, secretRefSchema.parse(ref), { channel: "mcp", minBytes: MCP_MIN_SECRET_BYTES }),
};

/**
 * `provider-key add` over MCP → the `provider_credential:create` plan change (CHANGE_TABLE row
 * `credential.create`, `defName: provider_credential_create_request`). The body is the SAME document
 * the CLI's direct call sends — `{provider, api_key, …BYO when flagged}` — so the applied plan and
 * the direct write are byte-equivalent at the server's own handler.
 */
export function providerKeyAddMcpChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = providerKeyResolvedMcpArgs.parse(input);
  return [
    {
      action: "create",
      resource: "provider_credential",
      path: renderRoutePath("credential.create", { pid: requireProject(ctx) }),
      body: { provider: parsed.provider, api_key: parsed.api_key, ...buildByoConfig(parsed) },
    },
  ];
}

/**
 * `provider-key rotate` over MCP → the `provider_credential:update` change at the CONCRETE
 * `credential.rotate` route path. Structurally identical to the CLI builder (`rotate.ts`), which
 * differs only in WHERE its secret came from — the operator's flag/prompt instead of a `SecretRef`.
 */
export function providerKeyRotateMcpChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = providerKeyResolvedMcpArgs.parse(input);
  return [
    {
      action: "update",
      resource: "provider_credential",
      path: renderRoutePath("credential.rotate", { pid: requireProject(ctx), provider: parsed.provider }),
      body: { provider: parsed.provider, api_key: parsed.api_key, ...buildByoConfig(parsed) },
    },
  ];
}

/**
 * The tool descriptions. Both MUST reproduce `SECRET_REF_INLINE_WARNING` verbatim (req 7: "Tool
 * descriptions warn that inline places the secret in conversation context") — asserted by the tool
 * suite, and the reason the warning is an exported constant rather than prose typed twice.
 */
export const PROVIDER_KEY_ADD_MCP_SUMMARY =
  "Plan storing a provider credential. Prefer a NAMED secret: pass api_key as " +
  `{source:"env",name} or {source:"file",path} (both must be pre-declared by the operator with ` +
  `\`agkit secret-source add\`) so the caller never carries the material; {source:"inline",value} ` +
  `is the last resort and DOES carry it. NOTE: ${SECRET_REF_INLINE_WARNING} ` +
  "Returns a plan; apply it with agkit_apply.";

export const PROVIDER_KEY_ROTATE_MCP_SUMMARY =
  "Plan rotating a provider credential to a NEW key (prod-rebinding). Prefer a NAMED secret: pass " +
  `api_key as {source:"env",name} or {source:"file",path} (both must be pre-declared by the operator ` +
  `with \`agkit secret-source add\`) so the caller never carries the new material; ` +
  `{source:"inline",value} is the last resort and DOES carry it. ` +
  `NOTE: ${SECRET_REF_INLINE_WARNING} Returns a plan; apply it with agkit_apply.`;

/**
 * The canonical MCP call arguments for each verb (the `mcpSurface.example` the registry load-check
 * parses and the full-surface MCP sweeps drive). INLINE deliberately: it is the one source that needs
 * no pre-existing operator declaration, so the example is driveable in a hermetic environment — and
 * the value is a self-describing placeholder well over the 16-byte MCP floor.
 */
const EXAMPLE_INLINE_REF = { source: "inline", value: "example-inline-provider-key" } as const;

export const PROVIDER_KEY_ADD_MCP_EXAMPLE: Record<string, unknown> = {
  provider: "example-llm",
  api_key: EXAMPLE_INLINE_REF,
};

export const PROVIDER_KEY_ROTATE_MCP_EXAMPLE: Record<string, unknown> = {
  provider: "example-llm",
  api_key: EXAMPLE_INLINE_REF,
};
