// ID-prefix resolution (T-207, canonical L2-CLI-04, deliverable 7). A convenience
// most management CLIs offer: type a short prefix of a resource id and have the CLI
// expand it. The hazard is a SILENT wrong pick when a prefix is ambiguous — this
// resolver refuses that. On collision it raises `ambiguous_prefix` with the FULL
// candidate list (never a silent pick); an exact match always wins even when it is
// also a prefix of longer ids.
//
// No ID-prefixed command exists yet: T-211 landed the typed CLIENT SEAM, but a command
// that RESOLVES a prefix against a server-fetched id list (and maps "no local match" to the
// wire `not_found`) is a later command-family increment. This is the MECHANISM + its unit
// tests, ready to be consumed. The zero-match case throws a plain error today — see below.
import { AmbiguousPrefixError } from "./cli-codes";

/**
 * Resolve `prefix` against `candidates` to exactly one id.
 *   - an EXACT match returns immediately (even if it also prefixes longer ids);
 *   - exactly one `startsWith(prefix)` match returns that id;
 *   - two or more matches → `AmbiguousPrefixError` (exit 2, full candidate list);
 *   - zero matches → a plain error (never a silent `undefined`).
 */
export function resolveIdPrefix(prefix: string, candidates: readonly string[]): string {
  // Exact wins: `proj_ab` resolves to `proj_ab` even if `proj_abc` also exists.
  if (candidates.includes(prefix)) return prefix;

  const matches = candidates.filter((c) => c.startsWith(prefix));
  if (matches.length === 1) return matches[0] as string; // length-checked; safe under noUncheckedIndexedAccess
  if (matches.length >= 2) throw new AmbiguousPrefixError(prefix, matches);

  // TODO(id-bearing commands, post-T-211): a command that ALSO queries the server maps "no
  // local match" to the wire `not_found` code. Standalone (no consumer yet), we fail loudly
  // rather than return undefined so no caller can mistake a miss for a pick.
  throw new Error(`no id matches the prefix '${prefix}'`);
}
