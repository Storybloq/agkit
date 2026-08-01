// Cursor-drain helper for `--paginate` (T-211 step 4 — A8 / A9 / A10 / A35 + decision G).
//
// The drain composes the LANDED client seam per page: each page is one
// `ManagementClient.request` call, so every page already rode the retry engine (retry ×
// refresh × idempotency) by the time the drain sees a page object or a thrown outcome —
// the drain NEVER issues a bare fetch and owns none of that machinery. It maps the SERVER
// list envelope ({object:"list", data, has_more, next_cursor?} — next_cursor top-level,
// present IFF has_more) to the CLI's OWN output envelope (`meta.next_cursor`) — two
// different envelopes; the drain is the mapping.
//
// Failure discipline (the honesty spine):
//   • A9  — per-page invariant validation: a well-formed page is {object:"list", array
//           data, boolean has_more, next_cursor present IFF has_more}. A violation, or a
//           repeated cursor (cycle), is a TERMINAL protocol failure → A35.
//   • A35 — those terminal protocol failures take T-207's generic typed error path
//           (`CliLocalError("usage_error")`, exit 2 — no new code minted): an error
//           envelope carries NO items and advertises NO cursor (honest loss). Exit-3 +
//           `next_cursor` is reserved for GENUINELY resumable truncation.
//   • A8  — a mid-drain failure converts to the exit-3 partial path ONLY when ≥1 page was
//           already collected AND the failure is RESUMABLE (an exit-1 / RETRYABLE
//           disposition — retry-exhausted transient class). Its converse — "any exit-2
//           error PROPAGATES unchanged" — is the guard that a login / skew / forbidden /
//           bad-cursor failure is NEVER masked as an exit-3 partial (and a page-1 failure
//           has nothing to resume, so it propagates too).
//   • A10 — an exhausted transport failure keeps its items: it is normalized into the SAME
//           partial path as an exhausted retryable WIRE failure (both are exit-1), so
//           items-so-far are never lost to a thrown TypeError.
//   • A9 cap — a 1000-page safety cap is a RESUMABLE carve-out (NOT an A35 error): stop,
//           return the items collected + `meta.next_cursor` = the un-followed cursor + a
//           warning NAMING the cap. Re-running `--paginate --cursor <that>` continues.
//
// A partial result is `{ data: items, warnings:[…], meta:{ next_cursor } }` — the presence
// of `meta.next_cursor` makes `buildSuccessEnvelope` derive `partial:true`, which the
// serializer renders as exit 3 (the landed T-205/T-207 semantic — decision G).
import type { CommandResult, ManagementClient } from "../../commands/types";
import type { Operations } from "@agentkit-cloud/shared/wire-contract/management-types.gen";
import { CliLocalError, WireProblemError, classifyWireProblem, EXIT } from "../errors";
import { RetryableTransportError } from "./retry";

/**
 * Production page-safety cap (A9): the drain follows at most this many pages before it
 * stops and returns a resumable partial. A runaway/looping server must NOT hang the CLI
 * forever — 1000 pages × the server's ≤200/page ceiling is a very large result already.
 * Injectable (with THIS default) so a test can hit the cap without 1000 round-trips.
 */
export const DEFAULT_MAX_PAGES = 1000;

/** Tunable knobs for the drain (all defaulted; production only ever sets none). */
export interface DrainOptions {
  /** Page-safety cap; defaults to DEFAULT_MAX_PAGES (1000). */
  readonly maxPages?: number;
}

/** The three facts a valid list page carries, after A9 validation. */
interface ListPage {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
  /** A non-empty string IFF hasMore (A9 invariant); undefined otherwise. */
  readonly nextCursor: string | undefined;
}

/**
 * Validate ONE server response against the list-envelope invariant (A9) and normalize it,
 * or throw the A35 terminal protocol error. The invariant, verbatim from the frozen
 * management/v1.1.0 wire fact: an object with `object:"list"`, an array `data`, a boolean
 * `has_more`, and `next_cursor` present IFF `has_more` (a non-empty string when present).
 *
 * A violation is the SERVER breaking its own contract — a determinate protocol failure, not
 * a user fault and not something to auto-retry. It takes T-207's generic typed error path
 * (`usage_error`, exit 2), the SAME landed catch-all `index.ts` uses for an internal
 * unknown-operation fault — NO new code is minted (A35).
 */
