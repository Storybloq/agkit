// The CLOSED CLI capability vocabulary (T-210 §D). These are CLI-INTERNAL
// placeholders / the injected T-211 seam — NOT v1.1.0 wire strings. The management
// contract has NO capability field; T-211 ratifies the wire mapping. They are the
// axis the `version_skew` capability gate (core/capability/gate) checks a reserved
// command against, and the registry load-check requires every reserved command's
// `requiredCapabilities` to be a NON-EMPTY subset of THIS set.
//
// This module is deliberately tiny + side-effect-free (four generic strings, no
// reserved command identifiers) so registry.ts can import it on the LIVE graph
// without leaking any reserved-tree bytes into the default build.

export const RESERVED_CAPABILITIES = ["knowledge", "teams", "admin", "media-job-cancel"] as const;

export type ReservedCapability = (typeof RESERVED_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(RESERVED_CAPABILITIES);

/** Is every element of `caps` a member of the closed capability vocab? */
export function areKnownCapabilities(caps: readonly string[]): boolean {
  return caps.every((c) => CAPABILITY_SET.has(c));
}
