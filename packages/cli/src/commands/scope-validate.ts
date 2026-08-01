// Client-side scope MEMBERSHIP validation (T-213 decision (h) + B-3). Both `login --scopes a,b`
// (CSV) and `token create --scope x --scope y` (repeatable) validate EVERY requested scope against
// the contract scope registry BEFORE anything is sent — an unknown scope is a local `usage_error`
// (exit 2) naming the bad scope, never forwarded to the server unvalidated (FORBIDDEN: accepting a
// scope outside the contract registry).
//
// The vocabulary is `MANAGEMENT_SCOPE_REGISTRY` rendered as `family:verb` strings (the 48 frozen
// entries) — already bundler-safe exported and already an import path the CLI uses (contract.ts).
// Validation is MEMBERSHIP-ONLY: subset / mintability / binding checks stay server-owned
// (honor-or-reject — we reject what the CONTRACT cannot name; we never pre-judge policy).
import { MANAGEMENT_SCOPE_REGISTRY } from "@agentkit-cloud/shared/wire-contract/management-data";
import { CliLocalError } from "../core/errors";

/** The closed `family:verb` scope vocabulary (48 entries), sorted for a stable teachable list. */
export const MANAGEMENT_SCOPE_STRINGS: readonly string[] = Object.freeze(
  [...new Set(MANAGEMENT_SCOPE_REGISTRY.map((e) => `${e.family}:${e.verb}`))].sort(),
);

const SCOPE_SET: ReadonlySet<string> = new Set(MANAGEMENT_SCOPE_STRINGS);

/** Split a CSV `--scopes a,b , c` list into trimmed, non-empty entries (login flag). */
export function parseCsvScopes(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The scopes sharing `bad`'s family (a teachable "did you mean" set), or []. */
function familySuggestions(bad: string): string[] {
  const idx = bad.indexOf(":");
  if (idx <= 0) return [];
  const family = bad.slice(0, idx);
  return MANAGEMENT_SCOPE_STRINGS.filter((s) => s.startsWith(`${family}:`));
}

/**
 * Validate that EVERY scope names a `family:verb` in the contract registry, else throw the
 * teachable `usage_error` (exit 2) naming the bad scope + the registry vocabulary (with a
 * family-match suggestion when the family is recognized). Nothing is sent on failure.
 */
export function validateScopeMembership(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (SCOPE_SET.has(scope)) continue;
    const suggestions = familySuggestions(scope);
    const detail =
      `unknown scope '${scope}' — it is not in the contract scope registry` +
      (suggestions.length > 0 ? ` (did you mean one of: ${suggestions.join(", ")}?)` : "");
    throw new CliLocalError("usage_error", {
      detail,
      hint: "agkit reference --json  # lists every valid <family>:<verb> scope",
      extra: { scope, valid_scopes: MANAGEMENT_SCOPE_STRINGS },
    });
  }
}
