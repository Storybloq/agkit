// T-222 6a — `agkit selftest` core probes. Eight sequential checks that verify the CLI's
// real plumbing end-to-end: the runtime, the OS keychain, server reachability + version skew,
// the authenticated read/write path, and the local skill/MCP integration. Each check yields a
// `{name, ok, detail, retryable}` row; the aggregate `verdict` maps to the process exit
// (pass→0, retryable_failures→1, terminal_failures→2) at the command layer (6c) — the exit-code
// authority is not named here, it stays in the command plane + the serializer chokepoint.
//
// Honor-or-reject discipline (C2 / D1): the FENCE. `discovery.get` (check 3) runs REPORT-mode
// and MEASURES skew; the authenticated/mutating checks (4 auth, 5 read, 6 write) ride
// `fence:"throw"` so a major skew that first appears at one of THOSE responses (rotation /
// mixed-version LB) preempts the write. A SHARED terminal-skew LATCH is set by ANY skew observed
// at checks 3/4/5 → all remaining remote checks (incl. the check-6 write probe) are SKIPPED,
// never sent — the write can never execute against a server we know is major-incompatible.
//
// Zero-residue write probe (A3 / D2): the write probe creates an ACCOUNT-plane `project.create`
// plan (probe-free by construction — no snapshot, no ownership on an existing resource) carrying
// a per-run cryptographically-unique NON-SECRET marker in `changes[].body.name`, with
// `idempotency.ignoreClientOverride` so a user's global `--idempotency-key` can NEVER contaminate
// it. The plan is NEVER applied (no project is created) and is discarded. The happy path discards
// by the id from the create response; an AMBIGUOUS post-send failure (the create may have
// committed) runs the D2 fallback — a bounded FULL keyset scan of `plan.list` (the frozen route
// exposes no marker/status filter) to completion, discarding every OPEN plan carrying the marker.
// An unprovable walk / a failed discard surfaces the marker + an `agkit plan …` hint — never
// silent residue.
//
// Keychain isolation (A10 / B8): the probe writes to a DEDICATED service (`agkit-cli-selftest`,
// NEVER the real `agkit-cli`), under a per-run unique account + value; it never touches a
// pre-existing entry (a collision generates a new account, bounded retries), tracks an `owned`
// flag set ONLY after its own successful write, and deletes ONLY owned accounts in a finally —
// a cleanup failure is terminal and NEVER exposes the probe value.
import type { ManagementClient, RequestSpec } from "../../commands/types";
import { KeyringUnavailableError, type KeyringPort } from "../auth";
import { skillFreshness, type InstallFs } from "../housekeeping/install";
import { detectMcpRegistration } from "../mcp/registration";
import { isSupportedNode } from "../../runtime-gate";
import { IS_DEV } from "../../version";
import { probeHandshake, type HandshakeProbe } from "../config/status";
import { narrowPlan, isPlanStatus } from "../plan/types";
import { routeFor } from "@agentkit-cloud/shared/wire-contract/management-routes-data";
import { classifyThrownError } from "../errors/classify";
import { CliLocalError, WireProblemError, EXIT } from "../errors";
import { MANAGEMENT_CONTRACT_VERSION } from "../../contract";

/** The eight check names, in run order — the envelope's `data.checks` names match this exactly. */
export const SELFTEST_CHECK_NAMES = [
  "binary",
  "credential_chain",
  "network",
  "auth",
  "read_probe",
  "write_probe",
  "skill_freshness",
  "mcp_registration",
] as const;
export type SelftestCheckName = (typeof SELFTEST_CHECK_NAMES)[number];

/** Every management operation_id the selftest can send — the version-fence exemption teeth
 * (step 11) assert each resolves via `routeFor`, so a probe op can never silently dangle. */
export const SELFTEST_PROBE_OPS = [
  "discovery.get",
  "whoami.get",
  "project.list",
  "plan.create",
  "plan.discard",
  "plan.list",
] as const;

/** A tight per-request custody budget for the probes (bounded wait, no retry storm). */
export const SELFTEST_PROBE_BUDGET: RequestSpec["budget"] = { timeoutMs: 10_000, retries: 0 };
/** The DEDICATED keychain service for the credential probe — NEVER the real `agkit-cli` (A10). */
export const SELFTEST_KEYCHAIN_SERVICE = "agkit-cli-selftest";
/** How many fresh probe accounts to try on a collision before giving up (B8). */
export const SELFTEST_KEYRING_PROBE_ATTEMPTS = 3;
/** The unique NON-SECRET marker prefix stamped into the write-probe plan's change name (A3). */
export const SELFTEST_PROBE_MARKER_PREFIX = "agkit-selftest-probe-";
/** Hard page cap for the D2 reconcile scan (a runaway-list backstop, far above any real backlog). */
export const SELFTEST_CLEANUP_MAX_PAGES = 50;

