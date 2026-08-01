// PUBLIC-MIRROR STUB (T-228). The reserved command trees are not part of the public
// source mirror. This module satisfies registry.ts's import graph only; the default
// build dead-code-eliminates it (the buildReservedSpecs() call sits in the dead
// branch of the __AGKIT_SHIP_RESERVED__ ternary, and AGKIT_SHIP_RESERVED is never
// set in the mirror). If a mirror build is ever forced with AGKIT_SHIP_RESERVED=1,
// this throws at registry assembly — fail loud, never a silent partial surface.
//
// The RESERVED_CAPABILITIES import mirrors the real tree's import of the live
// capability vocab (reserved/build.ts), keeping esbuild's module-discovery order —
// and therefore the emitted chunk bytes — identical to a private-tree build.
import type { AnyCommandSpec } from "../types";
import { RESERVED_CAPABILITIES } from "../reserved-capabilities";

/** Stub: the reserved specs are not present in the public mirror. */
export function buildReservedSpecs(): AnyCommandSpec[] {
  throw new Error(
    `reserved command trees are not present in the public source mirror ` +
      `(capability vocab retains ${RESERVED_CAPABILITIES.length} entries)`,
  );
}
