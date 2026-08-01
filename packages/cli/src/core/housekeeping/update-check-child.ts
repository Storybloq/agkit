// The CHILD side of the non-blocking update check (T-209, canonical L2-CLI-19,
// deliverable 3 / ISS-570, codex C4). This runs in the DETACHED helper process
// (src/update-check.ts -> dist/update-check.js) that preCommandHousekeeping spawns.
// It probes the npm registry with a hard timeout + bounded, validated response, then
// ATOMICALLY writes the update-check stamp; on ANY error it preserves the last-good
// stamp and records `last_attempt_at` so the parent's offline backoff engages. All
// deps are injected (fetch, clock, stamp read/write) so the whole flow is unit-tested
// with no real network / fs. This module NEVER performs skill install or any other
// housekeeping — it does exactly one thing and exits.
import { isValidVersion, parseIsoMs } from "./version-util";

/**
 * The published npm package identity — the SINGLE source of truth (T-222 step 7). The registry
 * URL below and `agkit upgrade`'s `npm install -g <name>@latest` argv both derive from it, so a
 * rename can never leave one call site pointing at a stale name. Byte-equal to `package.json:2`.
 */
export const PACKAGE_NAME = "@shyegg/agkit";
/** The `latest` dist-tag endpoint — its JSON carries a top-level `.version`. Derived from `PACKAGE_NAME`. */
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** Hard timeout for the whole request (AbortController) — the check is best-effort. */
export const FETCH_TIMEOUT_MS = 3000;
/** Cap the response we will read/parse — an attacker/misconfig cannot force a huge read. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The child re-applies the same 24h freshness gate (benign races; last-writer-wins). */
export const CHILD_FRESH_MS = 24 * 60 * 60 * 1000;

/** Everything the child needs — all injected. */
export interface UpdateCheckChildDeps {
  /** `[stampPath, currentVersion]` (from `process.argv.slice(2)`). */
  readonly argv: readonly string[];
  readonly now: () => number;
  readonly nowIso: () => string;
  /** The global `fetch` (Node 18+ built-in) — injected so tests supply a stub. */
  readonly fetch: typeof globalThis.fetch;
  /** Read the stamp as utf8; null if absent. */
  readonly readStampText: (path: string) => string | null;
  /** Atomic temp-file + rename write of the stamp (mode 0600). */
  readonly writeStampAtomic: (path: string, data: string) => void;
}

type StampObject = Record<string, unknown>;

/**
 * Run the update check. Resolves (never rejects) — the caller is a best-effort helper
 * whose only job is to leave a good stamp or a backoff marker behind. Idempotent under
 * a fresh stamp (skips the network); on success writes `{latest_version, checked_at}`;
 * on failure preserves the last-good fields and stamps `last_attempt_at`.
 */
export async function runUpdateCheckChild(deps: UpdateCheckChildDeps): Promise<void> {
  const stampPath = deps.argv[0];
  if (typeof stampPath !== "string" || stampPath.length === 0) return;

  const existing = readStamp(deps, stampPath);
  // Freshness re-check inside the child: a racing parent may have spawned two children;
  // the second sees a fresh stamp and does nothing. Atomic rename makes the race benign.
  const checkedAt = parseIsoMs(existing?.checked_at);
  if (checkedAt !== null && deps.now() - checkedAt < CHILD_FRESH_MS) return;

  try {
    const latest = await fetchLatestVersion(deps);
    deps.writeStampAtomic(
      stampPath,
      JSON.stringify({ latest_version: latest, checked_at: deps.nowIso() }) + "\n",
    );
  } catch {
    // A racing sibling child (the parent may have spawned two) could have written a
    // FRESH success while our request was in flight. Re-read and skip the backoff write
    // when the current stamp is already fresh, so we don't clobber a sibling's success
    // with our stale snapshot + last_attempt_at (codex chunk-C). This closes the common
    // case; a success landing in the tiny re-read -> write window is a BENIGN residual —
    // a delayed update NOTICE, never corruption. (A bulletproof fix would split success
    // and attempt into separate files, or use a compare-and-swap write; disproportionate
    // for a best-effort nag.) Otherwise preserve the last-good fields + record the attempt.
    const current = readStamp(deps, stampPath);
    const currentCheckedAt = parseIsoMs(current?.checked_at);
    if (currentCheckedAt !== null && deps.now() - currentCheckedAt < CHILD_FRESH_MS) return;
    const preserved: StampObject = current ?? (existing ? { ...existing } : {});
    preserved.last_attempt_at = deps.nowIso();
    try {
      deps.writeStampAtomic(stampPath, JSON.stringify(preserved) + "\n");
    } catch {
      /* even the backoff write failed — give up; the parent simply retries later */
    }
  }
}

/** Parse the stamp file into a plain object, or null if absent/malformed. */
function readStamp(deps: UpdateCheckChildDeps, path: string): StampObject | null {
  const raw = deps.readStampText(path);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as StampObject) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch + validate the latest published version. Enforces a timeout, a 200, a bounded
 * body, JSON shape, and a valid-semver `.version`. Throws on any violation (the caller
 * turns that into a backoff). Always clears the timeout + drains the body.
 */
async function fetchLatestVersion(deps: UpdateCheckChildDeps): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await deps.fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry status ${res.status}`);
    const declaredLen = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      throw new Error("registry response too large");
    }
    const text = await readBoundedUtf8(res);
    const body = JSON.parse(text) as { version?: unknown };
    const version = body.version;
    if (typeof version !== "string" || !isValidVersion(version)) {
      throw new Error("registry response missing a valid version");
    }
    return version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body as utf8, aborting the moment the ACCUMULATED bytes exceed
 * MAX_BODY_BYTES. Streaming the bytes (rather than `await res.text()` then checking
 * `.length`) bounds peak memory to MAX_BODY_BYTES + one stream chunk — undici (Node's
 * fetch) emits small socket-sized chunks, so a chunked or lying-Content-Length response
 * can never buffer the whole flood before the check trips (codex chunk-C). Falls back to
 * `text()` (still post-checked) only for a bodyless response.
 */
async function readBoundedUtf8(res: Response): Promise<string> {
  const body = res.body;
  if (body === null) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("registry response too large");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) throw new Error("registry response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* releasing the stream lock is best-effort */
    });
  }
  return Buffer.concat(chunks).toString("utf8");
}
