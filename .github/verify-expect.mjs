#!/usr/bin/env node
// =============================================================================
// verify-expect.mjs — the mirror's byte oracle (T-228 §7 leg 2 + leg 3)
// =============================================================================
// GENERATED into the public mirror at `.github/verify-expect.mjs` by the PRIVATE
// repo's `scripts/mirror-sync.mjs`. Do not hand-edit it in the mirror: the sync
// deletes strays and rewrites this file on every run.
//
// WHAT IT PROVES
//   A candidate tarball's CONTENTS equal the manifest the private repo pre-attested
//   in `RELEASE_EXPECT.json`: the same sorted file list, and the same sha256 for
//   every file. That manifest was written only after the private repo built BOTH
//   trees at the release version and compared them file-by-file, so a match here
//   means "these bytes are the bytes the private monorepo produces".
//
// GRANULARITY, AND WHY
//   PRIMARY GATE = extracted per-file sha256. `npm pack` normalizes entry mtimes
//   (1985-10-26), uid/gid (0) and modes, so the tarball is deterministic FOR A GIVEN
//   npm — but the gzip container can still differ across npm/zlib versions between
//   the machine that ran the sync and the runner that builds the release. File-level
//   equality is invariant to that; the whole-tarball sha256 is recorded and reported
//   as a SECONDARY WITNESS (a mismatch is loud, not fatal — see the exit contract).
//   The workflow separately asserts that the file it PUBLISHES is byte-identical to
//   the file this script verified (CX-2: never re-pack between verify and publish),
//   which is what makes the file-level gate binding on the published artifact.
//
// EXIT
//   0  contents match the manifest (a tarball-sha divergence prints WARNING and
//      still exits 0 — it is a witness, not the gate)
//   1  any file-list or per-file-sha256 divergence, or an unusable input
//
// USAGE
//   node .github/verify-expect.mjs <tarball.tgz> <RELEASE_EXPECT.json>
// =============================================================================
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

function die(message) {
  console.error(`verify-expect: ${message}`);
  process.exit(1);
}

const [tarballArg, manifestArg] = process.argv.slice(2);
if (!tarballArg || !manifestArg) die("usage: verify-expect.mjs <tarball.tgz> <RELEASE_EXPECT.json>");

const tarball = resolve(tarballArg);
const manifestPath = resolve(manifestArg);

let stat;
try {
  stat = statSync(tarball);
} catch (error) {
  die(`cannot stat ${tarball}: ${error.message}`);
}
if (!stat.isFile() || stat.size === 0) die(`${tarball} is not a non-empty file`);

let expect;
try {
  expect = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  die(`cannot read ${manifestPath}: ${error.message}`);
}
if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
  die(`${manifestPath} is not a JSON object`);
}
const expectFiles = expect.files;
if (expectFiles === null || typeof expectFiles !== "object" || Array.isArray(expectFiles)) {
  die(`${manifestPath} has no "files" object — refusing to verify against an empty oracle`);
}
const expectPaths = Object.keys(expectFiles).sort();
// FAIL-CLOSED: an empty or anchorless manifest must never pass vacuously.
if (expectPaths.length === 0) die(`${manifestPath} "files" is empty — the oracle has no subject`);
for (const anchor of ["package.json", "dist/cli.js", "README.md"]) {
  if (!expectPaths.includes(anchor)) die(`${manifestPath} "files" is missing the required anchor ${anchor}`);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const tarballSha = sha256(readFileSync(tarball));

const work = mkdtempSync(join(tmpdir(), "verify-expect-"));
let observed;
try {
  // `tar` is present on every GitHub-hosted runner image and on macOS/Linux dev
  // boxes; node ships no archive reader, and this file must stay dependency-free
  // (the mirror installs nothing before this step could be useful).
  execFileSync("tar", ["-xzf", tarball, "-C", work], { stdio: ["ignore", "ignore", "pipe"] });
  const root = join(work, "package");
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    die("the tarball has no top-level package/ directory — is it an npm tarball?");
  }
  observed = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      observed.set(relative(root, p).split(sep).join("/"), sha256(readFileSync(p)));
    }
  };
  walk(root);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const observedPaths = [...observed.keys()].sort();
const failures = [];
for (const p of expectPaths) {
  if (!observed.has(p)) failures.push(`MISSING   ${p} — attested but absent from the tarball`);
}
for (const p of observedPaths) {
  if (!(p in expectFiles)) failures.push(`UNEXPECTED ${p} — present in the tarball but not attested`);
}
for (const p of expectPaths) {
  const got = observed.get(p);
  if (got !== undefined && got !== expectFiles[p]) {
    failures.push(`DIGEST    ${p}\n            expected ${expectFiles[p]}\n            observed ${got}`);
  }
}

console.log(`verify-expect: manifest ${manifestPath}`);
console.log(`verify-expect: version  ${expect.version ?? "(absent)"}  private_commit ${expect.private_commit ?? "(absent)"}`);
console.log(`verify-expect: tarball  ${tarball}`);
console.log(`verify-expect: tarball sha256 ${tarballSha}`);
console.log(`verify-expect: attested files ${expectPaths.length} · observed files ${observedPaths.length}`);

if (failures.length > 0) {
  console.error(`verify-expect: FAILED — ${failures.length} divergence(s) from the attested manifest:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

if (typeof expect.tarball_sha256 === "string" && expect.tarball_sha256 !== tarballSha) {
  // Secondary witness only (see GRANULARITY above). Every packed file matched, so
  // the delta is container metadata from a different npm/zlib — recorded loudly.
  console.log(
    `::warning::verify-expect: whole-tarball sha256 differs from the attested witness ` +
      `(attested ${expect.tarball_sha256}, observed ${tarballSha}); every packed file matched, ` +
      `so this is npm/gzip container metadata, not content. Record it in the release evidence.`,
  );
}

console.log(`verify-expect: OK — ${expectPaths.length}/${expectPaths.length} packed files match the attested manifest byte-for-byte`);
