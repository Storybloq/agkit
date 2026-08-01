// Client-side agent-profile / tool id resolution (T-218 §3.2, D-7). The management
// `profile.get` / `tool.get` / `tool.update` / `tool.delete` routes take a UUID {id} path
// param ONLY — a non-UUID path segment is a uniform server 404 (realization.ts UUID_RE guards).
// There is NO server-side slug lookup on those routes. This module lets an operator pass a full
// UUID OR the human slug/tool_name and resolves it to exactly one id, entirely client-side:
//
//   1. a full UUID passes through directly (NO list call) — the operator already named the row.
//   2. anything else is a SLUG (`tool_name` for tools), matched by EXACT equality over the parent
//      list read. `profile.list` and `tool.list` are `paginated:false` (the route rows are
//      authoritative), so ONE request returns the complete set — no drain, no cursor. That set is
//      read through `readCompleteList`: a shape-invalid OR truncated (`has_more:true`) envelope is
//      a TERMINAL protocol error, never a silently-empty set — otherwise a server fault would
//      teach "no agent profile with slug 'x'" for a profile that demonstrably exists.
//
// Same-family reads only (the agents ladder: write-implies-read), so resolving a slug for a
// write command performs one extra `agents:read` list, never a cross-family prefetch. A miss is a
// teachable `usage_error` (the closed CLI-local set is honored — no new code); the server's UNIQUE
// (project_id, slug) / (profile_id, tool_name) indexes make a >1 match impossible (an internal
// assert-and-throw, never a user-facing ambiguity here — unlike token prefixes, these are EXACT).
//
// Value confinement (A-1/A-7): a miss names the STRUCTURAL class + a teachable next command, never
// interpolates the raw slug beyond the single quoted echo the operator themselves typed on argv
// (their own input in their own terminal — not file-derived content, and terminal-safe through the
// serializer chokepoint).
import type { Ctx } from "../types";
import { requireProject } from "../types";
import { CliLocalError } from "../../core/errors";
import { readCompleteList } from "../../core/client/paginate";
import { isUuid } from "../token/resolve";

/** The string value of a raw DTO field, or `undefined` when absent/non-string/empty. */
function stringField(raw: unknown, field: string): string | undefined {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const value = r[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The raw `id` of a row IFF it is a valid UUID (resolution must return a real, server-addressable
 *  id — never a placeholder or a non-UUID). */
function rowId(raw: unknown): string | undefined {
  const id = stringField(raw, "id");
  return id !== undefined && isUuid(id) ? id : undefined;
}

/**
 * Resolve `value` (a full UUID or an agent-profile `slug`) to exactly one profile id for the
 * effective project. A UUID passes through with NO list call; a slug is matched by EXACT equality
 * over ONE `profile.list`. Throws a teachable `CliLocalError` (usage_error) on a miss — never a
 * guessed id.
 */
export async function resolveAgentId(ctx: Ctx, value: string): Promise<string> {
  if (isUuid(value)) return value;

  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "profile.list", params: { pid } });

  const matches: string[] = [];
  for (const raw of readCompleteList(page)) {
    const id = rowId(raw);
    if (id !== undefined && stringField(raw, "slug") === value) matches.push(id);
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length >= 2) {
    // The server's UNIQUE (project_id, slug) index makes this impossible for well-formed live data;
    // if it ever occurs the listing is untrustworthy — refuse rather than guess.
    throw new Error(
      "agkit: internal — more than one agent profile reported the same slug (the server's unique index should forbid this)",
    );
  }
  throw new CliLocalError("usage_error", {
    detail: `no agent profile with slug '${value}' in this project`,
    hint: "agkit agent list",
  });
}

/**
 * Resolve `value` (a full UUID or a `tool_name`) to exactly one tool id WITHIN `profileId`. A UUID
 * passes through with NO list call; a tool_name is matched by EXACT equality over ONE `tool.list`
 * for the parent profile. A parent that does not exist surfaces the server's honest parent-404 (the
 * `tool.list` request throws it — ISS-190). Throws a teachable `usage_error` on a tool miss.
 */
export async function resolveToolId(ctx: Ctx, profileId: string, value: string): Promise<string> {
  if (isUuid(value)) return value;

  const pid = requireProject(ctx);
  const page = await ctx.client.request({ operationId: "tool.list", params: { pid, id: profileId } });

  const matches: string[] = [];
  for (const raw of readCompleteList(page)) {
    const id = rowId(raw);
    if (id !== undefined && stringField(raw, "tool_name") === value) matches.push(id);
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length >= 2) {
    throw new Error(
      "agkit: internal — more than one tool reported the same tool_name in one profile (the server's unique index should forbid this)",
    );
  }
  throw new CliLocalError("usage_error", {
    detail: `no tool named '${value}' on that agent profile`,
    hint: "agkit agent-tool list --agent <slug>",
  });
}
