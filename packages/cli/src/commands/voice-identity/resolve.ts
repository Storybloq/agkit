// T-220 §2-S3 — voice-identity provider resolution. Every keyed identity op's wire path is
// `…/voice-identities/{provider}/{key}`, but the ticket grammar gives only `<key>`; when
// `--provider` is absent the CLI resolves it by scanning `identity.list` (same-family read:
// identities:read ⊆ identities:write|destroy by the scope ladder). The scan is BOUNDED
// (maxPages 5 — 5×200 = 1,000 identities, an order of magnitude above any plan identity cap,
// AM-2 R-B3) and honor-or-reject: 0 matches teach, exactly 1 resolves, ≥2 (the composite
// natural key permits the same key under two providers) DEMANDS --provider — never a pick.
// A truncated scan (page cap or a mid-drain resumable failure) NEVER resolves: acting on a
// partial scan could address the WRONG provider's identity.
import { drainList } from "../../core/client/paginate";
import { CliLocalError } from "../../core/errors";
import { requireProject, type Ctx } from "../types";
import { displayCapped } from "../../core/output/display";

/** AM-2 R-B3: the bounded scan depth (pages of the server's ≤200/page ceiling). */
export const IDENTITY_RESOLVE_MAX_PAGES = 5;

// R-V1 rendered-width caps: the key is user argv (≤128); provider names are server-derived
// (≤64 each, ≤5 named + "+N more" — R-B4).
const KEY_CAP = 128;
const PROVIDER_CAP = 64;
const PROVIDER_NAME_LIMIT = 5;

const TRUNCATED_SCAN_DETAIL =
  "the voice-identity list could not be fully scanned to resolve this key — pass --provider to address the identity directly";

const ROW_PROTOCOL_DETAIL =
  "the management API returned a voice-identity row without its key/provider members — this is a server protocol error, not a request you can fix";

/** Resolve the provider owning `key`, or throw the teachable 0/≥2/truncation refusals. */
export async function resolveIdentityProvider(ctx: Ctx, key: string): Promise<{ provider: string }> {
  const pid = requireProject(ctx);
  const result = await drainList(ctx.client, "identity.list", { pid }, { maxPages: IDENTITY_RESOLVE_MAX_PAGES });
  if ((result.meta as { next_cursor?: unknown } | undefined)?.next_cursor !== undefined) {
    throw new CliLocalError("usage_error", { detail: TRUNCATED_SCAN_DETAIL });
  }

  const rows = result.data as readonly unknown[];
  const providers: string[] = [];
  for (const row of rows) {
    const r = row !== null && typeof row === "object" ? (row as Record<string, unknown>) : null;
    const rowKey = r?.["key"];
    const rowProvider = r?.["provider"];
    if (typeof rowKey !== "string" || rowKey.length === 0 || typeof rowProvider !== "string" || rowProvider.length === 0) {
      // A35 class: a row the server is contractually bound to shape (voice-identities.ts:50-59
      // list projection) arriving malformed is a terminal protocol failure, never a silent skip
      // (skipping could turn a real match into a confident, wrong "no such key").
      throw new CliLocalError("usage_error", { detail: ROW_PROTOCOL_DETAIL });
    }
    if (rowKey === key) providers.push(rowProvider);
  }

  if (providers.length === 0) {
    throw new CliLocalError("usage_error", {
      detail: `no voice identity with key '${displayCapped(key, KEY_CAP)}'`,
      hint: "agkit voice-identity list",
    });
  }
  if (providers.length > 1) {
    const named = providers.slice(0, PROVIDER_NAME_LIMIT).map((p) => displayCapped(p, PROVIDER_CAP));
    const overflow = providers.length - named.length;
    const list = overflow > 0 ? `${named.join(", ")} +${overflow} more` : named.join(", ");
    throw new CliLocalError("usage_error", {
      detail: `identity key '${displayCapped(key, KEY_CAP)}' exists under multiple providers (${list}) — pass --provider to disambiguate`,
    });
  }
  return { provider: providers[0]! };
}
