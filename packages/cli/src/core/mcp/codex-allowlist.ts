// T-224 D6 — the Codex per-tool approval allowlist, DERIVED from the advertised roster.
//
// WHAT THIS IS FOR. `agkit setup --client codex` writes `[mcp_servers.agkit.tools.<tool>]` /
// `approval_mode = "approve"` tables so a Codex operator does not have to hand-approve every
// harmless read. The set of tools that may carry that pre-approval is exactly the READ-ONLY
// roster: pre-approving anything that can write is the one thing this generator may never do
// (T-224 FORBIDDEN), because an approval table is a standing consent the user never re-sees.
//
// DERIVED, NEVER CURATED — and derived from the SAME evidence the read-boundedness suite keys on:
// a tool is a read tool when its OWN advertised annotation says `readOnlyHint:true`
// (`read-boundedness.test.ts` `readToolNames()`, verbatim rule). Two consequences that are the
// whole point:
//   • a future read tool joins the allowlist the day it is advertised, with no edit here;
//   • a tool that stops being read-only DROPS OUT the same day — the allowlist cannot outlive the
//     annotation that justified it.
// The `*_read` naming convention and the one local instrument (`agkit_status`) are CORROBORATION
// in the test, never the derivation, and no display table (`print-config`, `reference.md`) is ever
// a seed: those render the surface, they do not define it.
//
// This module is imported by the `setup` command layer ONLY — deliberately not by
// `registration.ts`, whose detection path runs on every CLI invocation and must not pull the whole
// tool compiler onto that hot path.
import { CANONICAL_TOOLS, type McpToolDef } from "../../mcp/tool-defs";

/**
 * The tools `setup --client codex` may pre-approve: every advertised tool whose annotation asserts
 * `readOnlyHint:true`, in the canonical roster order (already sorted by name).
 *
 * `tools` is injectable ONLY so the negative control can feed a mutated roster copy and prove the
 * filter binds to the annotations rather than to a name pattern; production always uses the
 * frozen canonical roster.
 */
export function codexReadOnlyApprovalTools(tools: readonly McpToolDef[] = CANONICAL_TOOLS.tools): string[] {
  return tools.filter((tool) => tool.annotations.readOnlyHint === true).map((tool) => tool.name);
}
