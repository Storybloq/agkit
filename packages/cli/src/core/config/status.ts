// The `agkit status` session aggregate (T-208 deliverable 5 + T-211 handshake). A
// session-start snapshot an agent reads to know, without guessing: am I authenticated
// (and from WHERE), what profile/project/api_url am I effectively using (and from WHICH
// precedence layer), is the API-URL guard satisfied, is the CLI current — and, via the
// T-211 REPORT-path handshake, is the server reachable + what management version does it
// advertise + is there version skew.
//
// The handshake is the ONE server round-trip status makes, and it is on the REPORT path
// (A31): a public unauthenticated `discovery.get` whose failure (unreachable / skew / any
// wire problem) is SWALLOWED to `server_reachable:false|true` DATA at exit 0 — T-208
// FORBIDDEN: status must NEVER return non-zero for an unauthenticated / unreachable /
// skewed session. It is the instrument that MEASURES skew and cannot be killed by it.
// We NEVER fake a round-trip — a rejecting client (unreachable server) reads as unreachable.
//
// Still deferred (need an AUTHENTICATED identity probe, a later increment, NOT a server
// round-trip status fakes): `principal` / `scopes` (whoami.get) — explicit `null`, surfaced
// in `meta.deferred`. T-212 S8 landed `pending_plans` (+ its `_truncated` honesty label):
// `probePendingPlans` below — gated on authenticated + reachable, refresh-suppressed (A-9),
// page-bounded, exit-0-always.
import {
  KEYCHAIN_SERVICE,
  KeyringUnavailableError,
  readEnvToken,
  readInsecureRecord,
  type KeyringPort,
} from "../auth";
import { routeFor } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import { isPlanStatus } from "../plan/types";
import type { ManagementClient, RequestSpec } from "../../commands/types";
import { CliLocalError, WireProblemError } from "../errors";
import { evaluateSkew } from "../client/handshake";
import { MANAGEMENT_CONTRACT_VERSION } from "../../contract";
import { loadConfig } from "./config-file";
import { discoverRepoProject } from "./repo-project";
import { resolveContext, type ContextFlags, type ContextSource } from "./context";
import { guardVerdict, type GuardStatus } from "./url-guard";
import { readUpdateStamp } from "./state";
import type { ConfigDirDeps } from "./dirs";

/** Everything status reads (all injected — no `process` access). */
export interface StatusDeps extends ConfigDirDeps {
  readonly keyring: KeyringPort;
  readonly cwd: string;
  readonly flags: ContextFlags;
  /** The running CLI version (for the update notice). */
  readonly version: string;
}

/** WHERE a stored credential was found (PRESENCE only — status makes no server call). */
export type StatusCredentialSource = "env" | "keychain" | "insecure_file" | "none";

/** The flat status document — readable as human key:value AND a clean `--json` shape. */
export interface StatusData {
  // --- auth (LOCAL presence; `authenticated:false` is DATA at exit 0) ----------
  authenticated: boolean;
  credential_source: StatusCredentialSource;
  insecure_storage: boolean;
  keychain_available: boolean;
  // --- effective context, each WITH ITS SOURCE (deliverable 2 + 5) -------------
  profile: string;
  profile_source: ContextSource;
  project: string | null;
  project_source: ContextSource;
  api_url: string;
  api_url_source: ContextSource;
  api_url_guard: GuardStatus;
  api_url_host: string | null;
  // --- config + CLI ------------------------------------------------------------
  config_path: string;
  config_present: boolean;
  cli_version: string;
  update_available: string | null;
  // --- deferred: skill freshness (T-209 not yet landed) ------------------------
  skills: null;
  // --- server handshake (T-211 report-path probe; null only before/without a probe) ---
  server_reachable: boolean | null;
  management_version: string | null;
  version_skew: string | null;
  // --- deferred post-T-211: need an AUTHENTICATED identity probe (whoami.get) ------
  principal: string | null;
  scopes: string[] | null;
  /**
   * T-212 S8 (design (f)): open plans among the MOST-RECENT plan.list page at the route's
   * max limit — the wire has no status filter (`filters: []`), so the count is client-side
   * and PAGE-BOUNDED. `null` = the probe did not run (unauthenticated / unreachable) or
   * failed (exit-0-always: a 401/network/malformed page is swallowed, never an error).
   */
  pending_plans: number | null;
  /**
   * Honest labeling for the page bound: `true` when the counted page reported `has_more`
   * (open plans beyond the window may exist), `false` when the page was complete, `null`
   * exactly when `pending_plans` is null.
   */
  pending_plans_truncated: boolean | null;
}

/** What status returns: the data + an optional update notice to mirror to stderr (TTY). */
export interface StatusResult {
  readonly data: StatusData;
  readonly updateNotice: string | null;
}

/** The handshake fields status fills from its REPORT-path server probe. */
export interface HandshakeProbe {
  /** Did the server respond at all? `false` = unreachable (never null once probed). */
  readonly reachable: boolean;
  /** The server's advertised management version, when a clean discovery body was read. */
  readonly managementVersion: string | null;
  /** The skew verdict vs the pinned client version, or null when unreachable. */
  readonly skew: SkewVerdict | null;
}