function validateListPage(value: unknown): ListPage {
  const protocolFail = (reason: string): never => {
    throw new CliLocalError("usage_error", {
      detail: `the management API returned a response that violates the list-envelope contract (${reason}) — this is a server protocol error, not a request you can fix`,
    });
  };

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return protocolFail("the response is not a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (obj["object"] !== "list") {
    return protocolFail(`expected object:"list" (got ${JSON.stringify(obj["object"])})`);
  }
  if (!Array.isArray(obj["data"])) {
    return protocolFail(`the "data" field is not an array`);
  }
  const hasMore = obj["has_more"];
  if (typeof hasMore !== "boolean") {
    return protocolFail(`"has_more" is not a boolean (got ${JSON.stringify(hasMore)})`);
  }
  // next_cursor present IFF has_more — the load-bearing invariant, checked by PRESENCE
  // (own property), not value (codex step-4 review): an own `next_cursor: null` on a final
  // page is still the server breaking its contract, and tolerating it would mask exactly
  // the drift this validation exists to catch. Both directions are a protocol violation: a
  // truncated page with no cursor cannot be resumed, and a cursor on a final page is a
  // contradiction the drain must never trust.
  const hasNextCursor = Object.prototype.hasOwnProperty.call(obj, "next_cursor");
  const nextCursor = obj["next_cursor"];
  if (hasMore) {
    if (!hasNextCursor || typeof nextCursor !== "string" || nextCursor.length === 0) {
      return protocolFail(`has_more is true but next_cursor is absent or not a non-empty string`);
    }
  } else if (hasNextCursor) {
    return protocolFail(`has_more is false but a next_cursor was present`);
  }

  return { items: obj["data"], hasMore, nextCursor: hasMore ? (nextCursor as string) : undefined };
}

/**
 * Is a mid-drain failure RESUMABLE (A8)? YES exactly when its disposition is exit-1
 * (RETRYABLE): a retry-exhausted transport failure (network / timeout / 5xx / 429), OR an
 * exhausted retryable WIRE failure (internal_error / upstream_error / service_unavailable /
 * rate_limited — A10's "same partial path as wire failures"). Everything else — a CLI-local
 * terminal (version_skew), a request-preparation fault, a terminal wire code (token_expired
 * after a failed refresh, forbidden, invalid_request bad-cursor, an unknown code) — is
 * exit-2 and PROPAGATES unchanged, so a partial can NEVER mask one of those.
 */
function isResumableFailure(err: unknown): boolean {
  if (err instanceof RetryableTransportError) return true; // exit-1 by construction
  if (err instanceof WireProblemError) {
    return classifyWireProblem(err.problem).exitCode === EXIT.RETRYABLE;
  }
  return false;
}

/**
 * Build the resumable partial `CommandResult`: items-so-far + a NON-EMPTY warning +
 * `meta.next_cursor` = the cursor to resume from. `buildSuccessEnvelope` derives
 * `partial:true` from the cursor → the serializer renders exit 3.
 */
function partial(items: readonly unknown[], resumeCursor: string, warning: string): CommandResult {
  return { data: [...items], warnings: [warning], meta: { next_cursor: resumeCursor } };
}

/** A short, non-leaking reason for a resumable failure (the cursor itself rides in meta). */
function resumableReason(err: unknown): string {
  if (err instanceof RetryableTransportError) {
    switch (err.cause) {
      case "network":
        return "a network error";
      case "timeout":
        return "a request timeout";
      case "rate_limited":
        return "rate limiting (HTTP 429)";
      case "server":
        return err.status !== null ? `a server error (HTTP ${err.status})` : "a server error";
    }
  }
  if (err instanceof WireProblemError && typeof err.problem.status === "number") {
    return `a server error (HTTP ${err.problem.status})`;
  }
  return "a retryable error";
}

/**
 * Drain every page of a paginated list operation through the client seam. Returns a
 * `CommandResult` the handler returns verbatim:
 *   • full drain (last page has_more:false) → `{ data: items }` → exit 0;
 *   • resumable stop (mid-drain retry-exhausted failure OR the page-safety cap) →
 *     `{ data: items, warnings, meta.next_cursor }` → exit 3;
 *   • terminal failure (A35 protocol violation / cycle, or any exit-2 error) → THROWS,
 *     carrying no items (exit 2 via the landed dispatcher).
 *
 * `operationId` is a real management operation_id (compile-checked). `baseParams` are the
 * command's already-validated args (limit/cursor); the drain rewrites only `cursor` per page.
 */
