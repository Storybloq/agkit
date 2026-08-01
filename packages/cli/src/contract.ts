// Contract-version facts (T-205, canonical L2-CLI-03, deliverable 2).
//
// The ENVELOPE-schema version is a top-level integer on every wire envelope. It
// is DELIBERATELY independent of the server's `management_version`: it versions
// the SHAPE of the CLI's own `{ version, data | error }` envelope, so a consumer
// can branch on envelope evolution without conflating it with the management API
// contract the CLI happens to speak. Bump this when the envelope shape changes.
export const ENVELOPE_VERSION = 1 as const;

// The management-plane contract version this CLI targets — the BUILD-TIME PIN (T-211,
// deliverable 1). It is the DIRECT import of the frozen bundle's `MANAGEMENT_VERSION`,
// NEVER a hardcoded "1.1.0" literal: a literal would drift silently the day the bundle
// bumps, defeating the version-skew fence + `contract.test.ts`'s pin guard. The import
// is from the BUNDLER-SAFE data module (`management-data`) — the static-JSON self-reference
// half, never the fs-reading api-only `wire-contract/management` (CON-6). The transport
// sends this same value in `X-AgentKit-Management-Version` (via `management-routes-data`'s
// `MANAGEMENT_ROUTES_VERSION`, the sibling pin of the identical frozen tag), and the fence
// (core/client/handshake) compares it against the server's advertised version.
import { MANAGEMENT_VERSION } from "@agentkit-cloud/shared/wire-contract/management-data";

export const MANAGEMENT_CONTRACT_VERSION: string = MANAGEMENT_VERSION;

/**
 * Contract-version facts for the `version` / `status` commands' `meta`. The
 * top-level envelope `version` integer is added by the serializer; these are the
 * richer facts that belong to the payload's metadata.
 */
export function contractFacts(): Record<string, unknown> {
  return {
    envelope_version: ENVELOPE_VERSION,
    management_version: MANAGEMENT_CONTRACT_VERSION,
  };
}
