// T-228 req 3 (MCP-12) — `agkit mcp doctor` core checks. FOUR checks answering ONE question:
// "is the MCP integration wired?" — client registration, the credential this CLI would present,
// server reachability, and management-contract skew. Each check yields a `{name, ok, detail,
// retryable}` row; the aggregate `verdict` maps to the process exit (pass→0, retryable_failures→1,
// terminal_failures→2) at the command layer — the exit-code authority is NOT named here.
//
// WHY THIS IS NOT `agkit selftest` WITH A FILTER (the extraction ruling). The two instruments
// SHARE every data source and share NO verdict:
//   • SHARED — `detectMcpRegistration` (ONE candidate model, ONE A11 semantic gate),
//     `probeHandshake` (ONE handshake reader, ONE normalization of the REPORT-vs-THROW skew),
//     `MANAGEMENT_CONTRACT_VERSION` (never a literal), and `ctx.credential` (the chain result the
//     SHELL produced — this module resolves nothing, see below).
//   • NOT SHARED — the per-check verdict policy and the aggregate fold, ~6 lines each, duplicated
//     DELIBERATELY. Registration-absent is `ok:true` for selftest (informational, "optional — run
//     'agkit setup'") and `ok:false` for doctor (it IS the subject). A shared checker would carry a
//     per-caller policy flag, which is strictly worse than two small functions. And an aggregate
//     fold shared by both diagnostics means one bug makes BOTH instruments lie in the SAME
//     direction, with nothing left in the tree to catch it — differential probing wants two
//     independent folds here. The DETECTION is shared because it READS the subject; the JUDGEMENT
//     is not, because it IS the instrument.
// `core/selftest/**` is therefore not touched by this module, in either direction.
//
// NEVER A PARALLEL CREDENTIAL PATH. The credential arrives as `deps.credential` — the value the
// shell already produced for this dispatch through the L2-CLI-05 chain (APX-E.4). This module
// performs NO credential I/O of any kind, and a source-scan cell in `doctor.test.ts` asserts that
// against these BYTES. A broken keychain backend with no fallback therefore surfaces as the shell's
// loud two-remedy terminal error BEFORE the handler runs — the same behaviour `agkit selftest` has
// today, and the correct one: catching it into a check row would require resolving the credential
// here, i.e. exactly the second chain the requirement forbids.
//
// AND NEVER A SECRET IN THE REPORT. `deps.credential.token` is not referenced anywhere below; the
// rows carry the SOURCE enum and (for the keychain arm) the service NAME, both non-secret. The
// serializer's redaction pass is a backstop, not the mechanism — the mechanism is that the bearer
// never enters `data` in the first place, asserted upstream of the redactor by cell C6.
import type { ManagementClient, RequestSpec } from "../../commands/types";
import { KEYCHAIN_SERVICE, type CredentialSource, type ResolvedCredential } from "../auth";
import type { InstallFs } from "../housekeeping/install";
import {
  MCP_CONFIG_MAX_BYTES,
  detectMcpRegistration,
  mcpConfigCandidates,
  type McpConfigReader,
  type McpDetectDeps,
} from "./registration";
import { probeHandshake, type HandshakeProbe } from "../config/status";
import { MANAGEMENT_CONTRACT_VERSION } from "../../contract";

/** The four check names, in run order — the envelope's `data.checks` names match this exactly. */
export const MCP_DOCTOR_CHECK_NAMES = [
  "registration",
  // Deliberately NOT `credential_chain`: selftest's check of that name is a keychain BACKEND
  // read/write probe against an isolated service. This one reports what the chain RESOLVED.
  "credential",
  "server",
  "contract_version",
] as const;
export type McpDoctorCheckName = (typeof MCP_DOCTOR_CHECK_NAMES)[number];

/** Row shape MIRRORS `SelftestCheck` — one report shape across both diagnostics, no `severity`. */
export interface McpDoctorCheck {
  readonly name: McpDoctorCheckName;
  readonly ok: boolean;
  readonly detail: string;
  readonly retryable: boolean;
}

export type McpDoctorVerdict = "pass" | "retryable_failures" | "terminal_failures";

export interface McpDoctorResult {
  readonly checks: readonly McpDoctorCheck[];
  readonly verdict: McpDoctorVerdict;
}