export async function drainList<K extends keyof Operations>(
  client: ManagementClient,
  operationId: K,
  baseParams: Record<string, unknown>,
  opts: DrainOptions = {},
): Promise<CommandResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const items: unknown[] = [];
  // Cursors we have REQUESTED with (including a caller-supplied starting cursor). A
  // next_cursor equal to any of them is a cycle → A35 terminal (never an infinite loop).
  const seen = new Set<string>();
  const initialCursor = baseParams["cursor"];
  let cursor: string | undefined = typeof initialCursor === "string" ? initialCursor : undefined;
  if (cursor !== undefined) seen.add(cursor);
  let pages = 0;

  for (;;) {
    let raw: unknown;
    try {
      // One page = one seam call (it already ran retry × refresh × idempotency). `cursor`
      // undefined is omitted by prepareRequest, so page 1 with no starting cursor sends none.
      raw = await client.request({ operationId, params: { ...baseParams, cursor } });
    } catch (err) {
      // A8: convert to a resumable partial ONLY with ≥1 page collected AND a resumable
      // (exit-1) failure. `cursor` here is the cursor that would re-fetch THIS failed page —
      // the LAST GOOD cursor (A10 keeps the items collected so far). Otherwise PROPAGATE
      // unchanged: a page-1 failure has nothing to resume, and an exit-2 error must surface
      // as itself — never an exit-3 partial masking a login / skew / forbidden failure.
      if (pages >= 1 && isResumableFailure(err) && cursor !== undefined) {
        // The cursor value rides ONLY in meta.next_cursor (codex step-4 review): a server-
        // provided opaque token is never interpolated into human-facing text that reads as a
        // copyable shell command — a hostile cursor could smuggle metacharacters into it.
        return partial(
          items,
          cursor,
          `pagination stopped after ${pages} page(s): fetching the next page failed with ${resumableReason(err)} — re-run with --paginate, passing meta.next_cursor as --cursor, to resume`,
        );
      }
      throw err;
    }

    const pageResult = validateListPage(raw); // A9/A35: throws terminal on any violation
    for (const item of pageResult.items) items.push(item);
    pages += 1;

    if (!pageResult.hasMore) {
      // Full drain — the authoritative end of the list. No cursor, no partial → exit 0.
      return { data: items };
    }

    // has_more ⇒ nextCursor is a non-empty string (A9-guaranteed).
    const nextCursor = pageResult.nextCursor as string;
    if (seen.has(nextCursor)) {
      // A35: a repeated cursor is a cycle — a terminal protocol failure, NOT a resumable
      // partial (advertising the looping cursor would just re-trigger the loop).
      throw new CliLocalError("usage_error", {
        detail: `pagination cursor cycle detected: the management API returned a cursor already followed in this drain — aborting to avoid an infinite loop (server protocol error)`,
      });
    }

    if (pages >= maxPages) {
      // A9 page-safety cap — a RESUMABLE carve-out (not an error): stop, advertise the
      // un-followed cursor (in meta ONLY — never interpolated into the warning), and NAME
      // the cap in the warning so the stop is observable.
      return partial(
        items,
        nextCursor,
        `pagination stopped at the ${maxPages}-page safety cap after collecting ${items.length} item(s); more pages remain — re-run with --paginate, passing meta.next_cursor as --cursor, to continue past the cap`,
      );
    }

    seen.add(nextCursor);
    cursor = nextCursor;
  }
}

/**
 * Bounded EARLY-STOP cursor search (T-214 C-5). Pages a list operation and returns the FIRST row
 * matching `predicate`, checking each page ON ARRIVAL and returning IMMEDIATELY on a match — this is
 * NOT a full `drainList` accumulator (it never collects, it stops at the first hit). It reuses the
 * SAME per-page invariant validation (`validateListPage`, A9/A35), cursor-cycle detection, and
 * `DEFAULT_MAX_PAGES` cap `drainList` uses.
 *
 * Failure discipline (mirrors `drainList`, minus the exit-3 partial — a search has no items to
 * resume):
 *   • a per-page protocol violation (A9) OR a repeated cursor (cycle) OR the page-safety cap →
 *     THROWS the SAME terminal `CliLocalError("usage_error")` protocol-error style;
 *   • a mid-search retry-exhausted transport/wire failure PROPAGATES unchanged (each page is one
 *     seam call, so the retry engine already ran) — the attested-key revoke `prepare` converts BOTH
 *     that and every terminal throw into its teachable `--if-match` hint (it must NEVER guess a
 *     verdict from an incomplete walk).
 *
 * Returns the matching row, or `undefined` when a provably-COMPLETE walk (a `has_more:false` page
 * reached) found none. `operationId` is a real management operation_id (compile-checked); the caller
 * sets the page `limit` in `baseParams` (attested-key revoke uses 200 — the server per-page max).
 */
