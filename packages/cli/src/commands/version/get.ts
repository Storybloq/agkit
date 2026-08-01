// `version get` handler — the end-to-end demonstrator of the registry -> shell
// pipeline, enriched by T-222 (step 5) into an honest diagnostic: local build facts
// (`version` — BYTE-STABLE, the CI cold smoke asserts it — and `node_version` from the
// runtime seam) plus a BOUNDED best-effort server probe. The probe rides the landed
// `probeHandshake` under VERSION_PROBE_BUDGET (S3: 2.5 s watchdog, ZERO retries) so a
// blackholed network can never hang `agkit version`; it swallows every failure to
// `server_reachable:false`. EXIT 0 ALWAYS. `meta` stays `contractFacts()` (D-8 — the
// pinned contract + envelope versions already ride there).
import { z } from "zod";
import type { CommandHandler, RequestSpec } from "../types";
import { VERSION } from "../../version";
import { contractFacts } from "../../contract";
import { probeHandshake } from "../../core/config/status";

/**
 * T-222 S3: the version probe's custody budget — 2.5 s watchdog, zero retries. A
 * diagnostic must answer fast or answer "unreachable"; it never earns the default
 * 30 s × (1+retries) custody.
 */
export const VERSION_PROBE_BUDGET: NonNullable<RequestSpec["budget"]> = { timeoutMs: 2_500, retries: 0 };

/** No input. */
export const versionGetArgs = z.object({}).strict();
export type VersionGetInput = z.infer<typeof versionGetArgs>;

export const versionGet: CommandHandler<VersionGetInput> = async (ctx, _input) => {
  // probeHandshake NEVER throws (unreachable ⇒ {reachable:false, null, null}) — the
  // exit-0-always contract needs no try/catch here. run.ts gives `version` the REPORT
  // fence, so a major-ahead server reads as skew DATA, never a version_skew death.
  const probe = await probeHandshake(ctx.client, { budget: VERSION_PROBE_BUDGET });
  return {
    data: {
      version: VERSION,
      node_version: ctx.runtime?.nodeVersion ?? null,
      server_reachable: probe.reachable,
      server_management_version: probe.managementVersion,
      version_skew: probe.skew,
    },
    meta: contractFacts(),
  };
};