/**
 * Every management operation this command can send — ONE, unauthenticated. Exported for the same
 * reason `SELFTEST_PROBE_OPS` is: `mcp doctor` is a REPORT-mode skew instrument, so it is exempt
 * from the THROW-fence breadth test, and the version-fence acceptance suite asserts each member
 * here resolves a real management route. That is the exemption's compensating tooth — without it a
 * probe op could dangle onto a route the contract removed and nothing would redden.
 */
export const MCP_DOCTOR_PROBE_OPS = ["discovery.get"] as const;

/**
 * ONE bounded round trip. Doctor declares its OWN budget rather than importing selftest's
 * `SELFTEST_PROBE_BUDGET` — equal-by-coincidence is the honest description, and re-tuning one
 * instrument must never silently move the other. 5 s, not selftest's 10 s: this is an interactive
 * TRIAGE command whose worst case must stay inside a human's patience window, and `retries: 0`
 * makes that 5 s the HARD ceiling for the whole command, not a per-attempt one. A diagnostic that
 * retry-storms is a second incident.
 */
export const MCP_DOCTOR_PROBE_BUDGET: RequestSpec["budget"] = { timeoutMs: 5_000, retries: 0 };

/** Everything doctor reads — all injected (no `process`, no real fs/network access). */
export interface McpDoctorDeps {
  readonly client: ManagementClient;
  /** THE chain result, produced by the SHELL for this dispatch. NEVER re-derived here. */
  readonly credential: ResolvedCredential;
  /** The NOFOLLOW housekeeping port — the fallback reader for candidates the follow-read refused. */
  readonly installFs: InstallFs;
  /** The bounded, symlink-FOLLOWING reader (`runtime.readTextFile`) — see `followOverlay`. */
  readonly readTextFile: (path: string, opts: { maxBytes: number }) => Promise<string>;
  readonly homeDir: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** `--offline`: skip the ONE network probe entirely (rows (c)/(d) say so in their detail). */
  readonly offline: boolean;
}

/**
 * Run the four checks and classify the aggregate verdict. Order is LOCAL-FIRST (registration,
 * credential) so an offline or slow-network run still produces the local verdicts before any wait —
 * the selftest ordering principle. The two remote rows come from ONE probe.
 */
export async function runMcpDoctor(deps: McpDoctorDeps): Promise<McpDoctorResult> {
  const checks: McpDoctorCheck[] = [];
  checks.push(await checkRegistration(deps)); // (a) — local
  checks.push(checkCredential(deps)); // (b) — local, pure
  checks.push(...(await checkServerAndContract(deps))); // (c) + (d) — ONE discovery.get
  return { checks, verdict: verdictOf(checks) };
}

// ── check (a): registration ───────────────────────────────────────────────────

/**
 * The bounded follow-READ overlay (T-228 D-7). `detectMcpRegistration` reads through
 * `InstallFs.readUtf8`, whose production body opens with `O_NOFOLLOW` and returns `null` on
 * `ELOOP` — so a dotfiles-managed (chezmoi / stow / dotbot) `~/.claude.json` reads as ABSENT. For
 * selftest that is soft; for THIS command, whose failure tier is terminal, it would be an exit 2 on
 * a correctly-registered machine — the flagship MCP diagnostic wrong in exactly the case operators
 * most need it.
 *
 * The fix costs no new capability gate: `runtime.readTextFile` is bounded, opens `O_RDONLY |
 * O_NONBLOCK` with NO `O_NOFOLLOW` (it FOLLOWS links), and is already threaded to every runtime
 * command. We pre-read every candidate through it and hand `detectMcpRegistration` a merged reader.
 * The candidate list is the SHARED `mcpConfigCandidates` — never a forked second list — and the
 * cap is the SHARED `MCP_CONFIG_MAX_BYTES`.
 *
 * Every failure is a `null` (a skip), matching the detector's own "an unreadable candidate is a
 * skip, never a crash" contract: the bounded reader throws a `usage_error` for missing /
 * non-regular / oversized paths, none of which is a doctor failure.
 */
async function followOverlay(deps: McpDoctorDeps, detect: McpDetectDeps): Promise<Map<string, string>> {
  const candidates = mcpConfigCandidates(detect);
  const reads = await Promise.all(
    candidates.map(async (candidate): Promise<readonly [string, string | null]> => {
      try {
        return [candidate.path, await deps.readTextFile(candidate.path, { maxBytes: MCP_CONFIG_MAX_BYTES })];
      } catch {
        return [candidate.path, null];
      }
    }),
  );
  const overlay = new Map<string, string>();
  for (const [path, text] of reads) if (text !== null) overlay.set(path, text);
  return overlay;
}

