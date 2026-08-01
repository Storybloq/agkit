// Shared arg helpers for the agents plane (T-218) — boolean flags, repeatable-tier normalization,
// and value-free JSON-object flag parsing. Self-contained (no cross-noun import) so the agent
// surface reads on its own; the shapes mirror the route-plane precedents (boolFlagArg/toBool).
//
// Value confinement (A-1 / FORBIDDEN 10): `parseJsonObjectFlag` NEVER interpolates the flag VALUE
// (or a JSON-parse position) into its error — only the flag NAME (a compile-time constant) + the
// structural class. safety_settings / thinking_config / parameter_schema are structured config, not
// secrets, but the honesty rail is the same: a malformed value teaches by shape, never by content.
import { z } from "zod";
import { CliLocalError } from "../../core/errors";

/** A boolean flag that also accepts an explicit `--flag true|false` (the tokenizer yields a bare
 *  `true` or the string). Normalized by `toBool` — never `z.coerce.boolean` (Boolean("false") is
 *  true, a silent inversion). */
export const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
export function toBool(value: boolean | "true" | "false"): boolean {
  return value === true || value === "true";
}

/** A repeatable string flag: `--x a --x b` collects into an array; a single `--x a` stays scalar. */
export const repeatableStringArg = z.union([z.string(), z.array(z.string())]);

/** Normalize a scalar-or-array-or-undefined repeatable flag into an ordered `string[]`. */
export function normalizeList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Parse a `--flag <json>` value into a PLAIN object (JSON object — not an array, null, or scalar),
 * for the `safety_settings` / `thinking_config` / `parameter_schema` structured-config flags. Throws
 * a value-free `usage_error` naming ONLY the flag + the class on a parse failure or a non-object —
 * never the value, never a parse position (A-1).
 */
export function parseJsonObjectFlag(raw: string, flagLabel: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliLocalError("usage_error", {
      detail: `${flagLabel} must be valid JSON`,
      hint: `pass a JSON object to ${flagLabel}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliLocalError("usage_error", {
      detail: `${flagLabel} must be a JSON object (not an array or a scalar)`,
      hint: `pass a JSON object to ${flagLabel}`,
    });
  }
  return parsed as Record<string, unknown>;
}
