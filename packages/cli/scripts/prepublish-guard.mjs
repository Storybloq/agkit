// Fail-closed pre-publish gate for `@storybloq/agkit` (T-228 reqs 4/5, AMENDMENT II item 6).
// Plain node, ZERO dependencies and ZERO TypeScript: `prepublishOnly` runs it as the FIRST
// segment, before `pnpm build`, so nothing that needs building may be on its path.
//
// LINEAGE (T-203). Born as one check: a non-dev (publishable) build must never emit `0.0.0-dev`,
// so a publish is refused unless `AGKIT_RELEASE_VERSION` is set to a real tag — the same var
// tsup's `define` injects into the bundle's self-reported version. T-228's disclosure audit found
// that gate far too narrow: `banana` passed it, and a dist self-reporting `1.2.3` against a
// `0.0.1` manifest passed it. It now collects G1..G7:
//
//   G1  AGKIT_RELEASE_VERSION is set and is not `0.0.0-dev`            (the T-203 check, kept)
//   G2  …and is an exact semver (semver.org shape, anchored, no `v`)
//   G3  …and equals `package.json` `version`               (kills the manifest/binary version seam)
//   G4  `mcpName` is the frozen `cloud.agkit/agkit`                    (owner one-shot, see below)
//   G5  `files` carries all five exact entries incl. both disclosure negations, and packs no
//       `server.json`
//   G6  `server.json` exists beside the manifest, parses, and agrees with it on name / version /
//       identifier
//   G7  `publishConfig` = `{ access: "public", provenance: true }`   (the claim PUBLISHING.md makes)
//
// WHAT THIS IS — AND WHAT IT IS NOT (AMENDMENT II, CX-5; stated plainly so nobody re-reads it as
// more than it is). A lifecycle script is bypassed by `npm publish --ignore-scripts`; the
// enforcement boundary is CREDENTIAL CUSTODY — the sole publish token lives in the mirror repo's
// protected environment. This guard exists to stop an honest mistake, not an adversary. It is a
// FOOTGUN GUARD, never a security control: a publish attempted from anywhere else must fail on
// AUTH, not on scripts.
//
// COLLECT-ALL, NEVER FIRST-FAILURE. Every finding is gathered and printed on its own line, each
// naming its G-number and the offending value. A gate that reports only the first problem turns a
// release into a guessing game — and every retry is a fresh chance to publish something wrong.
// Clean ⇒ silent exit 0.
//
// Not shipped: excluded by package.json `files` (`scripts/` was never packed).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * OWNER ONE-SHOT, 2026-07-31 (T-228 owner decisions of record). The MCP registry binds this string
 * to the npm package BYTE-FOR-BYTE: it fetches `registry.npmjs.org/<identifier>/<version>` and
 * refuses the record unless that tarball's own manifest carries `mcpName` equal to the descriptor's
 * `name`. Publishing under any other string strands the registry entry permanently — so changing
 * this constant is not a code change, it is an owner round.
 */
const FROZEN_MCP_NAME = "cloud.agkit/agkit";

/**
 * The pack manifest, exactly. The two negations are the T-228 disclosure exclusions: the metafile
 * names all ten reserved modules by path, byte size and import graph while their bytes are absent
 * from the emitted JS, and the content-bearing source maps embed the CLI's source tree. They are
 * asserted HERE, at the publish gate, so they cannot be silently reverted between CI and a release.
 */
const REQUIRED_FILES_ENTRIES = ["dist", "!dist/**/*.map", "!dist/metafile-esm.json", "skill", "README.md"];

/**
 * The canonical semver.org regex, anchored and with no leading `v`. Exact versions only — npm burns
 * a version forever, and the MCP registry binds its record to one immutable tarball.
 */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The whole policy, as a PURE function of (environment, parsed manifest, descriptor TEXT). No I/O,
 * no `process`, no `cwd` — `main()` owns every read, which is what makes the rules spawn-testable
 * against doctored fixtures (`src/prepublish-guard.test.ts`). Deliberately NOT exported: the
 * importable-module refactor was evaluated and rejected (plain node must run this file, and a
 * `.mjs` import from a TS test fights `tsconfig include:["src"]` with no `allowJs`), so the suite
 * spawns the REAL artifact instead — the `src/commands/ts-resolve-hook.test.ts` precedent.
 *
 * @returns every finding, in check order; empty means publishable.
 */
