// `--expires-in <dur>` grammar + policy bound (T-213 S11, decision (i) + B-16). A closed,
// unambiguous duration grammar — a positive integer followed by exactly one of m/h/d — parsed to
// milliseconds, then bound-checked against the server's token ttl_max (366 days) BEFORE any mint
// request is built. Both failures are teachable local `usage_error`s (exit 2): a grammar miss
// names the grammar; an over-bound value names the 366d ceiling. No new error code is minted.
import { CliLocalError } from "../../core/errors";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The unit → milliseconds table for the closed m/h/d grammar. */
const UNIT_MS: Readonly<Record<"m" | "h" | "d", number>> = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS };

/**
 * The maximum token lifetime the CLI accepts, in ms — the server's ttl_max of 366 days. The bound
 * is INCLUSIVE (`<= 366d` allowed; `> 366d` rejected, per decision (i)). Note 8784h and 527040m
 * each normalize to EXACTLY this value (they equal 366d) and so are allowed; 527041m is 366d + 1
 * minute and is rejected — the normalize-to-ms-then-compare discipline B-16 requires.
 */
export const MAX_EXPIRES_MS = 366 * DAY_MS;

/** The TTY-mode default lifetime applied when `--expires-in` is omitted interactively (decision (i)). */
export const DEFAULT_EXPIRES_IN = "30d";

// A positive integer (no leading zero) + a single unit. Rejects bare integers, compound units
// (`1d2h`), decimals, negatives, zero, whitespace, and an uppercase unit — every ambiguous form.
const GRAMMAR = /^([1-9][0-9]*)(m|h|d)$/;

/**
 * Parse `raw` (e.g. `45m`, `12h`, `30d`) to milliseconds, or throw a teachable `usage_error`. A
 * grammar miss and an over-bound value are distinct, self-describing refusals. `raw` is a
 * user-supplied duration token (never a secret), so echoing it in the message is safe + helpful.
 */
export function parseExpiresInMs(raw: string): number {
  const match = GRAMMAR.exec(raw);
  if (!match) {
    throw new CliLocalError("usage_error", {
      detail:
        `invalid --expires-in '${raw}' — use a positive integer followed by m (minutes), h (hours), ` +
        `or d (days), e.g. 45m, 12h, 30d (no compound units, no bare integers)`,
      hint: "agkit token create --name <n> --scope <s> --expires-in 30d",
    });
  }
  const unit = match[2] as "m" | "h" | "d";
  const ms = Number(match[1]) * UNIT_MS[unit];
  if (ms > MAX_EXPIRES_MS) {
    throw new CliLocalError("usage_error", {
      detail: `--expires-in ${raw} exceeds the maximum token lifetime of 366d`,
      hint: "use --expires-in 366d or less",
    });
  }
  return ms;
}
