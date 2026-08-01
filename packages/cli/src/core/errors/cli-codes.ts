// The CLOSED registry of CLI-local error codes (T-207, canonical L2-CLI-04,
// deliverable 3). This is the SINGLE source of truth (P2 chokepoint) for every
// code the CLI itself mints — as opposed to a WIRE code the server sends (those
// live, byte-pinned, in wire-table.ts). The whole point is the closure: a sibling
// ticket that needs a new CLI-local code MUST add it to `CLI_LOCAL_CODES` HERE
// (FORBIDDEN: minting a CLI-local code anywhere else). The closed set is exposed
// three ways so nothing can slip past — a `const` array, a derived `type`, and a
// runtime `guard`.
//
// Provenance of each code:
//   confirmation_required     — CLIENT-side typed-confirm gate, BEFORE we send a
//                               D/PR op (distinct from the wire's `confirm_required`,
//                               which is the SERVER rejecting a missing confirm field).
//   keychain_unavailable      — T-206 (L2-CLI-05): no secret-service backend + no fallback.
//   not_logged_in             — no resolvable credential for an authenticated op (T-211).
//   version_skew              — CLI management-major < server (T-211 handshake).
//   usage_error               — arg-parse / malformed-flag / unknown-command / local
//                               validation. Replaces T-205's provisional `usage`.
//   ambiguous_prefix          — an id-prefix that matches >1 resource (deliverable 7).
//   unknown_field             — T-205: `--json a,b` names a field absent from `data`.
//   insecure_storage_refused  — T-206: CI double-opt-in for insecure storage not satisfied.
//   insecure_file_permissions — T-206: the 0600 credentials file widened / not regular.
//   binary_unresolved         — T-228: no ABSOLUTE `agkit` launcher could be resolved from
//                               argv[1] or PATH, so a command whose whole payload is a
//                               registration snippet naming that launcher has nothing honest to
//                               emit (`agkit mcp print-config`). Refusal, never a bare name and
//                               never the `/absolute/path/to/agkit` placeholder — our own
//                               `isAgkitShimPath` would certify that placeholder as registered.
//
// EVERY CLI-local code is TERMINAL → exit 2 (deliverable 3): a CLI-local failure is
// a determinate user/environment fault, never something a script should auto-retry.
import { EXIT, type ExitCode } from "./exit-codes";

/**
 * The closed set. Order is documentary only; membership is what matters. A code
 * that is not in this array is not a CLI-local code — full stop.
 */
export const CLI_LOCAL_CODES = [
  "confirmation_required",
  "keychain_unavailable",
  "not_logged_in",
  "version_skew",
  "usage_error",
  "ambiguous_prefix",
  "unknown_field",
  "insecure_storage_refused",
  "insecure_file_permissions",
  "binary_unresolved",
] as const;

/** The CLI-local code union, derived from the closed array (no second list to drift). */
export type CliLocalCode = (typeof CLI_LOCAL_CODES)[number];

const CLI_LOCAL_CODE_SET: ReadonlySet<string> = new Set(CLI_LOCAL_CODES);

/** Runtime guard: is `code` a member of the closed CLI-local set? */
export function isCliLocalCode(code: string): code is CliLocalCode {
  return CLI_LOCAL_CODE_SET.has(code);
}

/** The teachable facts each CLI-local code maps to (deliverable 3). */
export interface CliCodeSpec {
  /** Human title — line 1 of the two-line human render (`error <code>: <title>`). */
  readonly title: string;
  /**
   * The DEFAULT copy-pasteable recovery command (deliverable 3 + FORBIDDEN: a hint
   * that is not a runnable command). Where the exact command depends on runtime
   * context (which command, which id, which field), this is the runnable shape and
   * the throw-site concretizes it (classify.ts fills in the real path/id/field).
   */
  readonly hint: string;
  /** Exit class — TERMINAL (2) for EVERY CLI-local code, by taxonomy. */
  readonly exitCode: ExitCode;
}

/**
 * Code → { title, default hint, exit-class }. The single registry the teachable
 * renderer (problem.ts) reads. Every entry's `exitCode` is `EXIT.TERMINAL`.
 */