export interface SelftestCheck {
  readonly name: SelftestCheckName;
  readonly ok: boolean;
  readonly detail: string;
  readonly retryable: boolean;
}

export type SelftestVerdict = "pass" | "retryable_failures" | "terminal_failures";

export interface SelftestResult {
  readonly checks: readonly SelftestCheck[];
  readonly verdict: SelftestVerdict;
}

/** Everything the selftest reads — all injected (no `process`, no real fs/keychain access). */
export interface SelftestDeps {
  readonly client: ManagementClient;
  readonly keyring: KeyringPort;
  readonly installFs: InstallFs;
  readonly homeDir: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The running CLI version (binary check + skill freshness). */
  readonly version: string;
  /** The running Node.js version, possibly `v`-prefixed (`process.version`). */
  readonly nodeVersion: string;
  /** ms clock — RTT measurement. */
  readonly now: () => number;
  /** UUIDv4 seam — unique probe markers + keychain account/value (injected for determinism). */
  readonly randomUUID: () => string;
  /** Override the build-time `IS_DEV` (tests). */
  readonly isDev?: boolean;
}

/** A mutable single-cell latch shared across the sequential checks (D1). */
interface SkewLatch {
  latched: boolean;
}

/** Run the eight checks sequentially and classify the aggregate verdict. */
export async function runSelftest(deps: SelftestDeps): Promise<SelftestResult> {
  const skew: SkewLatch = { latched: false };
  const checks: SelftestCheck[] = [];

  checks.push(checkBinary(deps)); // 1 — local
  checks.push(await checkCredentialChain(deps)); // 2 — local keychain
  checks.push(await checkNetwork(deps, skew)); // 3 — remote (report; MEASURES skew)
  checks.push(await remoteOrSkip("auth", skew, () => checkAuth(deps, skew))); // 4
  checks.push(await remoteOrSkip("read_probe", skew, () => checkReadProbe(deps, skew))); // 5
  checks.push(await remoteOrSkip("write_probe", skew, () => checkWriteProbe(deps, skew))); // 6
  checks.push(checkSkillFreshness(deps)); // 7 — local
  checks.push(checkMcpRegistration(deps)); // 8 — local

  return { checks, verdict: verdictOf(checks) };
}

/** D1: once the skew latch is set, a remaining remote check is SKIPPED (never sent). */
async function remoteOrSkip(
  name: SelftestCheckName,
  skew: SkewLatch,
  run: () => Promise<SelftestCheck>,
): Promise<SelftestCheck> {
  if (skew.latched) {
    return { name, ok: false, detail: "skipped: server major-contract skew", retryable: false };
  }
  return run();
}

// ── check 1: binary ──────────────────────────────────────────────────────────
function checkBinary(deps: SelftestDeps): SelftestCheck {
  const isDev = deps.isDev ?? IS_DEV;
  // `process.version` is `v`-prefixed; `isSupportedNode` parses the bare numeric major.
  const bareNode = deps.nodeVersion.replace(/^v/, "");
  const supported = isSupportedNode(bareNode);
  const base = `agkit v${deps.version}${isDev ? " (dev build)" : ""} on Node ${deps.nodeVersion}`;
  return supported
    ? { name: "binary", ok: true, detail: base, retryable: false }
    : { name: "binary", ok: false, detail: `${base} — unsupported Node runtime`, retryable: false };
}

