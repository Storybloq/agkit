// Raw-door query validation (T-222 step 10b, B1 / C1 / D3). The raw door accepts query parameters only
// from a CLOSED allowlist of contract-derived, closed-form, NON-secret keys — everything else is
// refused (honor-or-reject), so the escape hatch can neither smuggle an unexpected param to the server
// nor echo a secret-shaped value. Today the allowlist is exactly `limit` (the global keyset bound
// `1..200`); `cursor` is opaque (not client-constructible) and the audit/media filters have no frozen
// closed form, so those stay owned by the typed commands and are excluded here.
//
// Discipline:
//   • cap the count of NON-EMPTY `key=value` pairs at MAX_QUERY_PARAMS (m3) — adjacent/trailing `&`
//     yield empty pairs that carry nothing and are NEVER counted (the split is bounded by the OS argv
//     limit, so it cannot materialize unboundedly);
//   • percent-DECODE each key, reject a duplicate normalized key (D3) and any key not on the allowlist;
//   • run the key's closed validator on the DECODED value; rebuild the query CANONICALLY from the
//     validated pairs only.
// Every rejection is the closed-set `usage_error` with a STATIC message — a query VALUE could be a
// secret, and even a KEY is operator input, so nothing from the input is interpolated (hard constraint).
import { CliLocalError } from "../errors";
import { MAX_QUERY_PARAMS } from "./limits";

/** A closed value validator: does the DECODED value satisfy this param's contract-frozen form? */
type QueryValidator = (decodedValue: string) => boolean;

/** `limit` — a base-10 integer in the global keyset bound `1..200` (no sign, decimal, or whitespace). */
function isValidLimit(decodedValue: string): boolean {
  if (!/^\d+$/.test(decodedValue)) return false;
  const n = Number(decodedValue);
  return Number.isInteger(n) && n >= 1 && n <= 200;
}

/**
 * The CLOSED raw-door query allowlist. Adding a key here is the ONLY way a query parameter becomes
 * reachable through the raw door — it must be contract-derived, closed-form, and non-secret. `limit`
 * is validated against the GLOBAL `1..200` bound; per-route `max_limit` (e.g. plan.list's 100) is not
 * enforced client-side (the server clamps) — noted (m4).
 */
const RAW_QUERY_ALLOWLIST: Readonly<Record<string, QueryValidator>> = { limit: isValidLimit };

function rawQueryError(detail: string): CliLocalError {
  return new CliLocalError("usage_error", {
    detail,
    hint: "the raw door accepts only the 'limit' query parameter (an integer 1..200)",
  });
}

/**
 * Validate + canonicalize the raw-door query. `rawQuery` is the substring after the path's first `?`
 * (empty when none); `extraFields` are additional `key=value` strings (10c's `--field`, empty in 10b).
 * Returns the canonical query WITHOUT a leading `?` (empty string when there are no params). Throws
 * `usage_error` (static message) on an over-count, a duplicate key, an unknown key, a malformed
 * encoding, or a value that fails its closed validator.
 */
export function parseRawQuery(rawQuery: string, extraFields: readonly string[] = []): string {
  const rawPairs = rawQuery === "" ? [] : rawQuery.split("&");
  const allPairs = [...rawPairs, ...extraFields];

  const seenKeys = new Set<string>();
  const validated: Array<{ key: string; value: string }> = [];

  for (const pair of allPairs) {
    if (pair === "") continue; // a trailing/adjacent `&` yields an empty pair — carries nothing, skip.
    // m3: cap NON-EMPTY pairs (skipped empties never count). Checked as each real pair is seen, so an
    // over-count short-circuits early rather than after validating the whole set.
    if (validated.length >= MAX_QUERY_PARAMS) {
      throw rawQueryError("the request has too many query parameters");
    }
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);

    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      throw rawQueryError("a query parameter has a malformed percent-encoding");
    }

    if (seenKeys.has(key)) {
      throw rawQueryError("a query parameter was supplied more than once");
    }
    seenKeys.add(key);

    const validator = Object.prototype.hasOwnProperty.call(RAW_QUERY_ALLOWLIST, key)
      ? RAW_QUERY_ALLOWLIST[key]
      : undefined;
    if (validator === undefined) {
      throw rawQueryError("an unsupported query parameter was supplied");
    }
    if (!validator(value)) {
      throw rawQueryError("a query parameter value is out of the allowed range or format");
    }
    validated.push({ key, value });
  }

  // Rebuild canonically from the validated pairs only (dropping any incoming encoding quirks).
  return validated.map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}
