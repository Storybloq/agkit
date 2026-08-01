// `provider-key rotate` args + plan-change builder (T-217 step 3; credential.rotate,
// provider-keys:write, danger PR, gating plan_required). Plan→apply is the ONLY legal write path;
// the spec's `mutation: {kind:"plan"}` runs the fused ceremony and the shared `planMutationHandler`
// applies the pass. Server-side, rotate = revoke-active + insert-new in ONE tx.
//
// [codex F1 CRITICAL, byte-verified] The server CHANGE_TABLE's `provider_credential:update` row
// REUSES `provider_credential_create_request` for rotate — the change body is therefore
// `{provider, api_key}` (BOTH members required; a body of `{api_key}` alone fails Ajv at
// plan.create). The rotate.test.ts body assertion is CONTRACT-DERIVED from the $def's own
// `required`/`properties`, never a hand-typed list.
//
// [R-D] The builder is ASYNC: it awaits the secret (env indirection or the echo-off TTY prompt)
// BEFORE returning changes — so no network write (plan.create) precedes secret resolution. The
// ceremony's ONE call site awaits (`PlanMutation.changes` widened to allow a Promise).
//
// [R-B] The same BYO flags as `add` ride the rotate body through the SAME byo-form checks. D8
// caveat (design-track, RR-7b): rotate config carry-forward semantics are SERVER-owned — the CLI
// does NOT invent client-side preserve logic.
//
// `--plan-only` works: the material rides the plan change body server-side (encrypted;
// `(secret)`-masked diffs); a later `agkit apply <plan-id>` re-reads nothing.
import { z } from "zod";
import type { Ctx } from "../types";
import { requireProject } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { resolveProviderKeySecret } from "./secret-env";
import { buildByoConfig, EXTRA_HEADER_HELP } from "./byo-form";

export const providerKeyRotateArgs = z
  .object({
    provider: z.string().min(1).describe("The provider slug whose credential to rotate."),
    "api-key-env": z
      .string()
      .min(1)
      .optional()
      .describe("Name of the env var holding the NEW API key (the CLI reads process.env[VAR]; the key never rides argv)."),
    // T-227 R7: the FILE channel (see add.ts). Mutually exclusive with `--api-key-env`.
    "api-key-file": z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a file whose CONTENT is the NEW API key (regular file, chmod 600, POSIX only; one trailing newline is stripped). Mutually exclusive with --api-key-env.",
      ),
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
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict();
export type ProviderKeyRotateInput = z.infer<typeof providerKeyRotateArgs>;

/**
 * The ASYNC change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call
 * order — resolves the secret (env or prompt) BEFORE any wire call, form-checks the BYO members,
 * and realizes the CHANGE_TABLE's rotate shape: an `update` on `provider_credential` at the
 * CONCRETE credential.rotate route path, body `{provider, api_key, …BYO when flagged}`.
 */
export async function providerKeyRotateChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = providerKeyRotateArgs.parse(input);
  const apiKey = await resolveProviderKeySecret(ctx, parsed);
  const byo = buildByoConfig(parsed);
  return [
    {
      action: "update",
      resource: "provider_credential",
      path: renderRoutePath("credential.rotate", { pid: requireProject(ctx), provider: parsed.provider }),
      // BOTH required members (the rotate $def is the create $def — codex F1): provider from the
      // SAME parsed input as the path param; the secret exists ONLY here (chokepoint-masked).
      body: { provider: parsed.provider, api_key: apiKey, ...byo },
    },
  ];
}
