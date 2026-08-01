// `provider-key add` handler (T-217 step 2; credential.create, provider-keys:write, danger M).
// A NON_CEREMONY_REMOTE_MUTATION (M-class direct — token-create precedent): the wire route is
// gating:"direct", so there is NO plan/apply and NO typed-confirm ceremony (the PROD-REBINDING
// banner fires only on the PR plan ceremonies). The secret enters ONLY via env-name indirection
// (`--api-key-env`) or the TTY hidden prompt (secret-env.ts) — never argv (FORBIDDEN: no raw-key
// flag). Optional openai-compatible BYO members ride the body when their flags are present
// (byo-form.ts: FORM + structural transport-safety only; provider POLICY is server-owned).
//
// Secret confinement: the resolved key exists in exactly ONE place — the `api_key` body member,
// masked by field name at the redaction chokepoint. It never appears in argv, in a reconstructed
// invocation (there is no raw-key flag to reproduce), or in any error. The response carries a
// `masked_secret` only (reads never carry material), passed through verbatim.
import { z } from "zod";
import type { CommandHandler } from "../types";
import { requireProject } from "../types";
import { planMutationHandler } from "../plan/apply";
import { resolveProviderKeySecret } from "./secret-env";
import { buildByoConfig, EXTRA_HEADER_HELP } from "./byo-form";

export const providerKeyAddArgs = z
  .object({
    provider: z.string().min(1).describe("The provider slug to store a credential for (server-owned vocabulary)."),
    // `api-key-env` is OPTIONAL — a TTY hidden prompt is the interactive fallback (absence + non-TTY
    // errors at resolution, §3A.4). It names an ENV VAR; the raw key is NEVER a flag value.
    "api-key-env": z
      .string()
      .min(1)
      .optional()
      .describe("Name of the env var holding the API key (the CLI reads process.env[VAR]; the key never rides argv)."),
    // T-227 R7: the FILE channel. Mutually exclusive with `--api-key-env` (naming a secret twice is
    // ambiguous intent). The file must be a regular, owner-only (mode 600) file whose parents are
    // not group/other-writable; POSIX only.
    "api-key-file": z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a file whose CONTENT is the API key (regular file, chmod 600, POSIX only; one trailing newline is stripped). Mutually exclusive with --api-key-env.",
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
  })
  .strict();
export type ProviderKeyAddInput = z.infer<typeof providerKeyAddArgs>;

export const providerKeyAdd: CommandHandler<ProviderKeyAddInput> = async (ctx, input) => {
  // T-227 S5b — ONE handler, two write authorities, chosen by the pass the dispatch hook resolved.
  // A ceremony pass exists here ONLY on the MCP surface (this spec declares no `spec.mutation`, so
  // `build-cli.runSpec` never resolves one and the CLI path below is byte-unchanged); over MCP the
  // surface declares a plan binding, the ceremony has already created the plan carrying this
  // credential, and applying it is the plan subsystem's job — performing the direct write here as
  // well would execute the mutation TWICE. Reading `ctx.ceremony` is the documented handler seam
  // for exactly this, and it keeps ONE handler object reachable from both surfaces (test 9).
  if (ctx.ceremony?.kind === "plan") return planMutationHandler(ctx, input);
  const pid = requireProject(ctx);
  // Resolve the secret BEFORE the wire call (env indirection or the hidden prompt). Form-check the
  // BYO members (static rejections; folded header names) — POLICY stays server-side.
  const apiKey = await resolveProviderKeySecret(ctx, input);
  const byo = buildByoConfig(input);
  const data = await ctx.client.request({
    operationId: "credential.create",
    // pid is the path param; provider + api_key + the (present-only) BYO members are the body. The
    // client auto-adds the required Idempotency-Key.
    params: { pid, provider: input.provider, api_key: apiKey, ...byo },
  });
  return { data };
};
