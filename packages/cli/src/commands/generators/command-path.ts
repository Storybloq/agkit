// The ONE effective-command-path decision (T-214 C-6 / codex #4). A noun whose ONLY visible
// command is a canonical read (`get`/`list`) surfaces BARE — `agkit <noun>`, exactly like
// version / whoami / status — because the yargs shell registers it as a bare command
// (build-cli). Before T-214 the reference/help generators always rendered `agkit <noun>
// <verb>`, so they published (e.g.) `agkit audit list`, which `.strictCommands()` REJECTS.
//
// This module is the single source both the shell (build-cli) and the reference generator
// consume, so the shipped CLI surface and its documented command path can NEVER drift: a
// change to the bare-command rule updates both at once.
import type { AnyCommandSpec } from "../types";
import { isReadVerb } from "../vocab";

/**
 * Is this noun-group a singleton that surfaces BARE (`agkit <noun>`)? True when the noun's
 * one visible command is a canonical read (`get`/`list`) OR opts in via `bare: true`
 * (T-213 decision (k): login/logout surface bare even though `create`/`clear` are not read
 * verbs — the registry load-check already guarantees a `bare` spec is the sole command for
 * its noun). This is the SINGLE decision both the shell (build-cli) and the reference/help
 * generators consume, so the surface and its docs can never drift.
 */
export function isSingletonReadGroup(group: readonly AnyCommandSpec[]): boolean {
  const only = group.length === 1 ? group[0] : undefined;
  return only !== undefined && (isReadVerb(only.verb) || only.bare === true);
}

/**
 * The effective CLI command PATH for a spec, given whether its noun-group is a singleton read:
 * `agkit <noun>` (bare) for a singleton read, `agkit <noun> <verb>` otherwise.
 */
export function effectiveCommandPath(spec: AnyCommandSpec, singletonRead: boolean): string {
  return singletonRead ? `agkit ${spec.noun}` : `agkit ${spec.noun} ${spec.verb}`;
}
