// Minimum supported runtime. This gate runs on line one of the bin, BEFORE any
// modern syntax/APIs — so it stays dependency-light and inlines the exit literal
// rather than importing the taxonomy module (whose transitive load must not precede
// the version check).
const MIN_NODE_MAJOR = 22;

/**
 * Exit code for an unmet runtime precondition. An unsupported Node is a determinate
 * TERMINAL failure → exit 2 (T-207 taxonomy `EXIT.TERMINAL`). This RETIRES the
 * provisional `70`: the CLI now only ever exits within {0,1,2,3,130}.
 */
const EXIT_RUNTIME_UNSUPPORTED = 2;

/** Pure predicate (testable): is this Node version >= the supported floor? */
export function isSupportedNode(nodeVersion: string): boolean {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  return !Number.isNaN(major) && major >= MIN_NODE_MAJOR;
}

/**
 * Reject Node < 22 with a teachable message before any modern syntax/APIs run.
 * Called as the first statement of the bin (src/cli.ts).
 */
export function assertNodeVersion(nodeVersion: string = process.versions.node): void {
  if (!isSupportedNode(nodeVersion)) {
    process.stderr.write(
      `agkit requires Node.js >= ${MIN_NODE_MAJOR} (detected v${nodeVersion}).\n` +
        `Upgrade Node — e.g. with nvm:  nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\n` +
        `or download from https://nodejs.org/.\n`,
    );
    process.exit(EXIT_RUNTIME_UNSUPPORTED);
  }
}