function collectFindings({ env, pkg, serverJsonText }) {
  const findings = [];
  const blocked = (gate, message) => findings.push(`publish blocked [${gate}]: ${message}`);
  const pkgVersion = typeof pkg.version === "string" ? pkg.version : "";

  // G1 — the T-203 check, unchanged in substance.
  const releaseVersion = env.AGKIT_RELEASE_VERSION;
  if (!releaseVersion || releaseVersion === "0.0.0-dev") {
    blocked(
      "G1",
      `AGKIT_RELEASE_VERSION is ${releaseVersion ? JSON.stringify(releaseVersion) : "unset"} — set it to ` +
        "the release tag before publishing (T-203 FORBIDDEN: no 0.0.0-dev publish). See PUBLISHING.md.",
    );
  }
  // G2/G3 run whenever the var carries ANY value: they are well-defined for `0.0.0-dev` too, and
  // reporting them alongside G1 is the collect-all posture. They are skipped only when there is
  // literally nothing to check.
  if (releaseVersion) {
    if (!EXACT_SEMVER.test(releaseVersion)) {
      blocked(
        "G2",
        `AGKIT_RELEASE_VERSION ${JSON.stringify(releaseVersion)} is not an exact semver — ` +
          "no ranges, no dist-tags, no leading `v` (semver.org shape, anchored).",
      );
    }
    if (releaseVersion !== pkgVersion) {
      blocked(
        "G3",
        `AGKIT_RELEASE_VERSION ${JSON.stringify(releaseVersion)} does not equal package.json "version" ` +
          `${JSON.stringify(pkg.version)} — the tarball's manifest and the version tsup bakes into the ` +
          "binary would disagree about what was published.",
      );
    }
  }

  // G4 — the frozen registry identity (see FROZEN_MCP_NAME).
  if (pkg.mcpName !== FROZEN_MCP_NAME) {
    blocked(
      "G4",
      `package.json "mcpName" is ${JSON.stringify(pkg.mcpName)} but the MCP registry name is FROZEN at ` +
        `${JSON.stringify(FROZEN_MCP_NAME)} (owner one-shot, 2026-07-31) — the registry binds it to this ` +
        "package byte-for-byte, so any other string strands the record.",
    );
  }

  // G5 — the pack manifest (see REQUIRED_FILES_ENTRIES).
  if (!Array.isArray(pkg.files)) {
    blocked("G5", `package.json "files" must be an array (got ${JSON.stringify(pkg.files)}).`);
  } else {
    for (const entry of REQUIRED_FILES_ENTRIES) {
      if (!pkg.files.includes(entry)) {
        blocked("G5", `package.json "files" is missing the exact entry ${JSON.stringify(entry)}.`);
      }
    }
    for (const entry of pkg.files) {
      if (typeof entry === "string" && entry.includes("server.json")) {
        blocked(
          "G5",
          `package.json "files" entry ${JSON.stringify(entry)} would pack server.json — the registry ` +
            "descriptor is a release-pipeline artifact and never ships inside the tarball.",
        );
      }
    }
  }

  // G6 — descriptor/manifest agreement. Byte-equality with the RENDERER stays the drift test's job
  // (`src/server-json-drift.test.ts`): this file is plain node and must not grow a TS import, so it
  // checks the four bindings the registry itself checks. That keeps the gate honest on a machine
  // that skipped the suite entirely.
  if (serverJsonText === null) {
    blocked(
      "G6",
      "server.json is missing beside package.json — an absent registry descriptor is a refusal, not a " +
        "skip; regenerate it with `pnpm --filter @storybloq/agkit regen:goldens`.",
    );
  } else {
    let descriptor;
    try {
      descriptor = JSON.parse(serverJsonText);
    } catch (error) {
      blocked("G6", `server.json is not valid JSON: ${error.message}`);
    }
    if (descriptor !== undefined) {
      if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        blocked("G6", `server.json must be a JSON object (got ${JSON.stringify(descriptor)}).`);
      } else {
        const first = Array.isArray(descriptor.packages) ? descriptor.packages[0] : undefined;
        const bindings = [
          ["name", descriptor.name, 'package.json "mcpName"', pkg.mcpName],
          ["version", descriptor.version, 'package.json "version"', pkgVersion],
          ["packages[0].version", first?.version, 'package.json "version"', pkgVersion],
          ["packages[0].identifier", first?.identifier, 'package.json "name"', pkg.name],
        ];
        for (const [field, actual, expectedLabel, expected] of bindings) {
          if (actual !== expected) {
            blocked(
              "G6",
              `server.json ${field} is ${JSON.stringify(actual)} but ${expectedLabel} is ` +
                `${JSON.stringify(expected)} — a stale descriptor publishes a record pointing at the ` +
                "wrong artifact.",
            );
          }
        }
      }
    }
  }

  // G7 — the provenance posture PUBLISHING.md claims, asserted where it can stop a publish.
  const publishConfig =
    pkg.publishConfig !== null && typeof pkg.publishConfig === "object" ? pkg.publishConfig : {};
  if (publishConfig.access !== "public") {
    blocked(
      "G7",
      `package.json publishConfig.access is ${JSON.stringify(publishConfig.access)}, expected "public".`,
    );
  }
  if (publishConfig.provenance !== true) {
    blocked(
      "G7",
      `package.json publishConfig.provenance is ${JSON.stringify(publishConfig.provenance)}, expected true.`,
    );
  }

  return findings;
}

/**
 * Resolve the package root, read the two artifacts, print every finding to stderr, exit 1 if any.
 *
 * THE ARGV SEAM. With no argument the root is derived from `import.meta.url` — the committed
 * `prepublishOnly` call site passes NONE, so the real gate always runs against the real tree. The
 * optional single-argv root exists so the suite can point the REAL script at doctored fixtures.
 * Recorded trade: that is an accident-gate convenience, not an adversary boundary — anyone able to
 * pass argv here can equally pass `--ignore-scripts` (see CX-5 above), so the seam widens nothing.
 */
function main(argv) {
  const root = argv.length > 0 ? resolve(argv[0]) : dirname(dirname(fileURLToPath(import.meta.url)));
  const manifestPath = join(root, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`publish blocked: cannot read ${manifestPath}: ${error.message}`);
    process.exit(1);
  }
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    console.error(`publish blocked: ${manifestPath} is not a JSON object.`);
    process.exit(1);
  }
  const serverJsonPath = join(root, "server.json");
  const serverJsonText = existsSync(serverJsonPath) ? readFileSync(serverJsonPath, "utf8") : null;

  const findings = collectFindings({ env: process.env, pkg, serverJsonText });
  for (const finding of findings) console.error(finding);
  process.exit(findings.length > 0 ? 1 : 0);
}

main(process.argv.slice(2));
