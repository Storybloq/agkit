// THE ratified MCP error vocabulary and tier partition (T-227 D0-B v2, corrected by v3-2, closed
// by v3-3). Split out of `result.ts` when that file crossed the T-204 800-line module cap.
//
// This module is PURE DATA — a closed class set, a two-namespace tier table and the CLI-local
// absorption map, with no behavior and no imports. That is the point of the cut: the ratified
// DECISIONS live in one small auditable file, and `result.ts` next door is the machinery that
// honors them. `two-tier.test.ts` proves the union is closed in both directions.
//
// `result.ts` re-exports every name below, so consumers keep importing from `./result` and the
// public surface is unchanged by the split.
// ── the closed result-class vocabulary (D0-B v2, v3-3) ───────────────────────────────────────────

/**
 * THE closed set of classes a LOCAL (non-wire) refusal may carry. Three provenances, one set
 * (v3-3), because `LocalRefusal.class` and the exhaustiveness test must derive from ONE list:
 *
 *   MCP-MINTED     — ours to mint, exactly as the ticket mints `auth_required` (wire CODES are the
 *                    cloud's and are never minted here).
 *   CLI-LOCAL      — the two closed-registry codes that are REACHABLE over MCP and agent-actionable
 *                    (`usage_error`, `ambiguous_prefix`). The other seven are absorbed — see
 *                    `CLI_LOCAL_ABSORPTIONS`.
 *   GENERIC/INFRA  — the closed generic labels `classifyWireProblem` falls back to for an UNKNOWN
 *                    wire code (`request_rejected` / `server_error` / `unexpected_error`, also the
 *                    label a retry-exhausted transport failure renders under), plus this module's
 *                    own `internal_error` / `response_too_large` bounds.
 */
export const MCP_RESULT_CLASS_SET = [
  // MCP-minted
  "auth_required",
  "cancelled",
  "confirm_required",
  "confirm_mismatch",
  "plan_stale",
  "client_upgrade_required",
  // reachable CLI-local
  "usage_error",
  "ambiguous_prefix",
  // generic / infra
  "request_rejected",
  "server_error",
  "unexpected_error",
  "internal_error",
  "response_too_large",
] as const;

/** The local-class union, derived from the closed array (no second list to drift). */
export type McpResultClass = (typeof MCP_RESULT_CLASS_SET)[number];

const MCP_RESULT_CLASSES: ReadonlySet<string> = new Set(MCP_RESULT_CLASS_SET);

/** Runtime guard: is `value` a member of the closed local-class set? */
export function isMcpResultClass(value: string): value is McpResultClass {
  return MCP_RESULT_CLASSES.has(value);
}

/** The MCP-minted classes other modules name directly. */
export const AUTH_REQUIRED = "auth_required" as const;
export const CANCELLED = "cancelled" as const;
export const CONFIRM_REQUIRED = "confirm_required" as const;
export const CONFIRM_MISMATCH = "confirm_mismatch" as const;
export const PLAN_STALE = "plan_stale" as const;
export const CLIENT_UPGRADE_REQUIRED = "client_upgrade_required" as const;
export const INTERNAL_ERROR = "internal_error" as const;
export const RESPONSE_TOO_LARGE = "response_too_large" as const;

// ── the ratified tier partition (D0-B v2, corrected by v3-2) ─────────────────────────────────────

/** Which side of `isError` a failure lands on. */
export type McpTier = "domain" | "infra";

export interface McpTierSpec {
  readonly tier: McpTier;
  /**
   * The class this WIRE code surfaces AS on the MCP summary line, when the honest MCP-side label
   * is not the wire code itself. Exactly one row uses it today (D0-C).
   */
  readonly surfacesAs?: McpResultClass;
  /**
   * An MCP-side Hint for a row the CLI classifier offers none for. FALLBACK ONLY — a hint the
   * classifier does supply always wins, so the CLI and MCP surfaces keep teaching the same recovery
   * wherever the CLI has an opinion. Used where a DOMAIN outcome is genuinely actionable but the
   * CLI's own remedy is "exit non-zero and let the shell retry", which is not an instruction an
   * agent can follow.
   */
  readonly hint?: string;
}

const DOMAIN: McpTierSpec = { tier: "domain" };
const INFRA: McpTierSpec = { tier: "infra" };

/**
 * THE tier partition — one table, two namespaces (see the file head for why they cannot be one).
 * Every one of the 24 vendored wire codes and every member of `MCP_RESULT_CLASS_SET` appears in
 * exactly one row; `two-tier.test.ts` proves the union is CLOSED, so a new code anywhere reddens
 * the suite until someone places it deliberately.
 */
