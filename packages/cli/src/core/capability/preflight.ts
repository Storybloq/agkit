// Capability-gate PRE-FLIGHT + enforcement (T-211 step 5 — A25 / A33). The wire half of the
// version_skew capability gate D4 assigned to T-211: it decides, BEFORE dispatching a reserved
// capability-gated command, whether the server advertises the capability its tree needs, and
// throws the teachable `version_skew` (exit 2) when it does not. ORDINARY commands (remote with
// no required capabilities, or local) never pre-flight — `enforceCapabilityGate` returns
// immediately for them (`isCapabilityGated` is false), so the shipped surface pays no cost.
//
// Advertisement source (A25): the state-dir cache (cache.ts) if fresh, else ONE pre-flight
// `discovery.get`. Discovery BOOTSTRAP semantics (A33): `discovery.get` is exempt ONLY from
// capability gating (it is never itself capability-gated → no recursion) — it is a plain typed
// client call that OBEYS the version fence, auth, and retry rules and shares the invocation's
// single logical-refresh cap. Its failure PROPAGATES: a skew throws `version_skew` (exit 2) and a
// transient-exhaustion throws a retryable error (exit 1) — either way the gated operation is NEVER
// sent (it is dispatched only AFTER discovery succeeds AND the gate passes). The fail-closed gate
// (checkCapabilityGate on a null/absent advertisement) means a failed pre-flight still refuses.
import type { CommandSpec, ManagementClient } from "../../commands/types";
import { RESERVED_CAPABILITIES } from "../../commands/reserved-capabilities";
import { CliLocalError } from "../errors";
import { checkCapabilityGate, type AdvertisedCapabilities, type CapabilityGated } from "./gate";

/** Does this command need a capability gate check (a reserved, capability-declaring remote op)? */
export function isCapabilityGated(spec: Pick<CommandSpec, "execution" | "requiredCapabilities">): boolean {
  return spec.execution === "remote" && (spec.requiredCapabilities?.length ?? 0) > 0;
}

/**
 * Derive the advertised capability set from a `discovery.get` response (the T-211 wire mapping
 * D4/Q5 assigned to this ticket): discovery MAY advertise a `capabilities` string array. The
 * frozen v1.1.0 discovery body carries NONE (the reserved trees are not live), so this returns
 * `[]` today — keeping every reserved command fail-closed until its capability is advertised —
 * and is forward-compatible: the day the server adds `capabilities`, a reserved tree lights up
 * with no CLI change. Filtered to the CLOSED reserved vocab so an unknown/oversized server value
 * cannot inject a capability the CLI never modelled (untrusted-boundary validation, D4).
 */
export function deriveAdvertisedCapabilities(discovery: unknown): string[] {
  if (discovery === null || typeof discovery !== "object") return [];
  const raw = (discovery as Record<string, unknown>)["capabilities"];
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(RESERVED_CAPABILITIES);
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c === "string" && known.has(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Injected seams for a capability resolution: the typed client + the cache read/write. */
export interface CapabilityGateDeps {
  readonly client: ManagementClient;
  /** Read the fresh cached advertisement, or null on a miss. */
  readonly readCache: () => readonly string[] | null;
  /** Persist a freshly-fetched advertisement (best-effort). */
  readonly writeCache: (caps: readonly string[]) => void;
}

/**
 * Resolve the server's advertised capabilities for a gated command: the fresh cache if present,
 * else ONE pre-flight `discovery.get` (whose result is cached). A discovery FAILURE PROPAGATES
 * (A33) — the caller never reaches the gate op. Returns the advertised set (possibly empty).
 */
export async function resolveAdvertisedCapabilities(deps: CapabilityGateDeps): Promise<AdvertisedCapabilities> {
  const cached = deps.readCache();
  if (cached !== null) return cached;
  // Cold cache → exactly ONE pre-flight discovery.get (bootstrap: exempt from gating, obeys the
  // fence/auth/retry). A throw here (skew / transient exhaustion / terminal) propagates unhandled.
  const discovery = await deps.client.request({ operationId: "discovery.get", params: {} });
  const capabilities = deriveAdvertisedCapabilities(discovery);
  deps.writeCache(capabilities);
  return capabilities;
}

/**
 * Enforce the capability gate BEFORE dispatch. A no-op for a non-gated command. For a gated one:
 * resolve the advertisement (cache/pre-flight — a discovery failure propagates), then run the
 * pure `checkCapabilityGate`; a failure throws the teachable `version_skew` (exit 2) naming the
 * missing capability — no new code minted. The gated operation is sent ONLY if this RESOLVES.
 */
export async function enforceCapabilityGate(spec: CapabilityGated, deps: CapabilityGateDeps): Promise<void> {
  if (!isCapabilityGated(spec)) return;
  const advertised = await resolveAdvertisedCapabilities(deps);
  const gate = checkCapabilityGate(spec, advertised);
  if (gate.ok) return;
  throw new CliLocalError("version_skew", {
    detail: `the ${gate.missing} capability is not available on this server`,
    extra: {
      capability: gate.missing,
      capabilities: spec.requiredCapabilities ? [...spec.requiredCapabilities] : [],
    },
  });
}