async function checkRegistration(deps: McpDoctorDeps): Promise<McpDoctorCheck> {
  const name: McpDoctorCheckName = "registration";
  const detect: McpDetectDeps = {
    homeDir: deps.homeDir,
    cwd: deps.cwd,
    platform: deps.platform,
    env: deps.env,
  };
  try {
    const overlay = await followOverlay(deps, detect);
    // The follow-read wins where it produced bytes; the NOFOLLOW port stays as belt-and-braces for
    // anything it did not (a candidate outside the list can never appear — same source, same deps).
    const reader: McpConfigReader = {
      readUtf8: (path) => overlay.get(path) ?? deps.installFs.readUtf8(path),
    };
    const reg = detectMcpRegistration(reader, detect);
    // `reg.source` is the winning candidate's PATH — a location, never the file's content.
    return reg.registered
      ? { name, ok: true, detail: `registered with a detected MCP client (${reg.source})`, retryable: false }
      : {
          name,
          ok: false,
          // TERMINAL, not retryable: a missing registration is a PERSISTED configuration fact.
          // Re-running the identical command produces the identical answer; only `agkit setup` (or a
          // hand edit) changes it, so "retry with backoff" would be a lie.
          detail: "no detected MCP client registers 'agkit mcp serve' — run 'agkit setup'",
          retryable: false,
        };
  } catch {
    // Detection itself broke (a mis-wired port, a reader returning a non-string). Unlike the
    // absence above, this is a state that MAY differ on a re-run — so it rides the retryable tier.
    return { name, ok: false, detail: "MCP-registration detection failed unexpectedly", retryable: true };
  }
}

// ── check (b): credential ─────────────────────────────────────────────────────

/**
 * How each non-`none` source is NAMED in the row. The keychain arm interpolates the imported
 * `KEYCHAIN_SERVICE` constant, never the literal service name — one source for that string.
 *
 * NAMING DISCIPLINE (B-19): the check is `credential`, and no key or value here may match the
 * redaction registry's secret-field-NAME pattern. A `token_source`-style spelling would render the
 * whole diagnostic row as `(sensitive)` — `whoami get` learned this and emits `principal.class`
 * deliberately, not `token_class`. The `AGKIT_TOKEN` mention below is inside a `detail` STRING (an
 * env-var name a user must be able to read), never a field name.
 */
const CREDENTIAL_ORIGIN: Record<Exclude<CredentialSource, "none">, string> = {
  env: "credential present from AGKIT_TOKEN (env)",
  keychain: `credential present in the OS keychain (service ${KEYCHAIN_SERVICE})`,
  insecure_file: "credential present in the PLAINTEXT 0600 file",
  helper: "credential present from the credential-helper",
};

/**
 * PRESENCE, honestly labelled. This check never calls the server, so it may not claim the
 * credential is VALID — every passing detail says so in its own words.
 *
 * The `insecure_file` arm is the ticket's "warn" case, and it is realized as `ok:true` + the source
 * named, because the ratified warning CHANNEL already exists: the shell fires the persistent
 * insecure-storage banner to STDERR for every credential-consuming command. Doctor inherits it for
 * free and must not invent a second warning surface.
 */
function checkCredential(deps: McpDoctorDeps): McpDoctorCheck {
  const name: McpDoctorCheckName = "credential";
  const source = deps.credential.source;
  if (source === "none") {
    // TERMINAL for the same reason registration is: an absent credential is a persisted local fact.
    return {
      name,
      ok: false,
      detail: "no credential resolved for this profile — run 'agkit login'",
      retryable: false,
    };
  }
  return {
    name,
    ok: true,
    detail: `${CREDENTIAL_ORIGIN[source]} — presence only; not validated against the server`,
    retryable: false,
  };
}

// ── checks (c) + (d): server + contract_version, from ONE probe ───────────────

/** What the two remote rows say when the user opted out of the network with `--offline`. */
const OFFLINE_DETAIL = "not checked (--offline)";

