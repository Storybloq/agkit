// The non-registry SIDE DOORS — `reference` and `completion` (T-279).
//
// WHY THIS MODULE EXISTS. Every other command the shell registers is a registry citizen: it
// carries an `AnyCommandSpec` whose `.strict()` zod `args` is the closed description of what may
// follow it, so the README drift check validates a documented invocation by parsing it against
// that spec. These two have NO spec — they are hand-registered side doors that bypass the
// serializer and write their artifact straight to stdout. A drift check that could only resolve
// command PATHS would therefore wave through `agkit reference --jsno` and `agkit completion
// nonsense`: the path resolves, and there is nothing left to ask. So each door gets a CLOSED
// description here, consumed by BOTH `build-cli` (registration metadata) and the checker (the
// parse) — one description, not two that drift.
//
// SCOPE LIMIT — this does not change what the shipped binary ACCEPTS. `build-cli` uses
// `.strictCommands()` (typo'd command → error) but not `.strict()`, so today `agkit reference
// --jsno` silently prints Markdown instead of the requested JSON. That is filed as **ISS-225**
// (low, open) and fixing it is a deliberate NON-goal of the docs ticket that added this file:
// tightening runtime acceptance is a behavior change, and this ticket is docs. The parser below
// is therefore STRICTER than the shell it describes — deliberately, because a README is authored
// text and a typo in it must fail loudly even where a human's typed argv currently does not.
//
// `help` IS DELIBERATELY ABSENT. It appears in `NON_REGISTRY_TOP_LEVEL_COMMANDS` alongside these
// two, but it is not a third door: it is yargs' BUILTIN (registered by `.help()`), listed there
// only as a collision RESERVATION so a registry noun/alias can never shadow it
// (`RESERVED_TOP_LEVEL_TOKENS`). Describing it here — a name, a summary, an accepted-token set —
// would invent a shipped meta-command surface we do not own and did not write (§B-9: label by the
// bytes). `NON_REGISTRY_TOP_LEVEL_COMMANDS` stays `["reference", "help", "completion"]`; the two
// tables answer different questions and are not meant to be equal.
import { COMPLETION_SHELLS } from "../commands/generators/completion";
import { displaySafe } from "../core/output/display";
import { isShellOwnedFlag } from "./flag-ownership";

/** The exactly-two side-door names. `help` is excluded on purpose — see the header. */
export const SIDE_DOOR_NAMES = ["reference", "completion"] as const;
export type SideDoorName = (typeof SIDE_DOOR_NAMES)[number];

/** A side door's REQUIRED positional over a closed value set (only `completion <shell>` today). */
export interface SideDoorPositional {
  /** The yargs positional key — also its `<angle-bracket>` name in the usage line. */
  readonly key: string;
  /** `--help` text for the positional. Derived from `choices`, never a second copy of the list. */
  readonly describe: string;
  /** The closed set of accepted values. Honor-or-reject: anything else is a usage error. */
  readonly choices: readonly string[];
}

/** The closed description of one side door: how it registers, and what may follow it. */
export interface SideDoorDescriptor {
  readonly name: SideDoorName;
  /** The one-line summary yargs prints. `build-cli` registers with THIS string. */
  readonly summary: string;
  /**
   * Flags the door owns as real yargs options. Empty for both doors today — kept as an explicit
   * field so "accepts nothing of its own" is a machine-checkable FACT rather than an absence a
   * reader has to infer, and so a future door with its own option is describable without a
   * schema change.
   */
  readonly ownedFlags: readonly string[];
  /**
   * Flag keys the door reads back off RAW argv instead of owning as an option. Meaningful tokens
   * for the door, but registered (if at all) by someone else — so a documented invocation may
   * carry them even though the door declares no options.
   */
  readonly rawArgvFlags: readonly string[];
  readonly positional?: SideDoorPositional;
}

/** A side door whose grammar REQUIRES its positional — the type `build-cli` registers against. */
export interface PositionalSideDoorDescriptor extends SideDoorDescriptor {
  readonly positional: SideDoorPositional;
}

/**
 * `reference` — the generators' self-reflection surface (T-204/T-209).
 *
 * It owns NO options, and `--json` is not the exception it looks like: the GLOBAL `--json` is
 * registered as a STRING (it doubles as `--json a,b` field selection), so a local boolean here
 * would be shadowed by the global and a bare `--json` coerced to `""` — falsy, silently reverting
 * to Markdown. The handler therefore reads its JSON intent from RAW argv, immune to that
 * coercion, which is exactly why the only meaningful token on this door is a flag it does not own.
 */
export const REFERENCE_SIDE_DOOR: SideDoorDescriptor = {
  name: "reference",
  summary: "Print the full command catalog (Markdown; --json for the machine registry).",
  ownedFlags: [],
  rawArgvFlags: ["json"],
};

