// T-224 — the LEG MODEL every `agkit setup` arm reports through, plus the injected dep set the
// four legs share. No I/O of its own: this module defines the vocabulary and the arithmetic.
//
// WHY A LEG MODEL AT ALL. `setup` is four independent reconciliations against four files owned by
// four different parties (us, Claude, the repo, Codex). Any of them can be already-done, done-now,
// impossible-without-the-user, or refused-because-we-do-not-recognize-what-is-there — and the run
// must report ALL FOUR outcomes rather than stopping at the first one it cannot finish. So each
// leg yields a record, and the handler's only job is to fold those records into an exit code.
//
// THE STATUS SET IS THE HONESTY CONTRACT:
//   current      — already converged. Nothing was written, and nothing needed to be.
//   done         — WE changed it, and we re-read the file afterwards to prove it (never an exit code).
//   would_change — `--check` only: this leg is out of date and an apply WOULD converge it.
//   manual       — we cannot do it, but the user can: the leg carries the exact command to run.
//   refused      — we will not touch what is there (unrecognized shape, custody we cannot restore).
//                  A refusal is a decision, not a failure: nothing was written, nothing was lost.
//   skipped      — not requested (the codex leg without `--client codex`). Never drift.
import type { InstallFs } from "../../core/housekeeping/install";
import type { FollowSeams } from "../types";
import type { ServiceCommandSeam } from "../command-seams";

/** The four reconciliations, in the order they run and are reported. */
export const SETUP_LEG_NAMES = ["skill", "claude_mcp", "agents_md", "codex"] as const;
export type SetupLegName = (typeof SETUP_LEG_NAMES)[number];

export type SetupLegStatus = "done" | "current" | "manual" | "refused" | "would_change" | "skipped";

/**
 * One leg's report. `leg`/`status`/`detail` are the fixed spine; every other member is a
 * leg-specific FACT (`registered`, `path`, `reason`, `command`…). Facts are always sanitized,
 * bounded, and value-free where the value is the user's business (D4v4, D-detail-sanitize-v2).
 */
export interface SetupLeg {
  readonly leg: SetupLegName;
  readonly status: SetupLegStatus;
  readonly detail: string;
  readonly [fact: string]: unknown;
}

/** Build a leg record: the spine first, then the leg's own facts. */
export function leg(
  name: SetupLegName,
  status: SetupLegStatus,
  detail: string,
  facts: Record<string, unknown> = {},
): SetupLeg {
  return { ...facts, leg: name, status, detail };
}

/**
 * D-check-v2: EVERY unmet desired state is drift, and convergence is a CLOSED set — only
 * `current`/`skipped` pass. Deliberately NOT an allowlist of known drift statuses: a mode-illegal
 * status (a regressed leg returning `done` from a check arm that must never write) lands on the
 * drift side and exits 1, so no contract violation can ever CERTIFY a machine.
 */
export function isDrift(l: SetupLeg): boolean {
  return l.status !== "current" && l.status !== "skipped";
}

/**
 * The apply-mode twin, the same closed-set shape: finished is exactly `done`/`current`/`skipped`.
 * A mode-illegal `would_change` on the apply path is PENDING (exit 3), never silent success.
 */
export function isPending(l: SetupLeg): boolean {
  return l.status !== "done" && l.status !== "current" && l.status !== "skipped";
}

/** An APPLY run's changed count: the legs whose bytes THIS invocation actually published. */
export function changedCount(legs: readonly SetupLeg[], check: boolean): number {
  return legs.filter((l) => (check ? isDrift(l) : l.status === "done")).length;
}

/** Everything the legs consume. All injected — a leg never touches `process` or `node:fs`. */
export interface SetupDeps {
  /** `--check`: report only. Every leg's check arm is read-only BY CONSTRUCTION (D-within-v4). */
  readonly check: boolean;
  readonly homeDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** The running CLI version — the install marker comparison. */
  readonly version: string;
  readonly now: () => number;
  readonly pid: number;
  /** The shipped `skill/` dir (anchored to the emitted bundle, never cwd). */
  readonly sourceDir: string;
  readonly installFs: InstallFs;
  /** `process.argv[1]` — rung 1 of the absolute-shim ladder. */
  readonly argv1: string | undefined;
  /** The MUTATING child seam. Used ONLY on the apply path, ONLY with RAW argv, never a shell. */
  readonly runChild: ServiceCommandSeam["runChild"];
  /** The four symlink-following fs seams (already narrowed fail-loud by the handler). */
  readonly follow: FollowSeams;
}

/** The byte cap for every config file `setup` reads. A client config is a small file by nature. */
export const SETUP_CONFIG_MAX_BYTES = 262_144;

/** Hard watchdog for the `claude` CLI child. A registration edit is a sub-second operation. */
export const CHILD_TIMEOUT_MS = 30_000;
