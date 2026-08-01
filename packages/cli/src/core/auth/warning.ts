// The insecure-storage SURFACE helper (T-206, deliverable 4). ONE place produces
// both halves of "you are on the plaintext path":
//   - the `insecure_storage: true` machine field for `--json` (envelope `meta`), and
//   - the persistent stderr WARNING BANNER emitted on every read from that source.
// The shell (build-cli) writes the banner to stderr (diagnostics -> stderr, T-205
// stream discipline) right after resolution; the handler puts the meta field in
// its CommandResult. The banner is prose only — it never contains the token.

/** The persistent stderr banner shown whenever the active source is the 0600 file. */
export const INSECURE_WARNING_BANNER =
  "agkit: WARNING — using PLAINTEXT credential storage (~/.agentkit/credentials.json, mode 0600). " +
  "This is weaker than the OS keychain: any process running as you can read it. " +
  "Prefer AGKIT_TOKEN or a keychain-backed login.\n";

export interface InsecureSurface {
  /** The `--json` machine signal, merged into the envelope `meta`. */
  readonly meta: { readonly insecure_storage: true };
  /** The stderr banner (prose, no secret). */
  readonly banner: string;
}

/** Produce the insecure-storage surface (meta field + stderr banner). */
export function insecureStorageSurface(): InsecureSurface {
  return { meta: { insecure_storage: true }, banner: INSECURE_WARNING_BANNER };
}
