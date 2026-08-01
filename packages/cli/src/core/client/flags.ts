// Global client-behavior flags (T-211 step 3b): `--retries` (the typed HTTP client's
// backoff-retry budget) and `--idempotency-key` (an override for the auto-generated
// key). Like the T-208 context flags they register globally in build-cli.ts and are
// stripped from a command's own `.strict()` input; their VALUES are re-read HERE from
// raw argv with the SAME `parseFlagTokens` the rest of the shell uses (never yargs'
// coerced object — the json-shadowing regression, build-cli.test:1-8).
//
// Validation (A6) mints NO new error code: a malformed value is T-207's `usage_error`
// (exit 2) via `ConfigError`. `--retries` must be a bounded non-negative integer
// (0–10; 0 disables); `--idempotency-key` must be a non-empty string, length-capped 256.
import { parseFlagTokens } from "../../commands/vocab";
import { ConfigError } from "../config";

/** The validated client-behavior flags for one invocation. */
export interface ClientFlags {
  readonly retries?: number;
  readonly idempotencyKey?: string;
  /** `--paginate` (T-211 step 4): auto-drain every page of a paginated list command. */
  readonly paginate?: boolean;
  /** `--yes` (T-212): skip the plain y/N confirm for an M-class mutation. NEVER satisfies a
   *  D/PR typed confirm. Its TARGET (a mutating command) is validated at dispatch. */
  readonly yes?: true;
  /** `--plan-only` (T-212): create the plan, emit it as data, then stop (exit 0) — do not apply. */
  readonly planOnly?: true;
}

/** Upper bound on `--retries` (a runaway budget is a footgun, not a feature). */
export const MAX_RETRIES = 10;
/** Upper bound on a user-supplied `--idempotency-key` (the server accepts any non-empty string). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Parse + validate the two global client flags from raw argv. Throws `ConfigError`
 * (usage_error, exit 2) on any malformed value; returns only the flags actually present.
 */
