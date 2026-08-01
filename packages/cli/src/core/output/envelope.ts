// Wire-envelope shapes (T-205, canonical L2-CLI-03, deliverable 2). This REPLACES
// the provisional `src/cli/envelope.ts` `{ ok, data, meta }` scaffold.
//
// The discriminator is the PRESENCE of `data` vs `error` — NOT an `ok` boolean
// (the provisional `ok` field is removed). Every envelope carries a top-level
// integer `version` (the envelope-schema version, see contract.ts), independent
// of the server's `management_version`.
//
//   success      : { version, data }
//   error        : { version, error: { code, message, ... } }
//   list/partial : { version, data: [...], warnings: [...], partial: true,
//                    meta: { next_cursor } }
import { ENVELOPE_VERSION } from "../../contract";
import type { CommandResult } from "../../commands/types";

export interface SuccessEnvelope {
  version: number;
  data: unknown;
  warnings?: string[];
  /** Set when the result is a truncated page (a `next_cursor` is present). */
  partial?: true;
  /** Contract facts (version/status) or pagination facts (`next_cursor`). */
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  version: number;
  error: {
    code: string;
    message: string;
    /** Teachable extras (e.g. `available_fields` on `unknown_field`). */
    [key: string]: unknown;
  };
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

/**
 * Reserved `CommandResult.meta` marker: a handler that legitimately produces a
 * shown-once secret (the `token create` / `publishable-key create` path, T-206+)
 * sets `meta[SHOWN_ONCE_META_KEY]` to the EXACT freshly-minted secret VALUE (a
 * string, or a string[] for more than one) to opt exactly those value(s) into the
 * unredacted shown-once path for its one render. The serializer consumes the
 * marker (it never appears in output) and passes the exact-value allowlist to the
 * redaction registry — which discloses ONLY those values, never a blanket bypass.
 */
export const SHOWN_ONCE_META_KEY = "__shownOnceSecret";

/** The presence-of-`error` discriminator (deliverable 2 — no `ok` boolean). */
export function isErrorEnvelope(envelope: Envelope): envelope is ErrorEnvelope {
  return (
    typeof (envelope as ErrorEnvelope).error === "object" &&
    (envelope as ErrorEnvelope).error !== null
  );
}

/**
 * The exact freshly-minted secret value(s) this result opts into the shown-once
 * (unredacted) path. A string marker yields one; a string[] yields many; anything
 * else yields none. These EXACT strings — and nothing else — are disclosed.
 */
export function shownOnceSecrets(result: CommandResult): string[] {
  const marked = result.meta?.[SHOWN_ONCE_META_KEY];
  if (typeof marked === "string") return [marked];
  if (Array.isArray(marked)) return marked.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Wrap a successful handler `CommandResult` into the success/list envelope.
 * `partial: true` is DERIVED (a top-level fact) from an explicit `meta.partial`
 * or the presence of `meta.next_cursor`; `next_cursor` itself stays in `meta`.
 */
export function buildSuccessEnvelope(result: CommandResult): SuccessEnvelope {
  const envelope: SuccessEnvelope = { version: ENVELOPE_VERSION, data: result.data };

  if (result.warnings && result.warnings.length > 0) {
    envelope.warnings = [...result.warnings];
  }

  const meta: Record<string, unknown> = { ...(result.meta ?? {}) };
  // The shown-once marker is a control signal, never output.
  delete meta[SHOWN_ONCE_META_KEY];

  const explicitPartial = meta["partial"] === true;
  const nextCursor = meta["next_cursor"];
  // `partial` is a top-level envelope fact, not a passthrough meta key.
  delete meta["partial"];
  if (explicitPartial || (nextCursor !== undefined && nextCursor !== null)) {
    envelope.partial = true;
  }

  if (Object.keys(meta).length > 0) envelope.meta = meta;
  return envelope;
}

/** Build an error envelope. Optional `extra` carries teachable fields. */
export function buildErrorEnvelope(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  return { version: ENVELOPE_VERSION, error: { code, message, ...(extra ?? {}) } };
}