// ── check 2: credential_chain (keychain read/write probe) ─────────────────────
async function checkCredentialChain(deps: SelftestDeps): Promise<SelftestCheck> {
  const name: SelftestCheckName = "credential_chain";
  const value = "agkit-selftest-" + deps.randomUUID(); // NON-SECRET, ephemeral
  let owned: string | null = null;
  let result: SelftestCheck;

  try {
    // Find a free probe account — NEVER touch a pre-existing entry (B8).
    let account: string | null = null;
    for (let i = 0; i < SELFTEST_KEYRING_PROBE_ATTEMPTS; i++) {
      const candidate = "selftest-probe-" + deps.randomUUID();
      const existing = await deps.keyring.get(SELFTEST_KEYCHAIN_SERVICE, candidate);
      if (existing === null) {
        account = candidate;
        break;
      }
      // collision: leave the pre-existing entry untouched, try a new account.
    }
    if (account === null) {
      return { name, ok: false, detail: "keychain probe could not acquire a free probe account", retryable: true };
    }
    await deps.keyring.set(SELFTEST_KEYCHAIN_SERVICE, account, value);
    owned = account; // owned ONLY after OUR successful write (B8).
    const readBack = await deps.keyring.get(SELFTEST_KEYCHAIN_SERVICE, account);
    result =
      readBack === value
        ? { name, ok: true, detail: "OS keychain read/write verified", retryable: false }
        : { name, ok: false, detail: "keychain read-back did not match the written probe", retryable: true };
  } catch (err) {
    result =
      err instanceof KeyringUnavailableError
        ? { name, ok: false, detail: "OS keychain backend unavailable on this host", retryable: false }
        : { name, ok: false, detail: "keychain probe failed unexpectedly", retryable: false };
  }

  // Cleanup: delete ONLY an owned account; a delete failure is terminal and NEVER exposes the value.
  if (owned !== null) {
    try {
      await deps.keyring.delete(SELFTEST_KEYCHAIN_SERVICE, owned);
    } catch {
      result = {
        name,
        ok: false,
        detail: `keychain probe cleanup failed — a probe entry may remain under service ${SELFTEST_KEYCHAIN_SERVICE}`,
        retryable: false,
      };
    }
  }
  return result;
}

// ── check 3: network (report-mode handshake; MEASURES skew, may LATCH) ─────────
async function checkNetwork(deps: SelftestDeps, skew: SkewLatch): Promise<SelftestCheck> {
  const name: SelftestCheckName = "network";
  const t0 = deps.now();
  let probe: HandshakeProbe;
  try {
    // probeHandshake swallows transport failures to reachable:false and normalizes a skew from
    // EITHER a report-mode body read OR a throw-mode fence/`version_unsupported` — robust to
    // whichever fence mode the client was built with.
    probe = await probeHandshake(deps.client, { budget: SELFTEST_PROBE_BUDGET });
  } catch {
    return { name, ok: false, detail: "server unreachable (handshake probe failed)", retryable: true };
  }
  const rtt = Math.max(0, deps.now() - t0);
  if (!probe.reachable) {
    return { name, ok: false, detail: `server unreachable after ${rtt}ms`, retryable: true };
  }
  if (probe.skew === "skew") {
    skew.latched = true; // D1: set the shared latch — later remote checks are skipped.
    const server = probe.managementVersion ?? "an incompatible major";
    return {
      name,
      ok: false,
      detail: `server major-contract skew (client v${MANAGEMENT_CONTRACT_VERSION}, server v${server}) — remaining remote checks skipped`,
      retryable: false,
    };
  }
  return {
    name,
    ok: true,
    detail: `server reachable in ${rtt}ms (management v${probe.managementVersion ?? "unadvertised"}, skew: ${probe.skew ?? "unknown"})`,
    retryable: false,
  };
}

// ── check 4: auth (whoami.get, throw-mode) ────────────────────────────────────
async function checkAuth(deps: SelftestDeps, skew: SkewLatch): Promise<SelftestCheck> {
  const name: SelftestCheckName = "auth";
  try {
    const who = await deps.client.request({
      operationId: "whoami.get",
      params: {},
      fence: "throw",
      budget: SELFTEST_PROBE_BUDGET,
    });
    const scopes = extractScopes(who);
    return {
      name,
      ok: true,
      detail: scopes.length > 0 ? `authenticated; scopes: ${scopes.join(", ")}` : "authenticated",
      retryable: false,
    };
  } catch (err) {
    if (isSkewSignal(err)) {
      skew.latched = true;
      return skewObserved(name);
    }
    const { code, retryable } = failureSummary(err);
    return { name, ok: false, detail: `authentication probe failed: ${code}`, retryable };
  }
}

// ── check 5: read_probe (project.list, throw-mode) ────────────────────────────
async function checkReadProbe(deps: SelftestDeps, skew: SkewLatch): Promise<SelftestCheck> {
  const name: SelftestCheckName = "read_probe";
  try {
    await deps.client.request({
      operationId: "project.list",
      params: { limit: 1 },
      fence: "throw",
      budget: SELFTEST_PROBE_BUDGET,
    });
    return { name, ok: true, detail: "authenticated read (project.list) succeeded", retryable: false };
  } catch (err) {
    if (isSkewSignal(err)) {
      skew.latched = true;
      return skewObserved(name);
    }
    const { code, retryable } = failureSummary(err);
    return { name, ok: false, detail: `read probe failed: ${code}`, retryable };
  }
}