/** Skew verdict labels surfaced as `version_skew` data (mirror of the fence's verdicts). */
export type SkewVerdict = "match" | "minor_behind" | "skew" | "unknown";

/** Read `management_version` off a discovery.get body (bytes-first; null when absent/not a string). */
function readManagementVersion(discovery: unknown): string | null {
  if (discovery !== null && typeof discovery === "object") {
    const v = (discovery as Record<string, unknown>)["management_version"];
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * The REPORT-path handshake probe (T-211, A31): ONE public `discovery.get` through the typed
 * client, interpreted as DATA. On a 2xx the server's advertised version comes from the discovery
 * BODY (the typed `request()` return cannot carry a response header) and the verdict is computed
 * against the pinned client version. A major-ahead server rejects EVERY management request with a
 * 400 `version_unsupported` (risk-register #4) — status reports that as reachable + skew, reading
 * whichever the client surfaced: a REPORT-mode fence lets the wire problem through (its
 * `version_unsupported` code IS the signal); a THROW-mode client would surface `version_skew`
 * instead — status honors BOTH so it is robust to whichever client it is handed. Any transport
 * failure / retry-exhaustion / a rejecting client ⇒ `server_reachable:false`, exit 0.
 */
export async function probeHandshake(
  client: ManagementClient,
  // T-222 S3: callers with bounded custody (version/selftest probes) thread a per-request
  // budget onto the ONE discovery request; existing one-arg call sites are unchanged.
  opts?: { readonly budget?: RequestSpec["budget"] },
): Promise<HandshakeProbe> {
  try {
    const discovery = await client.request({ operationId: "discovery.get", params: {}, budget: opts?.budget });
    const managementVersion = readManagementVersion(discovery);
    const { verdict } = evaluateSkew(MANAGEMENT_CONTRACT_VERSION, managementVersion);
    return { reachable: true, managementVersion, skew: verdict };
  } catch (err) {
    // A major-ahead server is REACHABLE — it answered, just with a version rejection. Gated on
    // the DOCUMENTED transport status (400): the authoritative status wins over a body claim, so
    // a 503/401 that happens to carry the code is NOT read as skew — it is an unsettled handshake.
    if (err instanceof WireProblemError) {
      if (err.problem.code === "version_unsupported" && err.problem.status === 400) {
        return { reachable: true, managementVersion: null, skew: "skew" };
      }
      // Any other wire problem (500 etc.): reachable, but the handshake did not settle.
      return { reachable: true, managementVersion: null, skew: "unknown" };
    }
    // A THROW-path client surfaces a major skew as the CLI-local version_skew — still reachable.
    // The fence's error carries the ADVERTISED version in `extra.server_version` (handshake.ts);
    // report it verbatim (bytes over claims) rather than losing it to null.
    if (err instanceof CliLocalError && err.code === "version_skew") {
      const advertised = err.extra?.["server_version"];
      return {
        reachable: true,
        managementVersion: typeof advertised === "string" ? advertised : null,
        skew: "skew",
      };
    }
    // Transport failure / retry-exhaustion / a rejecting client → unreachable (never an error).
    return { reachable: false, managementVersion: null, skew: null };
  }
}

/** What the pending-plans probe yields — the pair is null/null exactly together. */
export interface PendingPlansProbe {
  readonly pendingPlans: number | null;
  readonly truncated: boolean | null;
}

// The probe's page size = the frozen route's OWN max limit (metadata, never a literal).
const PLAN_LIST_ROUTE = routeFor("plan.list");

/**
 * The AUTHENTICATED plan probe (T-212 S8, design (f)): ONE `plan.list` page at the route's
 * max limit; `pending_plans` = the count of `status === "open"` entries ON THAT PAGE (the
 * wire has no status filter, so the count is client-side and page-bounded — `truncated`
 * labels the bound honestly from `has_more`). A-9: the request rides `refresh: false`, so
 * this zero-mutation instrument can NEVER consume a refresh-token rotation — an expired
 * token reads as null fields at exit 0, never a burned rotation, never an error.
 * Exit-0-always: EVERY failure (401, network, skew, a malformed page) swallows to nulls.
 */
export async function probePendingPlans(client: ManagementClient): Promise<PendingPlansProbe> {
  const max = PLAN_LIST_ROUTE?.pagination?.max_limit;
  if (max === undefined) return { pendingPlans: null, truncated: null }; // registry drift — fail null, not loud
  try {
    const page = (await client.request({
      operationId: "plan.list",
      params: { limit: max },
      refresh: false,
    })) as { data?: unknown; has_more?: unknown };
    // Fail-closed: a page we cannot FULLY parse yields "unknown" (null/null), never a confident
    // count. (1) the truncation label must be a real boolean; (2) EVERY entry must be a
    // well-formed list item FOR THE COUNT — an object whose `status` is a recognized plan-status
    // (the SAME closed set `narrowPlan` validates against; the list item is legitimately lighter
    // than a full plan, so we require only what the count reads). A single unparseable entry, or a
    // non-boolean/absent has_more, taints the whole page → null/null.
    if (typeof page.has_more !== "boolean") return { pendingPlans: null, truncated: null };
    if (!Array.isArray(page.data)) return { pendingPlans: null, truncated: null };
    let open = 0;
    for (const entry of page.data) {
      if (entry === null || typeof entry !== "object") return { pendingPlans: null, truncated: null };
      const status = (entry as Record<string, unknown>).status;
      if (!isPlanStatus(status)) return { pendingPlans: null, truncated: null };
      if (status === "open") open += 1;
    }
    return { pendingPlans: open, truncated: page.has_more };
  } catch {
    return { pendingPlans: null, truncated: null };
  }
}

interface AuthProbe {
  authenticated: boolean;
  source: StatusCredentialSource;
  insecure: boolean;
  keychainAvailable: boolean;
}

/**
 * Probe credential PRESENCE for the active profile, gracefully. Precedence mirrors
 * the read chain (AGKIT_TOKEN > insecure file > keychain), MINUS the credential
 * helper (which would spawn a subprocess — out of scope for a status snapshot; a
 * helper-only credential reads as `none` here). A missing keychain BACKEND is
 * `keychain_available:false` with `authenticated:false` — never a thrown error, so
 * status stays exit 0 (FORBIDDEN: a non-zero exit for an unauthenticated session).
 */
async function probeAuth(deps: StatusDeps, profile: string): Promise<AuthProbe> {
  if (readEnvToken(deps.env)) {
    return { authenticated: true, source: "env", insecure: false, keychainAvailable: true };
  }
  try {
    if (readInsecureRecord(profile, { homeDir: deps.homeDir, env: deps.env, isTTY: false })) {
      return { authenticated: true, source: "insecure_file", insecure: true, keychainAvailable: true };
    }
  } catch {
    // A widened/malformed plaintext file is surfaced loudly by the credential-consuming
    // commands; for a best-effort STATUS snapshot we treat it as "not present" and move on.
  }
  try {
    const raw = await deps.keyring.get(KEYCHAIN_SERVICE, profile);
    return raw
      ? { authenticated: true, source: "keychain", insecure: false, keychainAvailable: true }
      : { authenticated: false, source: "none", insecure: false, keychainAvailable: true };
  } catch (err) {
    if (err instanceof KeyringUnavailableError) {
      return { authenticated: false, source: "none", insecure: false, keychainAvailable: false };
    }
    throw err;
  }
}

/**
 * Assemble the status snapshot. `handshake` (when supplied by the caller's REPORT-path probe)
 * fills the reachability + management_version + skew fields; the identity fields (principal /
 * scopes) and pending_plans stay null (deferred — an AUTHENTICATED probe, a later increment).
 * When no handshake is supplied (a local-only assembly), the server fields are null.
 */
export async function assembleStatus(deps: StatusDeps, handshake?: HandshakeProbe): Promise<StatusResult> {
  const { config, path, present } = loadConfig(deps);
  const repo = discoverRepoProject(deps.cwd)?.project ?? null;
  const ctx = resolveContext({ flags: deps.flags, env: deps.env, repo, config });
  const auth = await probeAuth(deps, ctx.profile.value);
  const verdict = guardVerdict(config, ctx.profile.value, ctx.apiUrl.value);

  const update = readUpdateStamp(deps, deps.version);

  const data: StatusData = {
    authenticated: auth.authenticated,
    credential_source: auth.source,
    insecure_storage: auth.insecure,
    keychain_available: auth.keychainAvailable,

    profile: ctx.profile.value,
    profile_source: ctx.profile.source,
    project: ctx.project.value,
    project_source: ctx.project.source,
    api_url: ctx.apiUrl.value,
    api_url_source: ctx.apiUrl.source,
    api_url_guard: verdict.status,
    api_url_host: verdict.host,

    config_path: path,
    config_present: present,
    cli_version: deps.version,
    update_available: update.latest,

    // TODO(T-209): when the skill-refresh module lands, report skill freshness here.
    skills: null,

    // T-211 REPORT-path handshake (a public discovery.get; swallowed to reachable:false on any
    // failure — status is exit-0 always). `principal`/`scopes` remain null: they need an
    // AUTHENTICATED whoami.get, a later increment (surfaced in meta.deferred). The pending-plans
    // pair starts null here; the STATUS HANDLER fills it via `probePendingPlans` when (and only
    // when) the session is authenticated AND the handshake said reachable (T-212 S8).
    server_reachable: handshake ? handshake.reachable : null,
    management_version: handshake ? handshake.managementVersion : null,
    version_skew: handshake ? handshake.skew : null,
    principal: null,
    scopes: null,
    pending_plans: null,
    pending_plans_truncated: null,
  };

  return { data, updateNotice: update.notice };
}