export async function findInList<K extends keyof Operations>(
  client: ManagementClient,
  operationId: K,
  baseParams: Record<string, unknown>,
  predicate: (row: unknown) => boolean,
  opts: DrainOptions = {},
): Promise<unknown | undefined> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // Cursors REQUESTED with (incl. a caller-supplied start). A next_cursor equal to any is a cycle.
  const seen = new Set<string>();
  const initialCursor = baseParams["cursor"];
  let cursor: string | undefined = typeof initialCursor === "string" ? initialCursor : undefined;
  if (cursor !== undefined) seen.add(cursor);
  let pages = 0;

  for (;;) {
    // One page = one seam call (retry × refresh × idempotency already ran). A retry-exhausted
    // failure PROPAGATES — the revoke prepare converts it to the teachable --if-match hint.
    const raw = await client.request({ operationId, params: { ...baseParams, cursor } });
    const pageResult = validateListPage(raw); // A9/A35: throws terminal on any protocol violation
    pages += 1;

    // Early stop: scan THIS page on arrival and return the first match — no accumulator.
    for (const item of pageResult.items) {
      if (predicate(item)) return item;
    }

    // A provably-complete walk with no match → undefined (an honest "not present", never a guess).
    if (!pageResult.hasMore) return undefined;

    // has_more ⇒ nextCursor is a non-empty string (A9-guaranteed).
    const nextCursor = pageResult.nextCursor as string;
    if (seen.has(nextCursor)) {
      // A35: a repeated cursor is a cycle — a terminal protocol failure (the caller must not trust a
      // verdict from a looping walk), NEVER an infinite loop.
      throw new CliLocalError("usage_error", {
        detail: `pagination cursor cycle detected: the management API returned a cursor already followed in this search — aborting to avoid an infinite loop (server protocol error)`,
      });
    }
    if (pages >= maxPages) {
      // A9 page-safety cap: a search that has not converged within the cap is terminal — the
      // candidate set is unknowable, so any verdict would be a guess. (Unlike drainList's resumable
      // partial: a search has no accumulated items to return.)
      throw new CliLocalError("usage_error", {
        detail: `pagination did not complete within the ${maxPages}-page safety cap while searching the list — aborting (the search set is unknowable; server protocol error)`,
      });
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}

/**
 * Map a SINGLE list page (the no-`--paginate` path) to a `CommandResult` — decision G: a
 * truncated single page (has_more:true) surfaces `meta.next_cursor` and so exits 3, while a
 * complete single page (has_more:false) exits 0 with no cursor. Shares `validateListPage`,
 * so a malformed single page is the SAME A35 terminal as a malformed drain page.
 */
export function singlePageResult(raw: unknown): CommandResult {
  const pageResult = validateListPage(raw);
  const result: CommandResult = { data: [...pageResult.items] };
  if (pageResult.hasMore) {
    result.meta = { next_cursor: pageResult.nextCursor as string };
  }
  return result;
}

/**
 * Read the COMPLETE row set of a `paginated:false` list route (profile.list / tool.list — the
 * route rows are authoritative: one request returns everything, `has_more` is always false).
 *
 * For a CONSUMER that reasons over the whole set — client-side slug→id resolution, or the sync
 * ceremony's live-state diff — a shape-invalid or TRUNCATED response must never degrade into a
 * silent partial. Returning `[]` (or a first page) on a malformed envelope would let a server
 * fault masquerade as real state: resolution would teach "no such profile" for a row that exists,
 * and the sync preview would show every file profile as a `create` with no `retained` warnings —
 * an operator confirming a PR-danger write against a review computed from a lie.
 *
 * So BOTH failures are TERMINAL protocol errors on T-207's generic typed path (A35 —
 * `usage_error`, exit 2, no new code minted), exactly like the drain's per-page violations:
 *   • any list-envelope invariant violation (`validateListPage`);
 *   • `has_more:true` on a route the contract declares non-paginated (a truncated set).
 */
export function readCompleteList(raw: unknown): readonly unknown[] {
  const page = validateListPage(raw);
  if (page.hasMore) {
    throw new CliLocalError("usage_error", {
      detail:
        "the management API truncated a non-paginated list route (has_more:true) — the complete set is unavailable, so this result cannot be trusted (server protocol error, not a request you can fix)",
    });
  }
  return page.items;
}