export function parseClientFlags(rawArgv: readonly string[]): ClientFlags {
  const flags = parseFlagTokens([...rawArgv]);
  const out: { retries?: number; idempotencyKey?: string; paginate?: boolean; yes?: true; planOnly?: true } = {};

  // `--paginate` is a BARE boolean flag (T-211 step 4): parseFlagTokens yields `true` for a
  // bare `--paginate` and a STRING for a `--paginate=<value>` form. Per the A6 pattern a
  // non-boolean value is a `usage_error` (never silently coerced) — the flag takes no value.
  //
  // ISS-226 RECONCILED THIS WITH THE POSITIONAL GUARD. There used to be two independent
  // notions of "boolean" in the package: this trio of value-rejecting checks, and
  // `cli/positional.ts`'s hand-listed `BOOLEAN_SWALLOW_FLAGS`. They disagreed (the literal
  // omitted all three flags below), which is why `agkit --paginate apply plan_x` and
  // `agkit --compact apply plan_x` produced two different errors for one mistake. Both now
  // read the SAME `SHELL_FLAG_ARITY` table in `cli/flag-ownership.ts`: these checks inherit
  // it through `parseFlagTokens`, which no longer lets a declared-boolean flag consume the
  // following token at all. The observable consequence is that the SWALLOW form is no longer
  // an error — `agkit --paginate route list` and `agkit apply --yes plan_x` simply run,
  // because nothing was swallowed — while the `=`-form these messages describe still rejects,
  // with the messages below UNCHANGED, word for word.
  if (Object.prototype.hasOwnProperty.call(flags, "paginate")) {
    const raw = flags["paginate"];
    if (raw !== true) {
      throw new ConfigError("--paginate is a boolean flag and takes no value", {
        hint: "use a bare --paginate to fetch all pages",
        extra: { paginate: raw },
      });
    }
    out.paginate = true;
  }

  // `--yes` / `--plan-only` (T-212) are BARE boolean flags — same paginate idiom. A STRING
  // value reaches here only through the `=`-form (`--yes=1`) now that arity is derived
  // (ISS-226): the space form `--yes plan_x` no longer assigns a value, it leaves `plan_x`
  // to the positional walk, so BOTH orders parse and the canonical `agkit apply plan_x --yes`
  // is a convention rather than the only grammar. The TARGET (a mutating command) is validated
  // later, at dispatch (build-cli). F-D2 is UNCHANGED and still load-bearing: the assigned
  // value is NEVER echoed (an `--yes=<pasted secret>` is exactly the mis-paste it guards) —
  // the error carries METADATA ONLY (violation class, type, length).
  if (Object.prototype.hasOwnProperty.call(flags, "yes")) {
    const raw = flags["yes"];
    if (raw !== true) {
      throw new ConfigError("--yes is a boolean flag and takes no value", {
        hint: "put the positional first, e.g. `agkit apply <plan-id> --yes`",
        extra: {
          violation: "boolean_flag_given_value",
          value_type: typeof raw,
          length: typeof raw === "string" ? raw.length : null,
        },
      });
    }
    out.yes = true;
  }
  if (Object.prototype.hasOwnProperty.call(flags, "plan-only")) {
    const raw = flags["plan-only"];
    if (raw !== true) {
      throw new ConfigError("--plan-only is a boolean flag and takes no value", {
        hint: "put the positional first, e.g. `agkit apply <plan-id> --plan-only`",
        extra: {
          violation: "boolean_flag_given_value",
          value_type: typeof raw,
          length: typeof raw === "string" ? raw.length : null,
        },
      });
    }
    out.planOnly = true;
  }

  if (Object.prototype.hasOwnProperty.call(flags, "retries")) {
    const raw = flags["retries"];
    // A value (never a bare boolean), a NON-NEGATIVE INTEGER (rejects "-1", "1.5", "abc").
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      throw new ConfigError(`--retries must be a non-negative integer (0–${MAX_RETRIES})`, {
        hint: "e.g. --retries 3 (0 disables retries)",
        extra: { retries: raw },
      });
    }
    const n = Number(raw);
    if (n > MAX_RETRIES) {
      throw new ConfigError(`--retries must be ≤ ${MAX_RETRIES} (got ${n})`, {
        hint: `use a value between 0 and ${MAX_RETRIES}`,
        extra: { retries: n },
      });
    }
    out.retries = n;
  }

  if (Object.prototype.hasOwnProperty.call(flags, "idempotency-key")) {
    const raw = flags["idempotency-key"];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new ConfigError("--idempotency-key must be a non-empty string", {
        hint: "supply a key, e.g. --idempotency-key <uuid>",
      });
    }
    // Transport-representability (re-review R6 — replaces the printable-ASCII rule, which
    // over-tightened ratified A6: only non-empty + length cap): the key travels verbatim as the
    // `Idempotency-Key` HTTP header, so the real requirement is that `Headers` can carry it
    // UNCHANGED. Round-trip through a scratch Headers: a value it rejects outright (NUL/CR/LF,
    // any char above 0xFF — e.g. an emoji's surrogates) THROWS; a value it would silently
    // normalize (leading/trailing whitespace is trimmed) round-trips MISMATCHED. Both → reject
    // (§B-9 honor-or-reject: we never send a different token than the user typed). Anything
    // Headers carries verbatim — including interior spaces — is ACCEPTED. The raw key is NEVER
    // echoed into the error (it may be secret-adjacent); report only the violation class + length.
    let roundTrips = false;
    try {
      const h = new Headers();
      h.set("Idempotency-Key", raw);
      roundTrips = h.get("Idempotency-Key") === raw;
    } catch {
      roundTrips = false;
    }
    // A Headers round-trip alone is NOT proof fetch can SEND the value (codex confirmation
    // round): undici's Headers stores C0 controls like \x01/\x0B/\x7F unchanged, but the
    // dispatch-time RFC 9110 field-value grammar rejects them — the request would die as a
    // misleading retryable transport failure instead of this parse-time usage error. Reject
    // the HTTP-forbidden controls explicitly; HTAB (\x09) stays legal field-content.
    if (roundTrips && /[\x00-\x08\x0A-\x1F\x7F]/.test(raw)) {
      roundTrips = false;
    }
    if (!roundTrips) {
      throw new ConfigError(
        "--idempotency-key cannot travel verbatim as an HTTP header value: it contains a forbidden byte (such as CR, LF, or NUL), a non-Latin-1 character, or leading/trailing whitespace that would be silently trimmed",
        {
          hint: "use a URL-safe token, e.g. a UUID",
          extra: { violation: "not_header_representable", length: raw.length },
        },
      );
    }
    if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new ConfigError(`--idempotency-key must be ≤ ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${raw.length})`, {
        hint: "use a shorter key",
        extra: { length: raw.length },
      });
    }
    out.idempotencyKey = raw;
  }

  return out;
}
