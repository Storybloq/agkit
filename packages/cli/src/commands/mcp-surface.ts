// The per-command MCP-SURFACE OVERRIDE (T-227 S5b, ticket req 7). One optional `CommandSpec`
// field, consumed by exactly two modules — the tool-definition compiler (`src/mcp/tool-defs.ts`,
// which projects `args` into the advertised `inputSchema` and `summary` into the description) and
// the dispatch table (`src/mcp/dispatch.ts`, which parses with `args`, resolves `secret`, and runs
// `mutation`). The CLI shell never reads it, so declaring one CANNOT move a byte of the CLI surface.
//
// WHY A SURFACE OVERRIDE AND NOT A SECOND SPEC. The MCP projection is normally the IDENTITY on a
// command's own zod args: whatever the CLI validates, the tool advertises. That is right for every
// command whose inputs are values. It is wrong for exactly one class — a command whose secret
// arrives through a CHANNEL rather than as a value:
//
//   • On the CLI the operator names the channel (`--api-key-env VAR` / `--api-key-file PATH`) or
//     types the secret at an echo-off prompt. All three are OPERATOR authority.
//   • Over MCP the caller is not the operator and has no terminal, so those three members are
//     meaningless affordances — and a raw-string secret member would make the secret a tool
//     ARGUMENT, i.e. a value every MCP host logs, caches and replays. Req 7 freezes the alternative:
//     the caller sends a `SecretRef` OBJECT and the local server resolves it process-side.
//
// So the two surfaces genuinely need different INPUT GRAMMARS over the same command. The override
// declares that difference in ONE place, on the spec itself, instead of teaching `dispatch.ts`
// about any particular noun (which would put a filesystem-reading resolver in the MCP module graph
// and make the closed allowlist a router again).
//
// WHAT IT MAY NEVER DO: replace the HANDLER. `entry.spec.handler` stays the exact registry object on
// both surfaces (same-handler-identity.test.ts) — a command that must behave differently under a
// plan pass reads `ctx.ceremony`, which is the documented seam for exactly that.
import type { ZodType } from "zod";
import type { Ctx, PlanMutation } from "./types";

/**
 * The SecretRef intake of one MCP branch (req 7). `dispatch.ts` reads `input[arg]`, calls `resolve`
 * BEFORE any request structure is built, registers the returned value in the call's suppression
 * registry, and hands the handler an input whose `arg` member is the RESOLVED value.
 *
 * `resolve` is the command's own — it owns the policy (`channel:"mcp"`, the minimum-byte floor, the
 * operator allowlist) and it is the only place the reference shape is re-parsed. It is SYNCHRONOUS
 * on purpose: every MCP-honored source (inline value, declared env name, declared file) is readable
 * without a network round-trip, so a resolution can never sit between the auth gate and the wire.
 */
export interface McpSecretIntake {
  /** The advertised argument key carrying the `SecretRef` object (e.g. `api_key`). */
  readonly arg: string;
  /** Resolve the reference process-side. Returns the secret VALUE; throws a typed refusal. */
  readonly resolve: (ctx: Ctx, ref: unknown) => string;
}

/**
 * The MCP projection of ONE command, when it differs from the CLI's.
 *
 * `args`     — the schema the tool ADVERTISES and the schema dispatch PARSES with. One authority for
 *              both, exactly as `spec.args` is on the CLI; `.strict()` is required (the compiler
 *              refuses a non-strict branch).
 * `summary`  — the tool-description contribution. Separate from `spec.summary` because the MCP text
 *              must teach the MCP grammar (and carry `SECRET_REF_INLINE_WARNING`), while the CLI
 *              summary teaches flags that do not exist here.
 * `example`  — ONE canonical call-argument object (routing members excluded). The registry
 *              load-check parses it against `args`, so the MCP grammar carries the same
 *              "every example parses" invariant the CLI examples do, and the full-surface MCP sweeps
 *              have a driveable input for a branch whose CLI examples do not typecheck here.
 * `secret`   — the SecretRef intake, when this branch takes one.
 * `mutation` — the MCP-only write path. The MCP surface is PLAN-FIRST by construction (every derived
 *              mutation tool returns a Plan the gated executor applies), so a command the CLI runs
 *              through the wire's `direct` door declares its plannable equivalent HERE rather than
 *              becoming the one tool that writes with no plan/apply gate. Restricted to `kind:"plan"`
 *              by the registry load-check.
 */
export interface McpSurface {
  readonly args: ZodType<unknown>;
  readonly summary: string;
  readonly example: Record<string, unknown>;
  readonly secret?: McpSecretIntake;
  readonly mutation?: PlanMutation;
}
