// State-dir CAPABILITY-ADVERTISEMENT cache (T-211 step 5 — A25 / A32). A reserved
// capability-gated command reads the server's advertised capabilities from HERE before
// dispatch; a fresh hit avoids a pre-flight `discovery.get`, a miss triggers exactly one
// (preflight.ts). The cache is a pure OPTIMISATION — every read/write is BEST-EFFORT:
// a fault is a MISS / a swallowed write, never an error (the gate stays correct without it).
//
// Identity + freshness (A32): an entry is keyed by (canonical API origin, profile, management
// major) AND fingerprinted by the credential, and expires after 24h. A profile switch, an
// origin switch, a major bump, or a credential change each MISS (different key or fingerprint) —
// so a cached advertisement is never trusted across a context the server would answer differently.
//
// Storage: `<state-dir>/capability-cache.json` (never secrets — the credential is stored only as
// a non-reversible fingerprint), a keyed map so one context's entry never evicts another's,
// written ATOMICALLY (temp + rename) with 0600 perms.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirPath, type ConfigDirDeps } from "../config/dirs";

/** Advertisement lifetime (A32). Injected `now` (ms) drives freshness — no `Date.now()` here. */
export const CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The context an advertisement is scoped to (A32). */
export interface CapabilityCacheKey {
  /** The canonical, guard-approved management API origin. */
  readonly origin: string;
  /** The effective profile. */
  readonly profile: string;
  /** The management MAJOR the CLI is pinned to. */
  readonly major: string;
}

interface CacheEntry {
  readonly capabilities: string[];
  readonly stored_at: number;
  /** Non-secret fingerprint of the credential the advertisement was fetched under. */
  readonly credential_fp: string;
}

interface CacheFile {
  readonly entries: Record<string, CacheEntry>;
}

/** The map key for a cache context (stable, collision-resistant on the three fields). */
function keyString(key: CapabilityCacheKey): string {
  return `${key.origin}\x00${key.profile}\x00${key.major}`;
}

/**
 * A non-reversible, non-secret fingerprint of a credential token (SHA-256 hex). Deterministic
 * (no entropy seam needed) and the token itself is NEVER persisted — only this digest — so the
 * cache stays a non-secret file while still invalidating on a credential change. CRYPTOGRAPHIC
 * strength is load-bearing for A32: a short non-crypto hash (32-bit FNV) permits practical
 * collisions, and a collision serves a STALE advertisement across a credential change for the
 * full TTL. An empty token (unauthenticated context) maps to an EXPLICIT sentinel outside the
 * digest domain — never a hash-of-empty-string that a crafted token could collide toward.
 */
export function credentialFingerprint(token: string): string {
  if (token === "") return "anonymous";
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `<state-dir>/capability-cache.json`. */
export function capabilityCachePath(deps: ConfigDirDeps): string {
  return join(stateDirPath(deps), "capability-cache.json");
}

function parseCacheFile(text: string): CacheFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const entries = (parsed as { entries?: unknown }).entries;
  if (entries === null || entries === undefined || typeof entries !== "object") return null;
  return { entries: entries as Record<string, CacheEntry> };
}

/**
 * Read the FRESH cached advertisement for `key` under `credentialFp`, or `null` on any miss:
 * absent file, unparseable file, no entry for this key, a credential-fingerprint mismatch, or an
 * expired entry (`now - stored_at > TTL`). Best-effort — a read fault is a miss.
 */
export function readCapabilityCache(
  deps: ConfigDirDeps,
  key: CapabilityCacheKey,
  credentialFp: string,
  now: number,
): readonly string[] | null {
  let text: string;
  try {
    text = readFileSync(capabilityCachePath(deps), "utf8");
  } catch {
    return null;
  }
  const file = parseCacheFile(text);
  if (file === null) return null;
  const entry = file.entries[keyString(key)];
  if (
    entry === undefined ||
    !Array.isArray(entry.capabilities) ||
    typeof entry.stored_at !== "number" ||
    typeof entry.credential_fp !== "string"
  ) {
    return null;
  }
  if (entry.credential_fp !== credentialFp) return null; // credential changed → miss (A32)
  // A future/non-finite stored_at (clock rollback, malformed file) is untrustworthy — it would
  // otherwise EXTEND the TTL (negative age). Miss rather than trust it.
  if (!Number.isFinite(entry.stored_at) || entry.stored_at > now) return null;
  if (now - entry.stored_at > CAPABILITY_CACHE_TTL_MS) return null; // expired
  return entry.capabilities.filter((c): c is string => typeof c === "string");
}

/**
 * Write the advertisement for `key` under `credentialFp`, MERGING with any existing entries (a
 * different context's entry survives), atomically (temp + rename) with 0600 perms. Best-effort —
 * a write fault is swallowed (the caller already holds the value; the cache is an optimisation).
 */
export function writeCapabilityCache(
  deps: ConfigDirDeps,
  key: CapabilityCacheKey,
  credentialFp: string,
  capabilities: readonly string[],
  now: number,
): void {
  try {
    const dir = stateDirPath(deps);
    mkdirSync(dir, { recursive: true });
    const path = capabilityCachePath(deps);

    let existing: CacheFile = { entries: {} };
    try {
      const parsed = parseCacheFile(readFileSync(path, "utf8"));
      if (parsed !== null) existing = parsed;
    } catch {
      /* start fresh */
    }

    const next: CacheFile = {
      entries: {
        ...existing.entries,
        [keyString(key)]: { capabilities: [...capabilities], stored_at: now, credential_fp: credentialFp },
      },
    };
    // Temp path is process- + now-scoped so a concurrent writer never clobbers ours mid-rename.
    const tmp = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* best-effort: a cache write must never fail a command */
  }
}
