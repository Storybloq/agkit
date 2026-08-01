// `--json [fields]` field projection (T-205, canonical L2-CLI-03, deliverable 3).
// Selecting `data` fields (per-item for lists). An unknown field is a TEACHABLE
// error: it surfaces the list of available fields and exits 2 (wired in run.ts).
//
// This ticket MINTS NO NEW CLI-local error codes: the placeholder code string
// `unknown_field` is used, and routing it through the real teachable-error
// renderer is L2-CLI-04's job (not built yet).

/** Thrown when `--json a,b` names a field absent from `data`. Exit 2 upstream. */
export class UnknownFieldError extends Error {
  override name = "UnknownFieldError";
  constructor(
    readonly field: string,
    readonly available: string[],
  ) {
    super(`unknown field '${field}'`);
  }
}

/** Available field names for `data` — the union of keys across list items. */
export function availableFields(data: unknown): string[] {
  if (Array.isArray(data)) {
    const keys: string[] = [];
    for (const item of data) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        for (const k of Object.keys(item as Record<string, unknown>)) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
    }
    return keys;
  }
  if (data !== null && typeof data === "object") {
    return Object.keys(data as Record<string, unknown>);
  }
  return [];
}

/**
 * Project `fields` from `data` (per-item for lists). Throws `UnknownFieldError`
 * for a field that is not present. A zero-state list (`[]`) projects to `[]` with
 * NO error (exit stays 0) — there are no items whose schema we could validate.
 */
export function projectFields(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data) && data.length === 0) return [];

  const avail = availableFields(data);
  for (const field of fields) {
    if (!avail.includes(field)) throw new UnknownFieldError(field, avail);
  }

  if (Array.isArray(data)) return data.map((item) => pick(item, fields));
  return pick(data, fields);
}

function pick(item: unknown, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(record, field)) out[field] = record[field];
    }
  }
  return out;
}
