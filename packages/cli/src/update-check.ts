// The detached update-check helper entry (T-209, canonical L2-CLI-19, ISS-570). Built
// as its own tsup entry -> `dist/update-check.js`, spawned by preCommandHousekeeping via
// `node dist/update-check.js <stampPath> <currentVersion>` with { detached, stdio:
// 'ignore' } + .unref(). It runs the npm-registry probe and atomically writes the
// update-check stamp in its OWN process, then exits — this is what keeps the parent's
// exit truly non-blocking. It performs NO skill install and NO other housekeeping: it
// deliberately imports only the child logic + the real stamp I/O, never the run()/
// housekeeping bootstrap, so it can never recurse into a check-of-a-check.
import { runUpdateCheckChild } from "./core/housekeeping/update-check-child";
import { realStampIo } from "./core/housekeeping/node-fs";

void runUpdateCheckChild({
  argv: process.argv.slice(2),
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  fetch: globalThis.fetch,
  ...realStampIo(),
}).then(
  () => {
    /* clean exit — nothing to report */
  },
  () => {
    /* never surface: the check is best-effort and stdio is ignored anyway */
  },
);
