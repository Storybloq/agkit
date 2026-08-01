// Version + dev-mode flags. Both are replaced at build by tsup `define`; when
// running unbuilt src (tests, `tsx`), they fall back to the dev defaults — so a
// dev build always reports 0.0.0-dev / IS_DEV===true (T-203 acceptance), and a
// release build carries the injected tag.

/** The CLI version: the git tag injected at build, or "0.0.0-dev" for dev builds. */
export const VERSION: string = process.env.AGKIT_CLI_VERSION ?? "0.0.0-dev";

/**
 * True for dev builds (no release tag). Consumers (T-CLI-19) skip
 * housekeeping / update-check / skill-refresh machinery when this is set.
 */
export const IS_DEV: boolean =
  typeof __AGKIT_IS_DEV__ !== "undefined" ? __AGKIT_IS_DEV__ : true;