export const MCP_TIER_TABLE: {
  readonly wire: Readonly<Record<string, McpTierSpec>>;
  readonly local: Readonly<Record<McpResultClass, McpTierSpec>>;
} = {
  wire: {
    // ── DOMAIN: the server answered, and the answer is the agent's to act on.
    invalid_request: DOMAIN,
    auth_invalid: DOMAIN,
    token_expired: DOMAIN,
    forbidden: DOMAIN,
    scope_insufficient: DOMAIN,
    not_found: DOMAIN,
    conflict: DOMAIN,
    // Retryable-domain: the same write is already running under this key. The agent waits and
    // re-reads; that is an outcome, not a fault. D0-B v2 ratifies that this row's hint carries
    // BACKOFF GUIDANCE — the CLI classifier gives `retry_with_backoff` none (wire-classify.ts:120
    // returns only an exit code, because a shell's remedy is to exit non-zero and be re-run), and
    // "retry" is precisely the wrong instruction to leave an agent to infer: calling the tool again
    // mints a NEW idempotency key, which is a second write, not a retry of the first.
    idempotency_in_flight: {
      tier: "domain",
      hint: "wait ~2s, then RE-READ the resource to see how the in-flight write settled — do not call this tool again to retry it (each call mints a new idempotency key, so a second call is a second write)",
    },
    plan_stale: DOMAIN,
    plan_already_applied: DOMAIN,
    plan_expired: DOMAIN,
    precondition_failed: DOMAIN,
    payload_too_large: DOMAIN,
    validation_failed: DOMAIN,
    limit_exceeded: DOMAIN,
    rate_limited: DOMAIN,
    // D0-C: the server REJECTING our management version IS the upgrade case. The wire code is the
    // server's; the class an MCP client branches on is ours, and it names the remedy.
    version_unsupported: { tier: "domain", surfacesAs: CLIENT_UPGRADE_REQUIRED },

    // ── INFRA: not a consumable outcome.
    // v3-2 — these three arriving on an MCP-OWNED operation mean the owned adapter bypassed its own
    // ceremony (`plan_required`, `confirm_required`) or minted a bad idempotency key
    // (`idempotency_key_conflict`). That is implementation/contract drift in US, and an agent can
    // do nothing with it. NOTE the deliberate asymmetry with the LOCAL namespace below: the
    // MCP-MINTED `confirm_required` / `confirm_mismatch` are DOMAIN — they are the local ceremony
    // refusing to send an unconfirmed D/PR request, which is exactly what an agent recovers from by
    // reading the plan. Same word, opposite meaning, opposite tier.
    plan_required: INFRA,
    confirm_required: INFRA,
    idempotency_key_conflict: INFRA,
    internal_error: INFRA,
    upstream_error: INFRA,
    service_unavailable: INFRA,
    // A 501 is a server CAPABILITY fault: the operation this client advertises does not exist over
    // there. Nothing in the request can be changed to make it work.
    not_implemented: INFRA,
  },
  local: {
    // ── DOMAIN
    auth_required: DOMAIN,
    confirm_required: DOMAIN,
    confirm_mismatch: DOMAIN,
    plan_stale: DOMAIN,
    client_upgrade_required: DOMAIN,
    usage_error: DOMAIN,
    ambiguous_prefix: DOMAIN,
    // ── INFRA
    // D0-I: a call the client ABANDONED is not a consumable domain outcome.
    cancelled: INFRA,
    // The closed generic labels for an UNKNOWN wire code (and, for `server_error`, a
    // retry-exhausted transport failure): we cannot tell the agent what the server meant, so it is
    // never presented as an actionable answer.
    request_rejected: INFRA,
    server_error: INFRA,
    unexpected_error: INFRA,
    internal_error: INFRA,
    response_too_large: INFRA,
  },
};

/**
 * The CLI-local codes that are NEVER surfaced as their own MCP class, and what absorbs each
 * (D0-B v2). `null` means UNREACHABLE over MCP — `unknown_field` is raised only by the `--json
 * <field>` projection, and the MCP output config carries no `fields` (ctx.ts `MCP_OUTPUT_CONFIG`),
 * so no MCP call can reach it. The reachability argument is pinned by a test rather than by a
 * defensive branch.
 */
export const CLI_LOCAL_ABSORPTIONS: Readonly<Record<string, McpResultClass | null>> = {
  // The credential-chain failure taxonomy — `ctx.ts` already classifies these into the
  // `[auth_required]` refusal with its typed `failure` member; a second vocabulary would split it.
  keychain_unavailable: AUTH_REQUIRED,
  not_logged_in: AUTH_REQUIRED,
  insecure_storage_refused: AUTH_REQUIRED,
  insecure_file_permissions: AUTH_REQUIRED,
  // D0-C: the CLI's teachable skew code IS the MCP upgrade class.
  version_skew: CLIENT_UPGRADE_REQUIRED,
  // The ceremony's own code; `tools.ts` translates the TYPED reason into confirm_required /
  // confirm_mismatch before it reaches the default path (this row is the fallback, not the route).
  confirmation_required: CONFIRM_REQUIRED,
  // UNREACHABLE over MCP (see above).
  unknown_field: null,
  // UNREACHABLE over MCP, T-228: `binary_unresolved` has exactly one thrower, the `mcp
  // print-config` handler, and that command carries a non-empty `mcpExclude` — so it is absent
  // from the advertised roster AND refused by the dispatch allowlist. There is no MCP call that
  // can reach the throw site, which is why this is `null` and not an absorbed class: inventing an
  // MCP meaning for a code no MCP call can raise would be a ratified decision about nothing.
  binary_unresolved: null,
};