// ── check 6: write_probe (plan.create → discard; A3 marker, D2 reconcile) ──────
async function checkWriteProbe(deps: SelftestDeps, skew: SkewLatch): Promise<SelftestCheck> {
  const name: SelftestCheckName = "write_probe";
  const marker = SELFTEST_PROBE_MARKER_PREFIX + deps.randomUUID();
  // An ACCOUNT-plane project.create: probe-free by construction (no snapshot / no ownership on an
  // existing resource) and NEVER applied, so no project is created. The marker rides body.name.
  const change = {
    action: "create",
    resource: "project",
    path: "/v1/management/projects",
    body: { name: marker },
  };

  let created: unknown;
  let createThrew: unknown = null;
  try {
    created = await deps.client.request({
      operationId: "plan.create",
      params: { note: marker, changes: [change] },
      idempotency: { ignoreClientOverride: true }, // A3: never contaminated by a user --idempotency-key.
      fence: "throw",
      budget: SELFTEST_PROBE_BUDGET,
    });
  } catch (err) {
    createThrew = err;
  }

  if (createThrew !== null) {
    const disposition = writeProbeDisposition(createThrew);
    if (disposition === "skew") {
      // The server rejects a major mismatch BEFORE route execution (frozen invariant) → nothing
      // committed → no residue. Latch + report terminal skew; no reconcile.
      skew.latched = true;
      return skewObserved(name);
    }
    if (disposition === "pre_send" || disposition === "rejected") {
      // Nothing committed (a local/guard fault, or a server pre-commit rejection) → no reconcile.
      const { code, retryable } = failureSummary(createThrew);
      const why = disposition === "pre_send" ? "could not start" : "rejected by the server";
      return { name, ok: false, detail: `write probe ${why}: ${code}`, retryable };
    }
    // AMBIGUOUS (5xx / transport loss): the write MAY have committed → D2 reconcile.
    return reconcileVerdict(deps, name, marker, "write probe (plan.create) outcome was ambiguous");
  }

  // The create RESOLVED (a 2xx committed a plan). Verify the shape + discard by id (happy path:
  // create → discard, no list). A resolved body with no usable id falls to the D2 reconcile.
  const id = extractPlanId(created);
  const narrowed = narrowPlan(created);
  if (id === null) {
    return reconcileVerdict(deps, name, marker, "write probe returned a plan with no usable id");
  }
  const discarded = await discardById(deps, id);
  if (!discarded.ok) {
    return { name, ok: false, detail: discarded.detail, retryable: false };
  }
  if (!narrowed.ok || narrowed.plan.status !== "open") {
    const shape = narrowed.ok ? `status ${narrowed.plan.status}` : narrowed.reason;
    return { name, ok: false, detail: `write probe created a plan of an unexpected shape (${shape})`, retryable: false };
  }
  return {
    name,
    ok: true,
    detail: "authenticated write round-trip (plan.create + discard) verified",
    retryable: false,
  };
}

// ── check 7: skill_freshness ──────────────────────────────────────────────────
function checkSkillFreshness(deps: SelftestDeps): SelftestCheck {
  const name: SelftestCheckName = "skill_freshness";
  const fresh = skillFreshness(deps.installFs, deps.homeDir, deps.version, { isDev: deps.isDev ?? IS_DEV });
  const installed = fresh.installed ?? "none";
  switch (fresh.status) {
    case "current":
      return { name, ok: true, detail: `skill tree current (v${installed})`, retryable: false };
    case "dev":
      return { name, ok: true, detail: "skill sync disabled on dev builds", retryable: false };
    case "stale":
      return { name, ok: false, detail: `skill tree stale (installed v${installed}) — re-syncs on the next run`, retryable: true };
    case "absent":
    default:
      return { name, ok: false, detail: "skill tree not installed — re-syncs on the next run", retryable: true };
  }
}