/**
 * `completion <shell>` — the registry-derived completion script (T-222 step 9).
 *
 * One REQUIRED positional over `COMPLETION_SHELLS`, imported rather than restated: the generator
 * owns that list, and a fourth shell must reach this door (and the docs check) by adding itself
 * there, never by a second edit here that someone forgets. `describe` and `summary` interpolate
 * the same import for the same reason.
 */
export const COMPLETION_SIDE_DOOR: PositionalSideDoorDescriptor = {
  name: "completion",
  summary: `Print a shell-completion script (${COMPLETION_SHELLS.join(" | ")}).`,
  ownedFlags: [],
  rawArgvFlags: [],
  positional: {
    key: "shell",
    describe: COMPLETION_SHELLS.join(" | "),
    choices: COMPLETION_SHELLS,
  },
};

/** The frozen side-door table — EXACTLY two rows, keyed by the name the shell dispatches on. */
export const SIDE_DOORS: Readonly<Record<SideDoorName, SideDoorDescriptor>> = Object.freeze({
  reference: REFERENCE_SIDE_DOOR,
  completion: COMPLETION_SIDE_DOOR,
});

/** True when a top-level token is one of the two side doors (never `help`). */
export function isSideDoor(name: string): name is SideDoorName {
  return Object.prototype.hasOwnProperty.call(SIDE_DOORS, name);
}

/** The yargs command string for a door: `reference`, `completion <shell>`. Derived from the
 *  positional so the usage line and the parse can never disagree about arity. */
export function sideDoorUsage(door: SideDoorDescriptor): string {
  return door.positional ? `${door.name} <${door.positional.key}>` : door.name;
}

/** Why a side-door invocation was rejected. Closed set — a caller switches exhaustively. */
export type SideDoorRejection =
  | "unknown_side_door"
  | "unknown_flag"
  | "missing_positional"
  | "unknown_positional_value"
  | "unexpected_positional";

/** The verdict for one side-door invocation. `ok` is the accept/reject; `detail` is teachable
 *  text for the caller's own error (this module constructs no errors — see `ceremony-flags`). */
export type SideDoorVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SideDoorRejection; readonly detail: string };

const ACCEPTED: SideDoorVerdict = { ok: true };

/**
 * Would this side-door invocation be a legal one to DOCUMENT? Pure — takes the tokenized flags
 * and the positional tokens, so a checker can ask without building a yargs instance or a spec.
 *
 * Shell-owned flags (`--json`, `--profile`, `--verbose`, `--retries`, …) are accepted on any door
 * because the shell registers them `global: true` — they are inert here, but they are not a lie,
 * and accepting them makes this parser IDEMPOTENT with respect to the caller's normalization: it
 * returns the same verdict whether or not `stripGlobalFlagInput` already ran over the input. Any
 * OTHER flag the door does not declare is a rejection, which is the whole point — `--jsno` is a
 * typo, not a field selector.
 */
export function sideDoorVerdict(
  name: string,
  flags: Readonly<Record<string, unknown>>,
  positionals: readonly string[],
): SideDoorVerdict {
  if (!isSideDoor(name)) {
    return {
      ok: false,
      reason: "unknown_side_door",
      detail: `'${displaySafe(name)}' is not a side door — the doors are ${SIDE_DOOR_NAMES.join(", ")}`,
    };
  }
  const door = SIDE_DOORS[name];
  const declared = new Set<string>([...door.ownedFlags, ...door.rawArgvFlags]);
  for (const key of Object.keys(flags)) {
    if (declared.has(key) || isShellOwnedFlag(key)) continue;
    return {
      ok: false,
      reason: "unknown_flag",
      detail: `\`agkit ${door.name}\` does not accept --${displaySafe(key)}`,
    };
  }

  const positional = door.positional;
  if (!positional) {
    if (positionals.length > 0) {
      return {
        ok: false,
        reason: "unexpected_positional",
        detail: `\`agkit ${door.name}\` takes no positional argument (got '${displaySafe(positionals[0] ?? "")}')`,
      };
    }
    return ACCEPTED;
  }
  const choices = positional.choices.join(", ");
  if (positionals.length === 0) {
    return {
      ok: false,
      reason: "missing_positional",
      detail: `\`agkit ${door.name}\` requires <${positional.key}> — one of: ${choices}`,
    };
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      reason: "unexpected_positional",
      detail: `\`agkit ${door.name}\` takes exactly one <${positional.key}> (got ${positionals.length})`,
    };
  }
  const value = positionals[0] ?? "";
  if (!positional.choices.includes(value)) {
    return {
      ok: false,
      reason: "unknown_positional_value",
      detail: `unknown ${positional.key} '${displaySafe(value)}' — supported: ${choices}`,
    };
  }
  return ACCEPTED;
}
