// `agkit status get` handler (T-208 deliverable 5 + T-211 handshake). The session-start
// aggregate an agent reads to know its situation without guessing. It computes the LOCAL
// snapshot (auth presence + source, effective context + sources, config, API-URL guard,
// update notice) via `assembleStatus`, and — the T-211 addition — runs ONE REPORT-path
// server probe (`probeHandshake`) through `ctx.client` to fill reachability +
// management_version + skew. That probe is exit-0-always: any failure (unreachable, skew,
// a wire problem) is swallowed to `server_reachable:false` DATA (T-208
// FORBIDDEN: status never non-zero for an unauthenticated / unreachable / skewed session).
// T-212 S8 added the AUTHENTICATED plan probe (`probePendingPlans`): gated on a present
// credential + a reachable handshake, refresh-suppressed (A-9), page-bounded, exit-0-always.
// `principal`/`scopes` remain deferred (an authenticated identity probe).
import { z } from "zod";
import { requireRuntime, type CommandHandler } from "../types";
import { assembleStatus, probeHandshake, probePendingPlans } from "../../core/config";
import { VERSION } from "../../version";
import { contractFacts } from "../../contract";

export const statusGetArgs = z.object({}).strict();
export type StatusGetInput = z.infer<typeof statusGetArgs>;

/** Server-dependent fields still deferred (need an AUTHENTICATED identity probe — whoami.get).
 * Surfaced in `meta.deferred` so a consumer knows WHICH fields are not-yet-known.
 * server_reachable / management_version / version_skew left with the T-211 handshake;
 * pending_plans left with the T-212 S8 plan probe. */
const DEFERRED_FIELDS = ["principal", "scopes"] as const;

export const statusGet: CommandHandler<StatusGetInput> = async (ctx, _input) => {
  const rt = requireRuntime(ctx);
  // REPORT-path handshake FIRST (exit-0-always): a public discovery.get through the typed client.
  const handshake = await probeHandshake(ctx.client);
  const { data, updateNotice } = await assembleStatus(
    {
      env: rt.env,
      homeDir: rt.homeDir,
      cwd: rt.cwd,
      keyring: rt.keyring,
      flags: rt.flags,
      version: VERSION,
    },
    handshake,
  );

  // T-212 S8 (design (f)): the pending-plans probe runs ONLY when a credential is present
  // AND the handshake said reachable — an unauthenticated or offline session pays nothing
  // and reads null/null. Every probe failure swallows to null/null (status is exit-0-ALWAYS).
  if (data.authenticated && handshake.reachable) {
    const pending = await probePendingPlans(ctx.client);
    data.pending_plans = pending.pendingPlans;
    data.pending_plans_truncated = pending.truncated;
  }

  // Mirror the update notice to stderr in an interactive terminal (deliverable 5) —
  // stdout still carries exactly one document. `rt.stderr` is the injected sink.
  if (updateNotice && rt.isTTY) rt.stderr(updateNotice);

  return {
    data,
    meta: {
      ...contractFacts(),
      // T-211 landed the handshake (reachability/version/skew); these remaining fields need an
      // AUTHENTICATED identity + plan probe — a later, not-yet-ticketed increment (§B-9: label
      // by reality — naming a shipped ticket here would claim work T-211 does not contain).
      deferred: { ticket: "post-T-211", fields: [...DEFERRED_FIELDS] },
    },
  };
};
