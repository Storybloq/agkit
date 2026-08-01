// The PARENT side of the truly-non-blocking update check (T-209, canonical L2-CLI-19,
// deliverable 3 / ISS-570, codex C4/M5). The check must NOT delay process exit: an
// un-awaited in-process `fetch` keeps the event loop alive, so instead we spawn a
// DETACHED child (`node dist/update-check.js <stampPath> <version>`, stdio ignored,
// `.unref()`) that does the network probe + stamp write in its OWN process and exits.
// The parent decides ONLY whether to spawn — gated by a 24h cache and an offline
// backoff so an unreachable registry does not spawn a child on every command. All
// deps are injected (env, clock, stamp reader, spawn) so the gate is unit-tested with
// no real fs / network / process.
import { parseIsoMs } from "./version-util";

/** Re-check no more than once per 24h once we have a successful stamp (M5). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** After a FAILED attempt, wait this long before retrying (M5) — regardless of whether
 * a (now-stale) good stamp is also present, so an offline box does not spawn a child on
 * every command just because it once succeeded. */
export const UPDATE_CHECK_BACKOFF_MS = 60 * 60 * 1000;

/** Everything the parent kick needs — all injected. */
export interface UpdateKickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  /** `<config-dir>/state/update-check.json` — where the child writes, the banner reads. */
  readonly stampPath: string;
  /** The running binary VERSION (passed to the child for comparison). */
  readonly version: string;
  /** `process.execPath` — the node binary that runs the helper. */
  readonly execPath: string;
  /** `dist/update-check.js` — the detached helper entry (resolved from import.meta.url). */
  readonly helperPath: string;
  /** Read the stamp file as utf8; null if absent. */
  readonly readStampText: (path: string) => string | null;
  /** spawn(cmd, args, {detached:true, stdio:'ignore'}).unref() — returns immediately. */
  readonly spawnDetached: (cmd: string, args: string[]) => void;
}

export type KickStatus =
  | "disabled" // AGKIT_NO_UPDATE_CHECK=1
  | "fresh" // a successful stamp < 24h old — skip
  | "backoff" // no good stamp but a recent failed attempt — skip (offline)
  | "spawned"; // launched the detached helper

type Gate = "fresh" | "backoff" | "spawn";

/**
 * Decide + (maybe) launch the detached update check. Returns a status for tests /
 * diagnostics. Never blocks: the only work is a small stamp read + (at most) a
 * detached, unref'd spawn. `AGKIT_NO_UPDATE_CHECK=1` disables it entirely.
 */
export function kickUpdateCheck(deps: UpdateKickDeps): KickStatus {
  if (deps.env.AGKIT_NO_UPDATE_CHECK === "1") return "disabled";
  const gate = updateCheckGate(deps);
  if (gate !== "spawn") return gate;
  // Detached: the child outlives us, writes the stamp, and exits on its own.
  deps.spawnDetached(deps.execPath, [deps.helperPath, deps.stampPath, deps.version]);
  return "spawned";
}

/**
 * 24h cache + offline backoff. A successful `checked_at` within 24h -> fresh. Otherwise,
 * a `last_attempt_at` within the backoff window -> backoff (offline: don't spawn every
 * command) — this holds EVEN when a now-stale `checked_at` is also present, because the
 * child preserves the stale success field and only bumps `last_attempt_at` on a failed
 * refresh; gating backoff on `checked_at === null` would re-spawn a child on every
 * command for a box that once succeeded and is now offline (M5 regression, codex chunk-C).
 * A malformed/absent stamp -> spawn.
 */
function updateCheckGate(deps: UpdateKickDeps): Gate {
  const raw = deps.readStampText(deps.stampPath);
  if (raw === null) return "spawn"; // never checked
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "spawn"; // corrupt stamp -> refresh
  }
  if (parsed === null || typeof parsed !== "object") return "spawn";
  const stamp = parsed as { checked_at?: unknown; last_attempt_at?: unknown };
  const checkedAt = parseIsoMs(stamp.checked_at);
  if (checkedAt !== null && deps.now() - checkedAt < UPDATE_CHECK_INTERVAL_MS) return "fresh";
  const attemptAt = parseIsoMs(stamp.last_attempt_at);
  if (attemptAt !== null && deps.now() - attemptAt < UPDATE_CHECK_BACKOFF_MS) return "backoff";
  return "spawn";
}