// ── check 8: mcp_registration (informational — never a hard failure) ──────────
function checkMcpRegistration(deps: SelftestDeps): SelftestCheck {
  const name: SelftestCheckName = "mcp_registration";
  try {
    const reg = detectMcpRegistration(deps.installFs, {
      homeDir: deps.homeDir,
      cwd: deps.cwd,
      platform: deps.platform,
      env: deps.env,
    });
    return reg.registered
      ? { name, ok: true, detail: `registered with a detected client (${reg.source})`, retryable: false }
      : { name, ok: true, detail: "not registered with any detected client (optional — run 'agkit setup')", retryable: false };
  } catch {
    return { name, ok: false, detail: "MCP-registration detection failed unexpectedly", retryable: true };
  }
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** A skew OBSERVED by a check that ran (vs. a downstream SKIPPED check). */
function skewObserved(name: SelftestCheckName): SelftestCheck {
  return {
    name,
    ok: false,
    detail: "server major-contract skew observed — remaining remote checks skipped",
    retryable: false,
  };
}

/** Is `err` a version-skew signal — the throw-mode CLI-local skew OR a wire `version_unsupported` 400? */
function isSkewSignal(err: unknown): boolean {
  if (err instanceof CliLocalError && err.code === "version_skew") return true;
  if (err instanceof WireProblemError && err.problem.code === "version_unsupported" && err.problem.status === 400) {
    return true;
  }
  return false;
}

/** A non-secret failure code + its retryable class (the DETAIL never carries a server sentence). */
function failureSummary(err: unknown): { code: string; retryable: boolean } {
  const { exitCode } = classifyThrownError(err);
  let code: string;
  if (err instanceof WireProblemError) code = err.problem.code ?? "wire_error";
  else if (err instanceof CliLocalError) code = err.code;
  else if (err instanceof Error && err.name === "RetryableTransportError") code = "transport_failure";
  else code = "error";
  return { code, retryable: exitCode === EXIT.RETRYABLE };
}

/** Classify a plan.create failure by WHAT reached the wire — the reconcile predicate (D2 / A39). */
function writeProbeDisposition(err: unknown): "skew" | "ambiguous" | "pre_send" | "rejected" {
  if (isSkewSignal(err)) return "skew";
  if (err instanceof WireProblemError) {
    // The server RESPONDED: a 5xx may be post-commit (ambiguous); a 4xx is a pre-commit rejection.
    const status = err.problem.status ?? 0;
    return status >= 500 ? "ambiguous" : "rejected";
  }
  // A retry-exhausted transport failure lost the response leg — the write MAY have committed.
  if (err instanceof Error && err.name === "RetryableTransportError") return "ambiguous";
  // Everything else (RequestPreparationError, the url-guard ConfigError, a usage_error, an
  // unexpected local throw) never reached the wire.
  return "pre_send";
}

/** Defensively read a plan id string from a resolved create response (null if absent/non-string). */
function extractPlanId(raw: unknown): string | null {
  if (raw !== null && typeof raw === "object") {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** Read a `scopes` string array off a whoami response (empty when absent/malformed). */
function extractScopes(who: unknown): string[] {
  if (who !== null && typeof who === "object") {
    const scopes = (who as Record<string, unknown>).scopes;
    if (Array.isArray(scopes)) return scopes.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** Discard a plan by id, with one retry (best-effort cleanup — report mode, so a skewed server
 * still gets a cleanup attempt). A failure after the retry surfaces the id + a manual hint. */
async function discardById(deps: SelftestDeps, id: string): Promise<{ ok: boolean; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.client.request({
        operationId: "plan.discard",
        params: { id },
        fence: "report",
        budget: SELFTEST_PROBE_BUDGET,
      });
      return { ok: true, detail: "discarded" };
    } catch {
      // fall through to the retry / failure
    }
  }
  return {
    ok: false,
    detail: `write probe left an OPEN plan (${id}) — discard failed after a retry; run 'agkit plan discard ${id}'`,
  };
}

/**
 * D2 fallback (b): a bounded FULL keyset scan of `plan.list` (the frozen route exposes no
 * marker/status filter) to completion or the page cap, discarding every OPEN plan carrying our
 * marker as the scan encounters it. Returns a check verdict: proven-clean-after-an-ambiguous-create
 * is retryable; an unprovable walk / a residual discard failure is TERMINAL and surfaces the marker.
 */
async function reconcileVerdict(
  deps: SelftestDeps,
  name: SelftestCheckName,
  marker: string,
  why: string,
): Promise<SelftestCheck> {
  const listMax = routeFor("plan.list")?.pagination?.max_limit;
  if (listMax === undefined) {
    // Registry drift — we cannot bound the scan → fail closed (never claim a clean walk).
    return { name, ok: false, detail: `${why}; could not reconcile (plan.list route metadata missing)`, retryable: false };
  }

  // Every match is discarded AS IT IS ENCOUNTERED, never batched to the end of the walk: a
  // failure on a LATER page must not abandon an orphan we already hold an id for. A keyset cursor
  // is position-stable under deletion and a discarded plan re-served on a later page no longer
  // passes `rowIsOpen`, so mid-scan discards are pagination-safe; the `discarded` set makes a
  // re-serve idempotent anyway. Early discards never upgrade an incomplete walk to proven — the
  // UNSCANNED remainder still returns the terminal unproven verdict.
  const discarded = new Set<string>();
  let cursor: string | undefined;
  let proven = false;
  for (let page = 0; page < SELFTEST_CLEANUP_MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = await deps.client.request({
        operationId: "plan.list",
        params: { limit: listMax, ...(cursor !== undefined ? { cursor } : {}) },
        fence: "report",
        budget: SELFTEST_PROBE_BUDGET,
      });
    } catch {
      return unprovenReconcile(name, marker, why, "plan.list failed during reconcile");
    }
    if (!isListPage(body)) {
      return unprovenReconcile(name, marker, why, "malformed plan.list page during reconcile");
    }
    for (const row of body.data) {
      if (!rowIsOpen(row) || !rowHasMarker(row, marker)) continue;
      const id = extractPlanId(row);
      if (id === null) {
        // Ours, open, and undiscardable — we can never prove this row away, so fail CLOSED rather
        // than claim a reconciled walk.
        return unprovenReconcile(name, marker, why, "a marked plan row carried no usable id during reconcile");
      }
      if (discarded.has(id)) continue;
      const cleanup = await discardById(deps, id);
      if (!cleanup.ok) {
        return { name, ok: false, detail: cleanup.detail, retryable: false };
      }
      discarded.add(id);
    }
    if (body.has_more !== true) {
      proven = true;
      break;
    }
    if (typeof body.next_cursor !== "string") {
      return unprovenReconcile(name, marker, why, "plan.list advertised has_more without a cursor");
    }
    cursor = body.next_cursor;
  }

  if (!proven) {
    return unprovenReconcile(name, marker, why, `reconcile scan exceeded ${SELFTEST_CLEANUP_MAX_PAGES} pages`);
  }
  // Proven clean (found + discarded, or none found). The create itself still failed → not ok, but
  // the residue is reconciled, so this is a retryable (transient) failure, not a terminal one.
  return { name, ok: false, detail: `${why}; probe residue reconciled`, retryable: true };
}

function unprovenReconcile(
  name: SelftestCheckName,
  marker: string,
  why: string,
  detail: string,
): SelftestCheck {
  return {
    name,
    ok: false,
    detail: `${why}; ${detail} — run 'agkit plan list' and discard any plan named '${marker}'`,
    retryable: false,
  };
}

/** A well-formed list page: `{data:[], has_more:boolean, next_cursor?}` (fail-closed otherwise). */
function isListPage(body: unknown): body is { data: unknown[]; has_more: boolean; next_cursor?: unknown } {
  return (
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).data) &&
    typeof (body as Record<string, unknown>).has_more === "boolean"
  );
}

/** Is this list row an OPEN plan (per the closed plan-status set)? */
function rowIsOpen(row: unknown): boolean {
  if (row === null || typeof row !== "object") return false;
  const status = (row as Record<string, unknown>).status;
  return isPlanStatus(status) && status === "open";
}

/** Does any change on this row carry our marker in `body.name`? */
function rowHasMarker(row: unknown, marker: string): boolean {
  if (row === null || typeof row !== "object") return false;
  const changes = (row as Record<string, unknown>).changes;
  if (!Array.isArray(changes)) return false;
  return changes.some((c) => {
    if (c === null || typeof c !== "object") return false;
    const body = (c as Record<string, unknown>).body;
    return body !== null && typeof body === "object" && (body as Record<string, unknown>).name === marker;
  });
}

/** pass (all ok) · terminal_failures (≥1 non-retryable failure) · retryable_failures (else). */
function verdictOf(checks: readonly SelftestCheck[]): SelftestVerdict {
  const failures = checks.filter((c) => !c.ok);
  if (failures.length === 0) return "pass";
  if (failures.some((c) => !c.retryable)) return "terminal_failures";
  return "retryable_failures";
}
