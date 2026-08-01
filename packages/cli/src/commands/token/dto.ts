// Token DTO → display-row mapping (T-213 S10, decision E + B-6). The management_token DTO is
// `resource_base & { masked_secret?, scopes?, project_ids? }` with the rest (name / expires_at /
// last_used_at / revoked_at) riding the open `[k]:unknown` tail. The server NEVER sends a raw
// secret outside the mint response, only a `masked_secret` display form — but this mapping is
// DEFENSIVE either way: it rekeys `masked_secret` → `display` (decision E: a `masked_secret` /
// `*secret*` KEY would render `(sensitive)` through the redaction chokepoint), and the chokepoint's
// VALUE patterns still mask a full token if a buggy/hostile server ever put one in the field.
//
// B-6: contract-MINIMAL rows (only resource_base fields present) must not crash — an absent name /
// expiry / last-used renders honestly (`(unknown)` for the string identifiers, null for dates).

/** The placeholder for an absent string identifier (B-6). */
export const UNKNOWN_DISPLAY = "(unknown)";

/** A masked, redaction-safe token row (NEVER carries a raw secret; NEVER a `masked_secret` key). */
export interface TokenDisplayRow {
  readonly id: string;
  readonly name: string;
  /** The masked display form (rekeyed from `masked_secret` — decision E). */
  readonly display: string;
  readonly scopes: string[];
  readonly project_ids: string[];
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly created_at: string | null;
  readonly revoked_at: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Map a raw management_token DTO to a masked display row (tolerant of contract-minimal rows, B-6). */
export function toTokenDisplayRow(raw: unknown): TokenDisplayRow {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: asString(r.id) ?? UNKNOWN_DISPLAY,
    name: asString(r.name) ?? UNKNOWN_DISPLAY,
    display: asString(r.masked_secret) ?? UNKNOWN_DISPLAY, // masked form ONLY — never the raw secret
    scopes: asStringArray(r.scopes),
    project_ids: asStringArray(r.project_ids),
    expires_at: asString(r.expires_at),
    last_used_at: asString(r.last_used_at),
    created_at: asString(r.created_at),
    revoked_at: asString(r.revoked_at),
  };
}
