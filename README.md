# agkit — public build-input mirror

This repository is the **published-source mirror** for the npm package
[`@shyegg/agkit`](https://www.npmjs.com/package/@shyegg/agkit) — the AgentKit
management-plane CLI and MCP server. It exists so that npm **provenance** means
something: a provenance attestation says "these published bytes were built from
this source, by this workflow", and that claim is only checkable if the source is
public. This repo is that source.

## Read this first

- **Every file here is GENERATED.** The development monorepo is private. A sync
  step in that repo materializes this tree, verifies it, and replaces this
  checkout's contents wholesale — including deleting anything it did not write.
- **Do not open pull requests against the source.** A change made here is
  overwritten by the next sync and never reaches the published package. Issues
  and discussion are welcome; source changes have to land upstream.
- **This is the complete build-input set, not a subset of convenience.** The
  package's emitted bytes are a function of exactly what is in `packages/`. That
  is the property the release gate below actually measures.

## What is deliberately absent

- **The test suite.** The tests live and run in the private monorepo, against the
  same source that is mirrored here, and they gate the same bytes. Mirroring them
  is not what makes provenance work; mirroring the *build inputs* is.
- **The reserved command trees.** `packages/cli/src/commands/reserved/` carries a
  single generated stub. Those trees are compiled out of a default build by
  design — their bytes are absent from the shipped artifact — so the stub changes
  nothing about the published package. The stub throws rather than returning an
  empty list, so a build that tried to force them on fails loudly instead of
  shipping a hollow surface.
- **Everything else from the monorepo.** Only the CLI package and the small
  contract subset the shipped tarball already embeds are mirrored. The server, the
  dashboard, the schema and the operational tooling are not build inputs and are
  not here.

## How a release is verified

`RELEASE_EXPECT.json` in the repo root is a manifest written by the private repo's
sync step. It records, for the version it names, the sha256 of **every file in the
published tarball** — computed after the private repo built *both* trees at that
version and compared them file by file. Two checks then bind it to reality:

1. `.github/workflows/release.yml` builds from this repo's own source, packs the
   tarball **once**, verifies it against `RELEASE_EXPECT.json`, and publishes
   *that exact file*. It never re-packs between verifying and publishing.
2. After publishing it fetches the tarball back from the registry and re-verifies
   it against the same manifest.

You can run the same check yourself:

```sh
npm pack @shyegg/agkit@<version>
node .github/verify-expect.mjs shyegg-agkit-<version>.tgz RELEASE_EXPECT.json
```

## Layout

| Path | What it is |
|---|---|
| `packages/cli/` | the CLI package — the published artifact's source |
| `packages/shared/` | the wire-contract subset the shipped bundle embeds |
| `packages/management-core/` | a workspace placeholder; satisfies a dev-dependency link and contributes no bytes |
| `RELEASE_EXPECT.json` | the attested per-file manifest for the current release |
| `.github/verify-expect.mjs` | the verifier, dependency-free and runnable by anyone |

## Building locally

```sh
pnpm install --frozen-lockfile
pnpm --filter @shyegg/agkit build
```

A build with no `AGKIT_RELEASE_VERSION` set is a development build and reports
`0.0.0-dev`; release builds inject the tag.
