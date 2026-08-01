// version_skew capability-gate CONSUMER (T-210 §F / L2-CLI-21 D4). PURE, no live
// wiring, no bounds-validation.
//
// D4 splits three ways across three tickets — this ticket ships ONLY the middle one:
//   • L2-CLI-04 (T-207) MINTED the `version_skew` CLI-local code — we reuse it, mint
//     nothing new here.
//   • THIS ticket adds the capability-gate CONSUMER: a pure function that decides,
//     from ALREADY-NORMALIZED advertised capabilities, whether a command's tree is
//     available — naming the missing capability so the error is teachable.
//   • L2-CLI-07 / T-211 own the WIRE: reading the `management_version` header, parsing
//     the UNTRUSTED advertised-capability field (bounds/shape/oversize validation),
//     the major-version fail-closed fence, and WIRING this gate into dispatch.
//
// SEAM (do NOT cross it here): the input is `readonly string[] | null`, NOT `unknown`.
// Accepting `unknown` would pull handshake parsing / untrusted-boundary validation
// into T-210, violating D4/Q5. `null` = the handshake has not been performed / the
// server's capabilities are unknown yet. Malformed / oversized-input tests belong to
// T-211. There is deliberately NO semver / no header logic in this module.
import type { CommandSpec } from "../../commands/types";

/**
 * The server's advertised capabilities, ALREADY normalized by the T-211 handshake
 * layer. `null` means "not yet known" (handshake not performed) — the gate then
 * FAILS CLOSED for remote commands.
 */
export type AdvertisedCapabilities = readonly string[] | null;

/** The gate reads only the two capability-relevant fields of a command spec. */
export type CapabilityGated = Pick<CommandSpec, "execution" | "requiredCapabilities">;

export type CapabilityGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "version_skew"; readonly missing: string };

/**
 * Decide whether `spec`'s tree is available given the server's `advertised`
 * capabilities. Pure — inject `advertised` from the (future) handshake.
 *
 *  (a) a LOCAL command, or one with no required capabilities, is ALWAYS ok;
 *  (b) `advertised === null` (unknown) FAILS CLOSED for a remote-gated command —
 *      capability unknown ⇒ refuse, naming the first required capability;
 *  (c) the FIRST required capability absent from `advertised` ⇒ `version_skew{missing}`;
 *  (d) all present ⇒ ok.
 */
export function checkCapabilityGate(
  spec: CapabilityGated,
  advertised: AdvertisedCapabilities,
): CapabilityGateResult {
  const required = spec.requiredCapabilities;
  // (a) local / un-gated commands are always available (baseline v1.1.0 surface).
  if (spec.execution !== "remote" || !required || required.length === 0) {
    return { ok: true };
  }
  // (b) unknown capabilities ⇒ fail closed (never assume a reserved tree is live).
  if (advertised === null) {
    return { ok: false, code: "version_skew", missing: required[0] as string };
  }
  const advertisedSet = new Set(advertised);
  // (c) name the first capability the server does not advertise.
  for (const cap of required) {
    if (!advertisedSet.has(cap)) {
      return { ok: false, code: "version_skew", missing: cap };
    }
  }
  // (d) every required capability is present.
  return { ok: true };
}