export const CLI_LOCAL_REGISTRY: Record<CliLocalCode, CliCodeSpec> = {
  confirmation_required: {
    title: "confirmation required",
    // filled at the throw site with the real command + the resource's own name.
    hint: "agkit <command> --confirm <resource-name>",
    exitCode: EXIT.TERMINAL,
  },
  keychain_unavailable: {
    title: "OS keychain unavailable",
    // T-227 S7 (req 14 tail) — KEYCHAIN-LOCKED-OVER-SSH STEERING. This hint used to read
    // `agkit login --insecure-storage`, which pointed the operator at the WEAKEST remedy first:
    // write the credential to plaintext on disk. The dominant real-world cause of this code is a
    // locked/absent keychain over SSH, whose right answers are (1) `AGKIT_TOKEN` — no keychain is
    // touched at all — and (2) the device flow, which is what `login` itself already recommends in
    // that situation (`core/auth/flow-select.ts` MACOS_SSH_KEYCHAIN_CAVEAT). So the hint names
    // those two. `--insecure-storage` is NOT lost: it stays the second ratified remedy in
    // `KEYCHAIN_UNAVAILABLE_MESSAGE` / `.remedies`, which ride the same envelope's `detail` +
    // `remedies` — demoted from the headline, never removed.
    hint: "AGKIT_TOKEN=<management token> agkit <command>  (over SSH, log in with: agkit login --device)",
    exitCode: EXIT.TERMINAL,
  },
  not_logged_in: {
    title: "not logged in",
    hint: "agkit login",
    exitCode: EXIT.TERMINAL,
  },
  version_skew: {
    title: "CLI out of date",
    hint: "npm install -g @storybloq/agkit@latest",
    exitCode: EXIT.TERMINAL,
  },
  usage_error: {
    title: "usage error",
    hint: "agkit --help",
    exitCode: EXIT.TERMINAL,
  },
  ambiguous_prefix: {
    title: "ambiguous id prefix",
    // filled at the throw site with the real command + a fuller id from the list.
    hint: "agkit <command> <full-id>",
    exitCode: EXIT.TERMINAL,
  },
  unknown_field: {
    title: "unknown field",
    // filled at the throw site with the real command + an actually-available field.
    hint: "agkit <command> --json <field>",
    exitCode: EXIT.TERMINAL,
  },
  insecure_storage_refused: {
    title: "insecure storage refused",
    hint: "AGKIT_ALLOW_INSECURE_STORAGE=1 agkit login --insecure-storage",
    exitCode: EXIT.TERMINAL,
  },
  insecure_file_permissions: {
    title: "insecure credentials file",
    hint: "chmod 600 ~/.agentkit/credentials.json",
    exitCode: EXIT.TERMINAL,
  },
  binary_unresolved: {
    title: "the `agkit` binary could not be located",
    // The remedy is to INSTALL a launcher there is a path to. This is the whole ladder's premise:
    // a globally-installed CLI is what puts an absolute `agkit` on PATH for `resolveAgkitBin` to
    // find, and it is the same install a registration snippet must name.
    hint: "npm install -g @storybloq/agkit",
    exitCode: EXIT.TERMINAL,
  },
};

// --- throwable CLI-local errors ---------------------------------------------
/**
 * Base class for a thrown CLI-local error. Carries a code from the CLOSED set plus
 * optional teachable extras. The shell's dispatcher (classify.ts) folds ANY
 * `CliLocalError` into the teachable envelope via `CLI_LOCAL_REGISTRY[code]`, so a
 * future ticket (T-211: `not_logged_in`, `version_skew`, `confirmation_required`)
 * can throw `new CliLocalError("not_logged_in", …)` and be rendered with no shell
 * change — the registry entry is all it needs.
 */
export class CliLocalError extends Error {
  override name = "CliLocalError";
  readonly code: CliLocalCode;
  /** The specific `(detail)` shown in parens on line 1. */
  readonly detail?: string;
  /** A concrete hint overriding the registry default (still a runnable command). */
  readonly hint?: string;
  /** RFC-9457-style teachable passthrough members (e.g. remedies, candidates). */
  readonly extra?: Record<string, unknown>;

  constructor(
    code: CliLocalCode,
    opts: { detail?: string; hint?: string; extra?: Record<string, unknown>; message?: string } = {},
  ) {
    super(opts.message ?? opts.detail ?? CLI_LOCAL_REGISTRY[code].title);
    this.code = code;
    this.detail = opts.detail;
    this.hint = opts.hint;
    this.extra = opts.extra;
  }
}

/**
 * An id-prefix matched more than one resource. Deliberately loud (deliverable 7):
 * we NEVER silently pick — the FULL candidate list rides along in `detail` and in
 * the `candidates` extra so the operator can disambiguate. Exit 2.
 */
export class AmbiguousPrefixError extends CliLocalError {
  override name = "AmbiguousPrefixError";
  readonly prefix: string;
  readonly candidates: readonly string[];

  constructor(prefix: string, candidates: readonly string[]) {
    const list = candidates.join(", ");
    const detail = `'${prefix}' matches ${candidates.length} ids: ${list}`;
    super("ambiguous_prefix", {
      detail,
      message: detail,
      extra: { prefix, candidates: [...candidates] },
    });
    this.prefix = prefix;
    this.candidates = [...candidates];
  }
}
