// Build-time feature flag: does this build SHIP the RESERVED command trees?
// (T-210, canonical L2-CLI-21, Deliverable 1.)
//
// BYTE-ABSENCE, not just output-absence. The ticket demands reserved commands be
// "compiled-out" — absent from the shipped BINARIES, not merely filtered from
// `--help`/`reference`/skill. The mechanism is a tsup `define` (tsup.config.ts):
//   __AGKIT_SHIP_RESERVED__  =  JSON.stringify(process.env.AGKIT_SHIP_RESERVED === "1")
// which esbuild substitutes as a literal `false` (default) / `true` at build. In
// registry.ts the flag gates a ternary:
//   SHIP_RESERVED ? [...VISIBLE_SPECS, ...buildReservedSpecs()] : VISIBLE_SPECS
// With the literal `false`, esbuild folds the ternary to `VISIBLE_SPECS`, the
// `buildReservedSpecs()` call becomes dead code, and — because the reserved specs
// live behind a SIDE-EFFECT-FREE FACTORY (a function *declaration*, not a top-level
// const array) — the now-unreferenced factory module + its whole import graph
// (including the shared knowledge validator and every reserved string) tree-shake
// out of the default bundle. The two-build SENTINEL leg in `scripts/pack-probes.sh`
// (the shared scanner `scripts/reserved-sentinel.mjs`) PROVES this: it scans every file
// the tarball ACTUALLY packs, and an ARMED differential build proves the scan can see a
// shipped reserved tree. Source maps and the build metafile are PACK-EXCLUDED as of
// T-228 (the `package.json` `files[]` negations), so they are not in scope today — but
// the leg's walk is TOTAL, with no extension filter, so they are re-covered automatically
// if either is ever readded to the pack.
//
// The `typeof` guard makes unbuilt src (vitest / tsx / dev) resolve to `false` —
// so the DEFAULT test run and the committed `skill/reference.md` are the reserved-FREE
// artifact. Vitest runs the SOURCE (no tree-shaking), so tests reach the reserved
// specs by importing `buildReservedSpecs()` DIRECTLY; byte-absence (a build property)
// and drift-testability (a source property) coexist.
//
// SKILL SCOPE (T-210 §B): the flag does NOT toggle the packaged `skill/reference.md`.
// A tsup `define` only rewrites bundled JS — it cannot make a committed file
// flag-dependent, and rewriting a tracked file mid-build risks a dirty worktree. So
// the skill is ALWAYS the flag-OFF, reserved-free artifact (FORBIDDEN: reserved in any
// shipped skill). Enabling a tree (Deliverable 3, a FUTURE release) regenerates +
// recommits the skill as an explicit reconciliation step — out of T-210 scope.

/**
 * True only in a build that opted into shipping the reserved trees
 * (`AGKIT_SHIP_RESERVED=1` at build). `false` for every default build AND for
 * unbuilt source (tests / dev), via the `typeof` guard.
 */
export const SHIP_RESERVED: boolean =
  typeof __AGKIT_SHIP_RESERVED__ !== "undefined" ? __AGKIT_SHIP_RESERVED__ : false;
