// The CLIENT-AHEAD version-skew remedy line (T-211, A13). A tiny LEAF (imports nothing) because
// TWO sites need the identical prose and must not drift: the fence's header-driven skew error
// (core/client/handshake.ts) and the classifier's `version_unsupported`(400) → `version_skew`
// translation (core/errors/problem.ts) — and problem.ts ⇄ handshake.ts must never import each
// other (handshake already imports core/errors; the reverse edge would be a cycle).
// The CLIENT-BEHIND remedy needs no sibling here: it is the `version_skew` registry default hint.

/** The remedy when the CLIENT is AHEAD (the server speaks an older major). */
export function clientAheadRemedy(pinnedMajor: string): string {
  return `point AGKIT_API_URL at a server speaking management major ${pinnedMajor}, or install the matching older @shyegg/agkit release`;
}