/**
 * ONE unauthenticated `discovery.get`, read as TWO facts. `probeHandshake` already normalizes the
 * REPORT-vs-THROW skew surfaces (a 400 `version_unsupported` body vs. a thrown CLI-local
 * `version_skew`), so this function classifies verdicts only — it re-implements no wire reading.
 *
 * THE TIERS, and why each is what it is:
 *   • unreachable ⇒ RETRYABLE (1). Exit 1 is "network / timeout / 5xx / 429-after-retries"; a
 *     transport failure is transient by construction and an agent's correct response is backoff.
 *   • major skew ⇒ TERMINAL (2). `version_skew` is a CLI-local code, and every CLI-local code is
 *     exit 2. Retrying cannot change a major mismatch; the remedy is direction-aware.
 *   • skew UNKNOWN ⇒ RETRYABLE (1), never terminal. "unknown" conflates a transient non-400 wire
 *     problem with a server that advertises nothing; exit 2 would assert a permanent
 *     incompatibility we have not observed. The DETAIL names why, which is the actionable part.
 *   • a server that ANSWERED is `server ok:true` even when the answer is a version rejection —
 *     label by reality: reachability and compatibility are two different facts.
 *   • the unreachable arm leaves (d) `ok:false`, not `ok:true`: a check that did not run has not
 *     passed. It rides `retryable:true` because the CAUSE is the retryable network failure.
 *
 * `--offline` is the ONE arm where a skipped check reports `ok:true`, and it is the arm the user
 * asked for: the honesty carriers are the explicit detail, `data.offline` on the document, and the
 * opt-in itself. The rows are still EMITTED — a `checks` array that changed length would force
 * every machine consumer to branch.
 */
async function checkServerAndContract(deps: McpDoctorDeps): Promise<McpDoctorCheck[]> {
  const pin = MANAGEMENT_CONTRACT_VERSION;
  if (deps.offline) {
    return [
      { name: "server", ok: true, detail: OFFLINE_DETAIL, retryable: false },
      { name: "contract_version", ok: true, detail: OFFLINE_DETAIL, retryable: false },
    ];
  }

  let probe: HandshakeProbe;
  try {
    // `probeHandshake` swallows transport failures itself; the guard is the selftest posture — a
    // diagnostic must never die of the thing it is measuring.
    probe = await probeHandshake(deps.client, { budget: MCP_DOCTOR_PROBE_BUDGET });
  } catch {
    probe = { reachable: false, managementVersion: null, skew: null };
  }

  if (!probe.reachable) {
    return [
      { name: "server", ok: false, detail: "server unreachable", retryable: true },
      { name: "contract_version", ok: false, detail: "not measured — the server was unreachable", retryable: true },
    ];
  }

  const advertised = probe.managementVersion;
  const server: McpDoctorCheck = {
    name: "server",
    ok: true,
    detail: `server reachable (management v${advertised ?? "unadvertised"})`,
    retryable: false,
  };
  return [server, contractVersionRow(pin, probe)];
}

/** The (d) row alone — the skew verdict rendered against the client's own pinned version. */
function contractVersionRow(pin: string, probe: HandshakeProbe): McpDoctorCheck {
  const name: McpDoctorCheckName = "contract_version";
  const advertised = probe.managementVersion;
  switch (probe.skew) {
    case "match":
      return { name, ok: true, detail: `client v${pin} matches server v${advertised}`, retryable: false };
    case "minor_behind":
      return {
        name,
        ok: true,
        detail: `server speaks a newer management MINOR (client v${pin}, server v${advertised}) — consider updating`,
        retryable: false,
      };
    case "skew":
      // The advertised version is echoed VERBATIM when the probe carried one (bytes over claims —
      // the THROW-mode fence puts it in `extra.server_version`, and `probeHandshake` preserves it).
      return {
        name,
        ok: false,
        detail: `major contract skew (client v${pin}, server v${advertised ?? "an incompatible major"})`,
        retryable: false,
      };
    default:
      return {
        name,
        ok: false,
        detail: `server did not advertise a parseable management version — skew UNKNOWN (client v${pin})`,
        retryable: true,
      };
  }
}

// ── the aggregate fold ────────────────────────────────────────────────────────

/**
 * pass (all ok) · terminal_failures (≥1 non-retryable failure) · retryable_failures (else).
 * Structurally identical to selftest's fold and DELIBERATELY its own copy — see the header.
 * `EXIT.PARTIAL` is unreachable by construction: a doctor result is total, never truncated.
 */
function verdictOf(checks: readonly McpDoctorCheck[]): McpDoctorVerdict {
  const failures = checks.filter((c) => !c.ok);
  if (failures.length === 0) return "pass";
  if (failures.some((c) => !c.retryable)) return "terminal_failures";
  return "retryable_failures";
}
