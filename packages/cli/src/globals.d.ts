// Build-time constants injected by tsup `define` (see tsup.config.ts). Every read
// guards with `typeof` so unbuilt src (vitest, tsx, dev) resolves to the dev
// default instead of throwing a ReferenceError.
declare const __AGKIT_IS_DEV__: boolean;

// T-210 (L2-CLI-21): whether this build SHIPS the reserved command trees. `define`d
// to `false` by default so esbuild folds the registry ternary to the visible specs
// and dead-code-eliminates the reserved factory (BYTE absence). Set at BUILD via
// `AGKIT_SHIP_RESERVED=1` (the future "enable a tree" release). See src/build-flags.ts.
declare const __AGKIT_SHIP_RESERVED__: boolean;
