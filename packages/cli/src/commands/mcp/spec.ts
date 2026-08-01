// The `mcp` noun (T-222, canonical L2-CLI-20). `mcp serve` is the in-process MCP server handoff —
// the registry's ONE stdout-takeover citizen, a registry row (not a side-door) so
// reference/help/drift-lock see it, while `mcpExclude` keeps it out of the MCP tool projection (a
// server cannot be its own tool) and `stdoutTakeover` routes it through the stderr-only dispatch
// class. Housekeeping is already exempt for the `mcp` path (core/housekeeping/exempt.ts).
//
// T-228 adds `mcp doctor` — the triage instrument for the same integration — and `mcp print-config`
// — the registration snippets for it. ARRAY ORDER IS CATALOG ORDER (ruling PR-5): `serve` (the
// primary door) first, then `doctor`, then `print-config`. Only `serve` takes over stdout; the
// other two are ordinary envelope-emitting commands.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { mcpDoctor, mcpDoctorArgs } from "./doctor";
import { mcpPrintConfig, mcpPrintConfigArgs } from "./print-config";
import { mcpServe, mcpServeArgs } from "./serve";

/**
 * The exclusion REASON, exported beside the spec it protects (the `SETUP_MCP_EXCLUDE` precedent —
 * the rationale travels with the code that depends on it, and the golden's `reason` field is this
 * string verbatim).
 *
 * THE ORACLE ARGUMENT, at the transport level. `mcp doctor` diagnoses the MCP integration.
 * Reachable as a tool OF THE SERVER IT DIAGNOSES, it is not an oracle: a server that cannot start
 * can never report that it cannot start, and every "the integration works" verdict it returns over
 * that transport is trivially confirmed by the fact that the call arrived at all. The oracle must
 * be invocable from OUTSIDE the subject — from the shell, by the human or the agent's own bash.
 */
export const MCP_DOCTOR_MCP_EXCLUDE =
  "the MCP integration's own oracle: a diagnostic reachable as a tool of the server it diagnoses cannot report that server failing to start, and every verdict it returns over that transport is self-confirming — run it from the shell, never as an agent tool";

/**
 * The exclusion REASON for `mcp print-config`, exported beside the spec it protects (same
 * `SETUP_MCP_EXCLUDE` precedent — the golden's `reason` field is this string verbatim).
 *
 * THE CIRCULARITY ARGUMENT. Every `execution:"local"` command in the registry is excluded and
 * there is no local exception; this one earns it twice over. An MCP host that could call this tool
 * has ALREADY spawned this server — so it already holds the registration the answer describes, and
 * the answer is circular. And the answer's payload is the absolute on-disk path of the binary the
 * host launched: a machine-layout fingerprint handed back to an agent for no benefit at all. The
 * paste path is a human at a shell, which is where the snippets are useful.
 */
export const MCP_PRINT_CONFIG_MCP_EXCLUDE =
  "cross-cutting local command: prints THIS server's own client-registration snippets, baking the absolute path of the binary the host already spawned — circular over MCP, and a machine-layout fact a tool has no reason to hand back; not a management resource tool";

export const mcpCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "mcp",
    verb: "serve",
    summary: "Run the agkit MCP server on stdio (stdout carries protocol frames only).",
    args: mcpServeArgs,
    scopes: [], // the server authenticates per-tool-call, never at process start
    danger: "SR",
    outputSchemaId: outputSchemaId("mcp", "serve"),
    examples: ["agkit mcp serve"],
    handler: mcpServe,
    execution: "local", // the handoff itself makes no management call
    mcpExclude: "self-hosting paradox — the MCP server cannot be an MCP tool",
    stdoutTakeover: "MCP stdio protocol owns stdout — frames only",
  }),
  defineCommand({
    noun: "mcp",
    verb: "doctor",
    summary: "Diagnose the MCP integration: client registration, credential, server, contract version.",
    args: mcpDoctorArgs,
    scopes: [], // the ONE probe is an UNAUTHENTICATED discovery.get; the credential is only REPORTED
    danger: "SR", // zero writes anywhere (selftest is M only because of its live plan write probe)
    outputSchemaId: outputSchemaId("mcp", "doctor"),
    // reference.md renders NO flag descriptions — the example fence is the ONLY place `--offline`
    // reaches the shipped skill docs, so it appears here deliberately.
    examples: ["agkit mcp doctor", "agkit mcp doctor --offline"],
    handler: mcpDoctor,
    // `remote`: it sends `discovery.get` by DEFAULT. `--offline` does not change the declaration —
    // `execution` describes the command's CLASS, not one invocation (the `selftest` precedent).
    execution: "remote",
    mcpExclude: MCP_DOCTOR_MCP_EXCLUDE,
    // NO `stdoutTakeover`: `mcp serve` stays the registry's sole claimant, which is what keeps
    // `mcp/print-config.ts`'s fail-closed "exactly one takeover spec" assertion honest.
  }),
  defineCommand({
    noun: "mcp",
    verb: "print-config",
    summary:
      "Print the MCP client registration snippets for this machine (absolute binary path baked in); add --json to pipe them.",
    args: mcpPrintConfigArgs,
    scopes: [], // it renders local facts; there is no resource to be authorized against
    danger: "SR", // it writes nothing at all — `agkit setup` is the writer
    outputSchemaId: outputSchemaId("mcp", "print-config"),
    // ONE example, and no `--json` form: `splitExample` folds every `--flag` in an example into the
    // INPUT it validates against `args`, so a global-flag example would fail this spec's
    // `.strict()` schema at registry load. The machine path is taught by the summary, not here.
    examples: ["agkit mcp print-config"],
    handler: mcpPrintConfig,
    execution: "local", // resolution + rendering; not one management call
    mcpExclude: MCP_PRINT_CONFIG_MCP_EXCLUDE,
    // NO `stdoutTakeover` — see the `doctor` note above; `mcp serve` stays the sole claimant.
  }),
];
