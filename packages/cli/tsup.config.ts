import { defineConfig } from "tsup";

// Version is injected at build time. A release build sets AGKIT_RELEASE_VERSION
// (the git tag, via CI / the owner publish flow); any other build is a dev build
// and reports 0.0.0-dev. FORBIDDEN (T-203): a *non-dev* build that emits
// 0.0.0-dev — the release pipeline MUST set AGKIT_RELEASE_VERSION (see PUBLISHING.md).
const version = process.env.AGKIT_RELEASE_VERSION ?? "0.0.0-dev";
const isDev = version === "0.0.0-dev";

// T-210 (L2-CLI-21): a DEFAULT build compiles the reserved command trees OUT (byte
// absence). Only `AGKIT_SHIP_RESERVED=1` at build ships them. esbuild substitutes the
// literal so registry.ts's ternary folds to the visible specs and the reserved factory
// dead-code-eliminates. See src/build-flags.ts.
const shipReserved = process.env.AGKIT_SHIP_RESERVED === "1";

export default defineConfig({
  // Anchor A1: the entries share one bundled core — the `agkit` bin, the L3 MCP
  // server module (handed off by `mcp serve`, T-222), the library index (the typed
  // client + handlers, T-211), and the T-209 detached update-check helper
  // (`dist/update-check.js`, spawned by preCommandHousekeeping; it performs the
  // npm-registry probe + stamp write in its own process so the parent exit is
  // non-blocking). All ship UNDER dist/ (the pack whitelist).
  entry: {
    cli: "src/cli.ts",
    mcp: "src/mcp.ts",
    index: "src/index.ts",
    "update-check": "src/update-check.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  // T-217 step 13 (RR-9): emit the tsup/esbuild metafile (`dist/metafile-{format}.json`) so the
  // dist vocabulary scan has a SECOND independent witness (which source modules are inputs of which
  // emitted chunk) to cross-check the source-map provenance attribution. Additive — no output-bytes
  // change.
  metafile: true,
  // dts ships the typed library surface (T-211). tsup's rollup-dts CANNOT inline the workspace
  // `@agentkit-cloud/shared/wire-contract/management-types.gen` import (that subpath resolves via
  // the `default` condition to a `.ts` SOURCE, and rollup-dts only bundles `.d.ts` — `dts.resolve`
  // leaves it external). So the `index` declaration keeps ONE unresolvable workspace import, which
  // a `postbuild` step (scripts/inline-shared-dts.mjs) inlines from the self-contained type-only
  // `.gen` source — yielding a SELF-CONTAINED `.d.ts` (A19 no surviving `@agentkit-cloud/`
  // specifier + A38 clean-room consumer compile prove it end-to-end over the packed tarball).
  dts: true,
  // @napi-rs/keyring is a native (.node) addon — it cannot be bundled and stays a
  // real runtime dependency (T-206). tsup auto-externalizes every package.json
  // `dependency` (yargs, zod), which is fine — a consumer install resolves them.
  external: ["@napi-rs/keyring"],
  // @agentkit-cloud/shared is a workspace DEVdependency (not a runtime dep), imported
  // ONLY by the reserved tree for the byte-pinned knowledge binding validator. Force-
  // bundle it (like jq-wasm) so nothing external is required at runtime; in a default
  // build it tree-shakes out entirely with the reserved factory. (T-210.)
  //
  // The jq engine (T-205, canonical L2-CLI-03) is `jq-wasm/inline`, which embeds
  // the .wasm as base64 INSIDE its JS module. We force-bundle it (it is a
  // devDependency, not a runtime dep) so it ships UNDER dist/ (the pack whitelist)
  // and `--jq` works from a raw-extracted tarball with no system jq and no dep
  // install. It is imported dynamically (src/core/output/jq.ts), so esbuild emits
  // it as its own dist chunk loaded only when `--jq` is actually used.
  //
  // NOTE: keep this a SINGLE `noExternal` key — a second `noExternal:` literal would
  // silently overwrite this one (last-key-wins) and drop `@agentkit-cloud/shared`.
  noExternal: ["jq-wasm", "@agentkit-cloud/shared"],
  define: {
    "process.env.AGKIT_CLI_VERSION": JSON.stringify(version),
    __AGKIT_IS_DEV__: JSON.stringify(isDev),
    __AGKIT_SHIP_RESERVED__: JSON.stringify(shipReserved),
  },
  // T-210 byte-absence: enable esbuild `minifySyntax` (ONLY — no identifier mangling, no
  // whitespace stripping) so a constant-folded branch like `false ? A : B` is actually
  // ELIMINATED. Without it, esbuild folds the CONDITION to `false` but keeps the dead
  // branch, retaining `buildReservedSpecs()` and leaking the reserved trees into a default
  // build. minifySyntax is semantics-preserving; the SENTINEL leg in `scripts/pack-probes.sh`
  // (reserved-sentinel.mjs) proves the reserved graph is gone with it on.
  esbuildOptions(options) {
    options.minifySyntax = true;
  },
});
