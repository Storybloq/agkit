// The dashboard deep-link seam (T-222 Step 8; T-223 `account security` is the SECOND consumer).
// The dashboard origin is SERVER-OWNED and DERIVED, never hardcoded (D-10): the ONE validated place
// it lives is the RFC 8414 AS-metadata `authorization_endpoint` ("dashboard origin ≠ api origin",
// as-metadata.ts). `resolveDashboardOrigin` consumes that live; `joinDashboardPage` appends an
// OPTIONAL page through a CLOSED path grammar, then origin-pins the result twice (grammar +
// post-join `.origin` assertion) and re-serializes through the browser-open validator before any
// launch. A metadata failure PROPAGATES as `AsMetadataError` (the caller maps it to a loud
// retryable error — never a fabricated URL, §B-9).
import { fetchAsMetadata, type AsMetadataDeps } from "../auth/as-metadata";
import { validateOpenableUrl } from "../auth/open-url";
import { CliLocalError } from "../errors/cli-codes";

/**
 * The closed page grammar (§4.8): lowercase alphanumeric segments joined by `/`. Each segment starts
 * and ends with `[a-z0-9]` and may carry interior hyphens. This STRUCTURALLY excludes `..`, `//`, an
 * empty segment, `\`, `:`, `?`, `#`, `@`, whitespace, and uppercase — so a crafted page can never
 * introduce a scheme, an authority, a traversal, or a query/fragment that moves the origin.
 */
export const PAGE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Resolve the dashboard ORIGIN for `apiUrl` (the guard-approved management base URL). Fetches +
 * validates the AS metadata and returns the ORIGIN of its `authorization_endpoint` (already
 * validated https / re-serialized by `fetchAsMetadata`). Throws `AsMetadataError` (fail-closed) on
 * any fetch/parse/skew/size violation — the caller maps that to a loud retryable failure (D-10).
 */
export async function resolveDashboardOrigin(deps: AsMetadataDeps, apiUrl: string): Promise<string> {
  const meta = await fetchAsMetadata(deps, apiUrl);
  return new URL(meta.authorizationEndpoint).origin;
}

/**
 * Validate a page against the closed grammar, throwing a STATIC `usage_error` (never echoing the
 * page value) on a miss. Exposed so the handler can reject a bad page BEFORE the metadata fetch —
 * a grammar failure must cost ZERO network I/O. `joinDashboardPage` calls it too (single source).
 */
export function validateDashboardPage(page: string): void {
  if (!PAGE_RE.test(page)) {
    throw new CliLocalError("usage_error", {
      detail:
        "the dashboard page must be a '/'-joined path of lowercase alphanumeric segments (e.g. 'account/security')",
      hint: "agkit dashboard --help",
    });
  }
}

/**
 * Join an OPTIONAL page onto `origin`, returning a validated, re-serialized https URL. `origin` is
 * the value `resolveDashboardOrigin` produced (an https/loopback origin). With no page it returns
 * the bare dashboard URL. A page is validated against `PAGE_RE` FIRST (a miss → a STATIC
 * `usage_error` that never echoes the page value), then the joined URL's `.origin` is asserted equal
 * to `origin` (fail-closed defence in depth), then `validateOpenableUrl` re-serializes it before it
 * can reach the OS launcher.
 */
export function joinDashboardPage(origin: string, page?: string): string {
  if (page === undefined) {
    return validateOpenableUrl(origin);
  }
  validateDashboardPage(page);
  let joined: URL;
  try {
    joined = new URL(`${origin}/${page}`);
  } catch {
    throw new CliLocalError("usage_error", {
      detail: "the dashboard page did not form a valid URL",
      hint: "agkit dashboard --help",
    });
  }
  if (joined.origin !== origin) {
    // Unreachable given PAGE_RE, but a page that ever moved the origin is a hard refusal, not a warn.
    throw new CliLocalError("usage_error", {
      detail: "the dashboard page would change the dashboard origin — refusing",
      hint: "agkit dashboard --help",
    });
  }
  return validateOpenableUrl(joined.href);
}
