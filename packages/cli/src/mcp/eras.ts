// T-300 — THE ERA VOCABULARY: the two protocol revisions this server speaks, the cache policy
// it publishes on its cacheable results, and the server name both eras carry.
//
// WHY THIS FILE EXISTS AT ALL (D9). The v2 SDK exports exactly ONE of the two revisions we need:
// `LATEST_PROTOCOL_VERSION` is the latest LEGACY revision (byte-verified: `2025-11-25`), and it is
// re-exported below under the name that says what it actually is. The MODERN revision has NO public
// constant — `SUPPORTED_MODERN_PROTOCOL_VERSIONS` is marked "Internal — not part of the public API
// surface" and does not appear in `@modelcontextprotocol/server`'s type surface — so pinning our own
// is the honest option. It is NOT a guess left to rot: the dual-era suite asserts the LIVE wire's
// `server/discover` `supportedVersions` equals exactly `[MODERN_PROTOCOL_VERSION]`, so an SDK bump
// that moves the modern set reds there rather than drifting silently.
//
// WHY `SERVER_NAME` LIVES HERE. The modern-era golden renderer (`canonicalModernToolsList`, W3)
// needs it to predict the `_meta` serverInfo stamp, and `mcp.ts` needs it for the `Implementation`
// it hands the `Server`. Homing it in `mcp.ts` and importing it back into this file would make an
// eras↔mcp import cycle; homing it here makes this leaf the one source and `mcp.ts` a consumer.
import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import type { AnyCommandSpec } from "../commands/types";
import { visibleCommands } from "../commands/registry";
import { canonicalToolsList, type JsonObject, type JsonValue } from "./tool-defs";
import { VERSION } from "../version";

export { LATEST_PROTOCOL_VERSION as LEGACY_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

/**
 * The MODERN (`server/discover`) era revision. No public SDK constant exists for it (see the file
 * header); the dual-era suite pins the live wire's `supportedVersions` to exactly this value.
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** The MCP server name clients see in `initialize` and in the modern `_meta` serverInfo stamp.
 *  Matches the binary, deliberately. */
export const SERVER_NAME = "agkit";

/**
 * The cache TTL published on BOTH cacheable results (D4). One hour, and both bounds are load-bearing:
 *   • > 0 — the SDK's default is `ttlMs: 0`, which tells a client "re-fetch every time" and
 *     re-introduces exactly the polling that `listChanged: false` was designed to remove.
 *   • << 24 h — the roster is a property of the BUILD, so a version bump is the one event that can
 *     move it; a day-long TTL would outlive an upgrade.
 * The unit cell pins `0 < MCP_CACHE_TTL_MS < 86_400_000` and that both hint rows read this one
 * constant, so the two results can never publish different policies by drift.
 */
export const MCP_CACHE_TTL_MS = 3_600_000;

/**
 * `ServerOptions.cacheHints` (D4). `"public"` is honest for us and not a shortcut: the roster is
 * byte-identical for every client and every credential state (`static-list.test.ts` pins exactly
 * that across a mid-session auth flip), which is the case the spec's own security note blesses.
 *
 * Only these two methods are named because only these two are ours to publish: `tools/call` results
 * are not cacheable at all, and the rest of `CACHEABLE_RESULT_METHODS` (prompts/resources) are
 * surfaces this server does not implement. Invalid values would `RangeError` at `Server`
 * construction, so a typo here fails at boot rather than on the wire.
 */
export const MCP_CACHE_HINTS = {
  "tools/list": { ttlMs: MCP_CACHE_TTL_MS, cacheScope: "public" },
  "server/discover": { ttlMs: MCP_CACHE_TTL_MS, cacheScope: "public" },
} as const;

/** The `tools/list` result envelope as the MODERN era serializes it, plus its canonical bytes. */
export interface CanonicalModernToolsList {
  /** The canonical bytes: the RESULT object, 2-space indented, with exactly ONE trailing LF. */
  readonly json: string;
  /** The same object those bytes were produced from (canonical key order preserved). */
  readonly result: JsonObject;
}

/**
 * THE MODERN-ERA `tools/list` RESULT (D6/R7) — the whole envelope, not just the roster.
 *
 * WHY A SECOND GOLDEN AT ALL. `tools-list.golden.json` pins the tool ARRAY, which is exactly what
 * the 2025 wire carries (`{"tools":[…]}` and nothing else). The 2026 wire wraps that same array in
 * four SDK-authored members — `resultType`, the two cache fields and the `_meta` serverInfo stamp —
 * and those members are the ones this ticket introduced. A roster golden cannot see them, so a
 * regression that published `cacheScope:"private"`, dropped the serverInfo stamp or changed the
 * result kind would ship with every byte-lock green. This renders the ENVELOPE and the dual-era
 * suite locks the live modern frame to it.
 *
 * THE KEY ORDER IS A PREDICTION, AND THAT IS DELIBERATE. Nothing here runs the SDK: the object below
 * hand-reproduces the order its encode seam emits (`stampResultType` → `fillCacheFields` →
 * `stampServerInfoMeta`), byte-verified against the captured modern wire frames
 * (`plans/t300/transcripts/modern.txt`: `tools, resultType, ttlMs, cacheScope, _meta`). A prediction
 * is only honest if something checks it, so the dual-era suite compares this artifact against the
 * LIVE frame the server actually wrote — an SDK bump that reorders or renames the encode reds there
 * loudly instead of drifting past a golden that agrees only with itself.
 *
 * The values are read from the SAME sources production reads: the roster from `canonicalToolsList`
 * (the very objects the handler serves), the cache policy from `MCP_CACHE_HINTS`, the serverInfo
 * pair from `SERVER_NAME` + `VERSION` — so this is a re-serialization of production state, never a
 * second authoring site. `resultType: "complete"` is the one literal, and it is the SDK's own
 * vocabulary for a result that is not a task handle (D7 forbids production from ever setting it).
 */
export function canonicalModernToolsList(
  specs: readonly AnyCommandSpec[] = visibleCommands(),
): CanonicalModernToolsList {
  const { tools } = canonicalToolsList(specs);
  const result: JsonObject = {
    // The SAME objects the legacy golden pins — one roster, two envelopes.
    // `McpToolDef`'s members are `readonly` and its annotations carry no index signature, so the
    // structural JSON model needs the cast; `canonicalToolsList` has already proven the graph is
    // plain JSON (it canonicalizes and deep-freezes every node).
    tools: tools as unknown as JsonValue,
    resultType: "complete",
    ttlMs: MCP_CACHE_HINTS["tools/list"].ttlMs,
    cacheScope: MCP_CACHE_HINTS["tools/list"].cacheScope,
    _meta: { [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version: VERSION } },
  };
  return { json: `${JSON.stringify(result, null, 2)}\n`, result };
}
