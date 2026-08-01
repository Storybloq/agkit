// T-221 — the files `agkit init` writes, and the marker probe that decides which.
//
// R63 (the artifact rule): a file init writes is a BINDING that outlives the command, so it may
// carry ONLY identity — a project id, a profile name, a publishable key, an API base. It may NOT
// carry a realization (provider / model / tier / execution target): the dashboard owns those, and
// a realization frozen into a repo file is exactly the app-release-coupled binding §A abolishes.
// Both artifacts below are therefore CLOSED shapes, authored member-by-member here — never a
// spread of a server response.
//
// `AgentKit.plist` is NEVER written (ISS-221): no reader for it exists in the SDK, so writing one
// would be a file that lies about being consumed.
//
// The Swift path writes NO SDK config file: a Swift app wires the provider in code, so the
// handoff is the PRINTED snippet (snippet.ts) — which is documentation, not an artifact, and is
// held for the report rather than put on disk.
import { basename, join } from "node:path";
import type { CliRuntime } from "../types";
import { requireWriteTextFile } from "../types";
import { repoProjectSchema } from "../../core/config/repo-project";
import { CliLocalError } from "../../core/errors";

/** The repo-local journal directory + file (`core/config/repo-project.ts` discovers this exact path). */
export const REPO_DIR = ".agentkit";
export const REPO_JOURNAL_FILE = "project.json";
/** The JS/TS SDK config artifact. */
export const SDK_CONFIG_FILE = "agentkit.config.json";

/** Which handoff a repo takes. `unknown` behaves like `js`: a JSON config any runtime can read. */
export type ProjectKind = "swift" | "js" | "unknown";

const SWIFT_PACKAGE_MARKER = "Package.swift";
const SWIFT_PROJECT_SUFFIXES = [".xcodeproj", ".xcworkspace"];
const JS_MARKER = "package.json";

/**
 * Classify the repo from its TOP-LEVEL entry names (never file contents, never a recursive walk).
 * Swift markers win when both are present: an iOS/macOS app repo routinely carries a `package.json`
 * for tooling, while a JS package almost never carries an Xcode project.
 */
export function detectProjectKind(entries: readonly string[]): ProjectKind {
  const hasSwift =
    entries.includes(SWIFT_PACKAGE_MARKER) ||
    entries.some((e) => SWIFT_PROJECT_SUFFIXES.some((suffix) => e.endsWith(suffix)));
  if (hasSwift) return "swift";
  return entries.includes(JS_MARKER) ? "js" : "unknown";
}

/** Probe the repo root through the ADVISORY `listDir` seam (absent seam ⇒ no markers ⇒ `unknown`). */
export function probeProjectKind(rt: CliRuntime, cwd: string): ProjectKind {
  return detectProjectKind(rt.listDir ? rt.listDir(cwd) : []);
}

/**
 * The repo's own name — the default publishable-key label's `<repo>` part. `basename` of cwd, with
 * a fixed fallback so an unnameable cwd (root) still produces a legal 1..200 label.
 */
export function repoName(cwd: string): string {
  const name = basename(cwd).trim();
  return name.length > 0 && name !== "/" ? name : "project";
}

/** The default publishable-key label. ONE definition, so the gather, the conflict check and the
 *  `--yes` frontend all mean the same string. */
export function defaultKeyName(cwd: string): string {
  return `${repoName(cwd)} (init)`;
}

export function journalPath(cwd: string): string {
  return join(cwd, REPO_DIR, REPO_JOURNAL_FILE);
}

export function sdkConfigPath(cwd: string): string {
  return join(cwd, SDK_CONFIG_FILE);
}

/**
 * Write `.agentkit/project.json` — the COMMITTED PARTIAL STATE marker. Written the instant the
 * project id exists (created or picked), BEFORE the key is minted: if the run dies or is declined
 * later, the repo still points at the project that was actually created, and a re-run resumes
 * instead of orphaning it.
 *
 * Validated through the SAME strict `repoProjectSchema` that READS it back, so init can never
 * write a file its own discovery would reject (the `saveConfig` defence-in-depth pattern).
 */
export function writeRepoJournal(rt: CliRuntime, cwd: string, projectId: string, profile: string): string {
  const doc = repoProjectSchema.parse({ projectId, profile });
  const path = journalPath(cwd);
  // `withinRoot`: a checkout shipping `.agentkit` as a SYMLINK must not redirect this write
  // outside the repo (codex k07) — the writer refuses before creating anything.
  requireWriteTextFile(rt)(path, JSON.stringify(doc, null, 2) + "\n", { withinRoot: cwd });
  return path;
}

/** The EXACT SDK config shape. Closed by construction: three members, `apiUrl` present only when
 *  the project targets a non-default API base. */
export interface SdkConfigDoc {
  readonly projectId: string;
  readonly publishableKey: string;
  readonly apiUrl?: string;
}

/**
 * Write `agentkit.config.json` — the JS/TS handoff. Written the instant the key is minted, so a
 * shown-once value is on disk before anything else can fail and lose it.
 */
export function writeSdkConfig(rt: CliRuntime, cwd: string, doc: SdkConfigDoc): string {
  if (doc.projectId.length === 0 || doc.publishableKey.length === 0) {
    throw new CliLocalError("usage_error", {
      detail: "internal: refusing to write an SDK config without both a project id and a publishable key",
    });
  }
  const body: Record<string, string> = { projectId: doc.projectId, publishableKey: doc.publishableKey };
  if (doc.apiUrl !== undefined) body["apiUrl"] = doc.apiUrl;
  const path = sdkConfigPath(cwd);
  requireWriteTextFile(rt)(path, JSON.stringify(body, null, 2) + "\n", { withinRoot: cwd });
  return path;
}
