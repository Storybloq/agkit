// The ceremony-flag TARGET decision (T-212/T-221), extracted from build-cli (T-279).
//
// `--yes` / `--plan-only` apply ONLY to a mutating command that actually runs the plan/apply
// ceremony. On a read, a local command, or a ceremony-exempt key they would be silent theater,
// so they are a usage_error; and together they are contradictory. That rule used to live inside
// `ceremonyFlagUsageError`, which is module-private to build-cli, so nothing else could ask
// "would the shell accept this invocation?".
//
// The T-279 README drift check has to answer exactly that question about every documented
// command. Restating the rule there would have been a second implementation of a four-branch
// policy that already consults two allowlists — precisely the drift the drift-check exists to
// catch. So the DECISION lives here (pure, no error construction) and `build-cli` maps the
// verdict onto the CliLocalError it has always thrown; the message bytes are unchanged.
//
// This is the same extraction already applied to `cli/command-gates.ts` and `cli/positional.ts`,
// and it widens no published surface: `package.json` exports only the built entry points.
import { CEREMONY_EXEMPT } from "../commands/registry";

/**
 * T-221: the NAMED `--yes` carve-out. `init run` carries NO `mutation` binding (it is a
 * MULTI-plan orchestrator — one command drives an account-plane plan, a direct mint, and a
 * project-plane plan, which the single-binding dispatch hook cannot express), so it runs its plan
 * ceremonies INSIDE the handler over the same `core/plan` spine. `--yes` is therefore NOT theater
 * for it — the handler reads `ctx.clientFlags.yes` as its non-interactive consent — so the
 * theater rule below must not reject it. An ALLOWLIST, never a predicate: membership is a
 * reviewed, enumerable decision, exactly like NON_CEREMONY_REMOTE_MUTATIONS.
 *
 * `--plan-only` is DELIBERATELY not carved out: it means "emit THE plan and stop", and an
 * orchestrator has no single plan to emit — so it stays the usage_error it already is.
 */
export const YES_CAPABLE_ORCHESTRATORS: ReadonlySet<string> = new Set(["init run"]);

/** The ceremony-flag verdict for one invocation. `ok` is the shell's accept/reject. */
export type CeremonyFlagVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_ceremony_target"; readonly flag: "--yes" | "--plan-only" }
  | { readonly ok: false; readonly reason: "contradictory" };

const ACCEPTED: CeremonyFlagVerdict = { ok: true };

/**
 * Would the shell accept `--yes` / `--plan-only` on this command? Pure — takes the REGISTRY
 * facts (the command key and whether the spec carries a `mutation` binding) rather than the spec,
 * so a docs checker can ask without constructing one.
 *
 * Branch order is load-bearing and matches the shipped shell exactly: the named orchestrator
 * carve-out is tested BEFORE the theater rule (an orchestrator has no `mutation` binding, so the
 * theater rule would otherwise reject its legitimate `--yes`), and the contradiction check runs
 * LAST so `--yes --plan-only` on a non-ceremony command reports the theater error, not the
 * contradiction — the behavior build-cli has always had.
 */
export function ceremonyFlagVerdict(
  commandKey: string,
  hasMutationBinding: boolean,
  flags: { readonly yes: boolean; readonly planOnly: boolean },
): CeremonyFlagVerdict {
  const { yes, planOnly } = flags;
  // T-221: `--yes` (and only `--yes`) is meaningful on an allowlisted in-handler orchestrator.
  if (yes && !planOnly && YES_CAPABLE_ORCHESTRATORS.has(commandKey)) return ACCEPTED;
  if ((yes || planOnly) && (!hasMutationBinding || CEREMONY_EXEMPT.has(commandKey))) {
    return { ok: false, reason: "not_ceremony_target", flag: yes ? "--yes" : "--plan-only" };
  }
  if (yes && planOnly) return { ok: false, reason: "contradictory" };
  return ACCEPTED;
}
