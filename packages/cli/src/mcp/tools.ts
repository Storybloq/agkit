// T-226 S3b — THE tool table: the real `McpToolTable` the protocol shell (mcp.ts) is handed.
//
// `listTools()` serves the canonical serializer's own objects, so the bytes on the wire are the
// bytes the golden pins. `callTool()` is a thin sequencer over `dispatch.ts` and `result.ts`:
//
//   resolve (pure, no I/O)  →  open the call (credential + client + project)
//     →  auth gate  →  run the entry  →  toMcpResult
//
// Only the FOUR tool classes below add anything to that spine, and each addition is a translation,
// never a re-decision:
//   • read / plan  — nothing at all beyond the ceremony flags: a derived plan tool runs `planOnly`,
//                    so it CREATES a plan and returns it, and the gated executor applies it.
//   • agkit_apply  — translates the ENGINE's typed outcome (D0-h `reason`/`challenge`) into a class.
//                    It never re-implements the gate, never reads the ceremony's English `detail`,
//                    and never issues a second `plan.get` to recover a challenge (plan §5).
//   • agkit_status — the F6 session aggregate: the `status get` handler's own document plus four
//                    best-effort probes, each swallowed to null, output ENUMERATED. Its FIRST
//                    successful result per session that reports an update also carries the S4.5
//                    one-shot banner item (`withUpdateBanner`) — prose prepended, machine JSON
//                    still last, `structuredContent` untouched.
//
// SECRET SUPPRESSION (T-227 S5b) rides the SAME spine, and it is wired at EVERY exit rather than at
// the interesting ones: once `dispatch.ts` resolves a `SecretRef` process-side it registers the
// value on the call, and every renderer below subtracts `call.secrets.suppressed()` from the bytes
// it emits — success envelopes, refusals, the apply translations, the status document, the
// cancellation notices. A site that could not carry a view is one where NO call object exists yet
// (the resolution/assembly leg, before a secret can have been read). The default is
// `NO_SUPPRESSION`, so a call that never resolved a reference pays nothing.
//
// …AND ACROSS CALLS (S8 relay, chunk 37): a resolved secret OUTLIVES its call by design — the plan
// it rode into is read, applied or discarded by LATER calls with fresh, empty registries, and an
// echoing server could hand the value back in any of those responses. So the session (the
// tool-table closure, exactly like the banner cell) remembers plan-id → resolved-secrets when a
// plan-minting call registered any, and every later call that NAMES that plan re-arms its own
// registry from the memory before anything renders (`planSecrets` / `rearmPlanSecrets`).
//
// AUTH IS A GATE, NOT A CRASH (D0-f): every tool but `agkit_status` refuses with `[auth_required]`
// before any wire I/O when the credential chain is degraded. `agkit_status` is the instrument that
// REPORTS that degradation, so it always answers — with a REPORT-mode version fence, for the same
// reason its CLI twin has one: an instrument may not be killed by the thing it measures.
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyCommandSpec, CommandResult, Ctx } from "../commands/types";
import { RegistryError, commandKey, visibleCommands } from "../commands/registry";
import { ConfirmationRequiredError, TerminalPlanError } from "../core/plan/ceremony";
import type { McpToolCall, McpToolTable } from "../mcp";
import { CANONICAL_TOOLS } from "./tool-defs";
import { contractFacts } from "../contract";
import { runEntry, resolveCall, type DispatchEntry } from "./dispatch";
import {
  NO_SUPPRESSION,
  openMcpCall,
  authRequiredDetail,
  type McpCall,
  type McpSession,
  type SuppressedSecrets,
} from "./ctx";
import { displayCapped } from "../core/output/display";
import { redactText } from "../core/output/redaction";
import {
  AUTH_REQUIRED,
  CANCELLED,
  CONFIRM_MISMATCH,
  CONFIRM_REQUIRED,
  MAX_SUMMARY_CHARS,
  PLAN_STALE,
  mcpRefusal,
  mcpSuccess,
  mcpThrown,
  type ResultBody,
} from "./result";

/** The `tools/list` payload: the canonical serializer's OWN objects (D0-c — one source of bytes). */
const TOOLS_PAYLOAD: ListToolsResult = {
  // The compiled defs are structurally the protocol's `Tool` shape (name, description, a
  // `type:"object"` inputSchema, annotations); the cast only tells TypeScript that the JSON-value
  // model in `tool-defs.ts` and the SDK's `Tool` interface describe the same bytes.
  tools: CANONICAL_TOOLS.tools as unknown as ListToolsResult["tools"],
};

/**
 * The `[cancelled]` refusal, with a detail that says HONESTLY how far the call got. INFRA-tier
 * (D0-I): a call the client abandoned is not a consumable domain outcome.
 */
function cancelledRefusal(tool: string, detail: string, suppressed: SuppressedSecrets = NO_SUPPRESSION): CallToolResult {
  return mcpRefusal({ class: CANCELLED, detail, body: { tool } }, suppressed);
}

/**
 * The F6 best-effort probes (plan §2 `agkit_status`). Each names an EXACT registry command; the
 * lookup is fail-closed at module load, exactly like the fixed dispatch bindings, so a probe whose
 * command left the registry is a startup failure and never a silently-null field.
 *
 * These are ENUMERATED session-context reads composed INTO one advertised tool — not a back door
 * into the excluded surface: they are the four facts N-011 APX-E says a session-start snapshot
 * answers, and every one of them is a safe read.
 */
const STATUS_PROBE_COMMANDS = {
  whoami: "whoami get",
  account: "account get",
  killSwitch: "kill-switch status",
} as const;

function requireSpec(command: string, specs: readonly AnyCommandSpec[]): AnyCommandSpec {
  const spec = specs.find((candidate) => commandKey(candidate) === command);
  if (!spec) {
    throw new RegistryError(
      `MCP tools: the status probe command '${command}' is absent from the registry — agkit_status cannot describe the session`,
    );
  }
  return spec;
}

const STATUS_PROBES = ((specs: readonly AnyCommandSpec[]) => ({
  whoami: requireSpec(STATUS_PROBE_COMMANDS.whoami, specs),
  account: requireSpec(STATUS_PROBE_COMMANDS.account, specs),
  killSwitch: requireSpec(STATUS_PROBE_COMMANDS.killSwitch, specs),
}))(visibleCommands());

/**
 * T-227 S4.5 — the once-per-session update-banner cell. SESSION-owned: it lives in
 * `createAgkitToolTable`'s closure, so its lifetime is exactly the tool table's (one MCP session),
 * and two sessions can never share (or race) a cell. `consumed` flips in ONE synchronous step with
 * the check that read it (`withUpdateBanner`) — no await sits between test and set, which is the
 * whole concurrency story a single-threaded runtime needs: of N in-flight first calls, exactly one
 * resolves first, banners, and burns the cell before any other can observe it unburned.
 */
interface UpdateBannerCell {
  consumed: boolean;
}

/**
 * The session's plan-id → resolved-secrets memory (S8 relay, chunk 37). The bound FAILS CLOSED:
 * a secret-bearing mint that would exceed it is refused BEFORE the wire (`callTool`'s plan branch)
 * — the store never evicts, because an evicted plan is still readable/applicable and dropping its
 * secrets would silently reopen the echo hole for exactly that plan (chunk-37 round 2). Entries
 * are likewise KEPT through apply/discard: an APPLIED plan is still readable (`agkit_plan_read`
 * show → the server can echo its history), so forgetting on the terminal outcome would reopen the
 * same hole one call later. The values are this session's own resolved secrets — already resident
 * in this process by necessity — so the memory extends coverage, not exposure. `reserved` counts
 * in-flight intake mints that passed the gate but have not yet settled: the gate tests
 * `plans.size + reserved` and increments in the SAME synchronous step (the update-banner cell's
 * discipline — no await between test and set), so N concurrent intake mints against one free slot
 * admit exactly one; the bound holds under any interleaving, not just the sequential case.
 */
const PLAN_SECRET_CAP = 64;
interface PlanSecretStore {
  readonly plans: Map<string, SuppressedSecrets>;
  reserved: number;
}

/** Build the production-shaped tool table over an injected session seam. */
export function createAgkitToolTable(session: McpSession): McpToolTable {
  const updateBanner: UpdateBannerCell = { consumed: false };
  const planSecrets: PlanSecretStore = { plans: new Map(), reserved: 0 };
  return {
    listTools: () => TOOLS_PAYLOAD,
    callTool: (call) => callTool(session, call, updateBanner, planSecrets),
  };
}

async function callTool(
  session: McpSession,
  request: McpToolCall,
  updateBanner: UpdateBannerCell,
  planSecrets: PlanSecretStore,
): Promise<CallToolResult> {
  // 1. RESOLUTION IS PURE and comes first: an unknown tool, an excluded command, a bad verb, a
  //    mismatched discriminator or a malformed argument is refused with `-32602` before this
  //    server has read a credential, opened a socket, or touched the keychain (test 7).
  const { entry, input } = resolveCall(request.name, request.arguments);

  if (request.signal.aborted) {
    return cancelledRefusal(entry.tool, "the client cancelled this call before it ran; nothing was sent");
  }

  let call: McpCall;
  try {
    // `agkit_status` MEASURES version skew, so it runs a REPORT-mode fence: a major-ahead server
    // must read as DATA on the instrument, never kill it (run.ts `fenceModeFor` precedent).
    // The call's signal rides along (relay chunk-34): the binding threads it into the wire
    // client's fetch, so an in-flight request aborts when the client cancels.
    call = await openMcpCall(session, {
      fence: entry.kind === "status" ? "report" : "throw",
      signal: request.signal,
    });
  } catch (err) {
    // openMcpCall is total; this covers a failure BUILDING the per-call seams (a broken production
    // wiring), which must still be a result rather than a dead session.
    return mcpThrown(err);
  }

  // RE-ARM before ANYTHING renders (S8 relay, chunk 37): if this call NAMES a plan this session
  // resolved a secret into, that secret joins this call's own registry — so a plan.get/apply/
  // discard response that echoes the value back is scrubbed exactly as the minting call's was.
  // A plan this session never minted (or minted without a secret) is a no-op lookup.
  rearmPlanSecrets(planSecrets, input, call);

  // RE-CHECKED after the per-call assembly (relay chunk-34): the credential chain above can take
  // real time (a keychain prompt, the bounded helper), and a cancellation that arrived during it
  // must stop the call HERE — before the auth gate, and before a mutation reaches the wire.
  if (request.signal.aborted) {
    return cancelledRefusal(entry.tool, "the client cancelled this call before it ran; nothing was sent", call.secrets.suppressed());
  }

  try {
    // 2. THE AUTH GATE — before any wire I/O, for every tool but the session instrument.
    if (!call.auth.ok && entry.kind !== "status") {
      return mcpRefusal(
        {
          class: AUTH_REQUIRED,
          detail: authRequiredDetail(call.auth.failure),
          body: { tool: entry.tool, failure: call.auth.failure },
        },
        call.secrets.suppressed(),
      );
    }
    switch (entry.kind) {
      case "apply":
        return await runApplyTool(entry, input, call);
      case "status":
        // The banner attach sits OUTSIDE `runStatusTool`, on its resolved value: a status call
        // that THREW never reaches it (the catch below renders the failure, cell untouched), so a
        // failed call cannot burn the one-shot. Everything after the await is synchronous.
        return withUpdateBanner(await runStatusTool(entry, input, call), updateBanner);
      case "plan": {
        // FAIL CLOSED at the memory's bound (chunk-37 rounds 2–3): the moment `runEntry` returns,
        // the plan EXISTS server-side with the resolved secret in its body — too late to refuse —
        // so a full store refuses the secret-bearing mint HERE, before the reference is even
        // resolved. Evicting an older entry instead would silently reopen the echo hole for a plan
        // that is still readable. The check and the reservation share one synchronous step (no
        // await between them), so concurrent in-flight intake mints cannot slip past a filling
        // bound together. Only intake commands (`mcpSurface.secret`) are gated; every other plan
        // mint registers nothing and passes at any store size.
        const intake = entry.spec.mcpSurface?.secret !== undefined;
        if (intake && planSecrets.plans.size + planSecrets.reserved >= PLAN_SECRET_CAP) {
          return mcpRefusal(
            {
              class: "usage_error",
              detail:
                `this session already holds resolved secrets for ${PLAN_SECRET_CAP} plans — the bound on its ` +
                "suppression memory — and minting another credential plan would outlive what it can scrub. " +
                "The memory holds for this session's whole life (applied and discarded plans stay readable, " +
                "so their secrets stay guarded); start a new MCP session to mint further credential plans. " +
                "Nothing was sent.",
              hint: "every other tool — including agkit_apply and agkit_plan_read on existing plans — still works in this session",
              body: { tool: entry.tool, limit: PLAN_SECRET_CAP },
            },
            call.secrets.suppressed(),
          );
        }
        if (intake) planSecrets.reserved += 1;
        try {
          const minted = await runEntry(entry, input, call, { planOnly: true });
          // The plan now EXISTS server-side carrying this call's resolved secrets (PL-04 custody)
          // — remember them under its id so the later read/apply/discard calls can re-arm.
          rememberPlanSecrets(planSecrets, minted, call.secrets.suppressed());
          return withReplay(minted, call);
        } finally {
          // Runs in the SAME synchronous step as the remember above (`withReplay` is sync), so the
          // slot converts from reservation to entry without a window where either is uncounted.
          if (intake) planSecrets.reserved -= 1;
        }
      }
      case "read":
      case "discard":
        return withReplay(await runEntry(entry, input, call), call);
    }
  } catch (err) {
    // A failure while the call was CANCELLED is the cancellation, labeled by reality: the bound
    // fetch aborts with an AbortError when the signal fires (relay chunk-34), and any other error
    // racing a cancel would produce a result the client has already discarded. The detail is
    // honest about the one thing an abort cannot un-send.
    if (request.signal.aborted) {
      return cancelledRefusal(
        entry.tool,
        "the client cancelled this call in flight; a request already sent may still have reached the server",
        call.secrets.suppressed(),
      );
    }
    // The RESOLVED entry's declared scopes ride along so a `scope_insufficient` refusal that the
    // server did NOT enumerate can still name what this operation needs (labeled `expected_scopes`,
    // never as though the server had said it).
    return mcpThrown(
      err,
      {
        diagnostic: call.seams.diagnostic,
        expectedScopes: entry.spec.scopes.map((scope) => String(scope)),
      },
      call.secrets.suppressed(),
    );
  }
}

/**
 * Surface the invocation's replay fact (plan §2 Replay, cell 1). The wire client records
 * `Idempotency-Replayed: true` into the call's cell; a stored replay means the server did NOT
 * re-execute the write — an honest success, labeled as one. Mirrors `build-cli.runSpec`'s
 * `meta.replayed`, so the CLI and MCP surfaces say the same thing about the same response.
 */
function withReplay(result: CommandResult, call: McpCall): CallToolResult {
  const suppressed = call.secrets.suppressed();
  if (!call.replay.current) return mcpSuccess(result, suppressed);
  return mcpSuccess({ ...result, meta: { ...(result.meta ?? {}), replayed: true } }, suppressed);
}

// ── agkit_apply — the gated executor (F3, D0-h) ──────────────────────────────────────────

/**
 * The apply adapter. It hands the ENGINE `{tty:false, yes:true, confirmProvided: confirm !== undefined}`
 * and translates ONLY what the engine typed:
 *
 *   • `yes:true` is the MCP session's standing consent to the PLAIN y/N gate — an M-class plan
 *     applies (there is no terminal to answer on, and the caller asked for this exact plan by id).
 *     It can NEVER satisfy a typed confirm: `missing_yes` is unreachable from here by construction.
 *   • a D/PR plan with no `confirm` halts → `[confirm_required]`, and the expected value is NOT
 *     disclosed on this leg (the caller reads the plan — `agkit_plan_read` verb `show` — to see it).
 *   • a WRONG `confirm` → `[confirm_mismatch]`, and the expected value is WITHHELD here too
 *     (relay chunk-13, critical): submitting an arbitrary wrong value proves nothing about having
 *     read the plan, so disclosing the answer on mismatch would turn the typed gate into a
 *     two-call bypass — garbage in, challenge out, retry. Both refusal classes point at the same
 *     recovery (`agkit_plan_read`); the engine's TYPED `challenge` field stays on the thrown
 *     object for in-process consumers and is never forwarded over MCP.
 *
 * A LOCALLY-detected terminal plan (already applied / discarded / expired — the
 * `assertPlanApplyable` gate) is `[plan_stale]` from the TYPED `TerminalPlanError.planState`;
 * a server-side stale refusal arrives with the server's own `plan_stale` code. Everything else —
 * a scope refusal, a wire failure — comes back through the shared classification with its own
 * code as the class.
 */
async function runApplyTool(entry: DispatchEntry, input: unknown, call: McpCall): Promise<CallToolResult> {
  try {
    return withReplay(await runEntry(entry, input, call, { yes: true }), call);
  } catch (err) {
    // The two translations render a PLAN — the very document a resolved secret rode into — so both
    // carry the call's suppression view rather than being trusted to be secret-free.
    const suppressed = call.secrets.suppressed();
    if (err instanceof ConfirmationRequiredError) return translateConfirmation(err, suppressed);
    if (err instanceof TerminalPlanError) return translateTerminalPlan(err, suppressed);
    throw err;
  }
}

/** `[plan_stale]` from the TYPED contract — the local gate's cause, never its prose. */
function translateTerminalPlan(err: TerminalPlanError, suppressed: SuppressedSecrets = NO_SUPPRESSION): CallToolResult {
  return mcpThrown(err, { classOverride: PLAN_STALE, body: { plan_state: err.planState } }, suppressed);
}

/** `[confirm_required]` / `[confirm_mismatch]` from the TYPED contract — never from prose. */
function translateConfirmation(
  err: ConfirmationRequiredError,
  suppressed: SuppressedSecrets = NO_SUPPRESSION,
): CallToolResult {
  const mismatch = err.reason === "confirm_mismatch";
  // ONE withheld-challenge descriptor for BOTH refusal classes (relay chunk-13, critical): the
  // engine's typed `challenge.expected` is deliberately NOT read here. Disclosing it on a
  // mismatch would let a caller submit garbage, harvest the answer, and retry — a two-call
  // bypass of the read-the-plan forcing function. The absence is DECLARED, not an omission.
  const body: ResultBody = {
    plan: planSummary(err.extra?.["plan"]),
    challenge: {
      required: true,
      disclosed: false,
      how: "read the plan (agkit_plan_read, verb 'show') to see its confirm string, then call agkit_apply again with `confirm`",
    },
  };
  return mcpThrown(err, { classOverride: mismatch ? CONFIRM_MISMATCH : CONFIRM_REQUIRED, body }, suppressed);
}

/**
 * A CURATED plan summary for a refusal body. Explicitly enumerated, and explicitly WITHOUT
 * `confirm_string`: the embedded plan a halt carries is the whole plan document, and echoing it
 * would hand back the very challenge the `[confirm_required]` leg is withholding.
 */
function planSummary(plan: unknown): ResultBody | null {
  const record = asRecord(plan);
  if (record === null) return null;
  return {
    id: typeof record["id"] === "string" ? record["id"] : null,
    status: typeof record["status"] === "string" ? record["status"] : null,
    danger: typeof record["danger"] === "string" ? record["danger"] : null,
    created_at: typeof record["created_at"] === "string" ? record["created_at"] : null,
    expires_at: typeof record["expires_at"] === "string" ? record["expires_at"] : null,
  };
}

// ── agkit_status — the session aggregate (F6) ────────────────────────────────────────────

/**
 * The status tool: the `status get` handler's OWN document (its local snapshot + the report-path
 * handshake + the pending-plans probe), enriched with the four fields that need an AUTHENTICATED
 * probe. Each probe is best-effort and swallows EVERY failure to null — this tool answers in all
 * five states (authenticated, unauthenticated, no-project, unreachable server, probe failure), and
 * an MCP host that cannot read its session context cannot recover from anything else either.
 */
async function runStatusTool(entry: DispatchEntry, input: unknown, call: McpCall): Promise<CallToolResult> {
  const base = asRecord((await runEntry(entry, input, call)).data) ?? {};
  const authenticated = call.auth.ok;
  const whoami = authenticated ? asRecord(await probe(call.ctx, STATUS_PROBES.whoami)) : null;
  const account = authenticated ? ((await probe(call.ctx, STATUS_PROBES.account)) ?? null) : null;
  const killSwitch = authenticated ? ((await probe(call.ctx, STATUS_PROBES.killSwitch)) ?? null) : null;
  const principal = whoami === null ? null : (asRecord(whoami["principal"]) ?? null);
  const scopes = principal === null ? null : readStringArray(principal["scopes"]);

  // ENUMERATED (F6): every field is named here, so the document's shape is this file's contract
  // and not a passthrough of whatever the base handler happened to return.
  const document = {
    data: {
      authenticated: base["authenticated"] ?? authenticated,
      credential_source: base["credential_source"] ?? null,
      insecure_storage: base["insecure_storage"] ?? null,
      keychain_available: base["keychain_available"] ?? null,
      auth_failure: call.auth.ok ? null : call.auth.failure,
      profile: base["profile"] ?? null,
      profile_source: base["profile_source"] ?? null,
      project: base["project"] ?? null,
      project_source: base["project_source"] ?? null,
      api_url: base["api_url"] ?? null,
      api_url_source: base["api_url_source"] ?? null,
      api_url_guard: base["api_url_guard"] ?? null,
      api_url_host: base["api_url_host"] ?? null,
      config_path: base["config_path"] ?? null,
      config_present: base["config_present"] ?? null,
      cli_version: base["cli_version"] ?? null,
      update_available: base["update_available"] ?? null,
      server_reachable: base["server_reachable"] ?? null,
      management_version: base["management_version"] ?? null,
      // R11: the version this BUILD vendors, beside the one the server advertised. Without both,
      // `version_skew` is a verdict with no operands — an agent (or an operator reading the
      // transcript) cannot tell WHICH side is behind, and the bundled half is never observable
      // from the wire. Read from `contractFacts()`, the byte-pinned bundle import, never a literal.
      bundled_management_version: contractFacts()["management_version"] ?? null,
      version_skew: base["version_skew"] ?? null,
      pending_plans: base["pending_plans"] ?? null,
      pending_plans_truncated: base["pending_plans_truncated"] ?? null,
      principal,
      scopes,
      account,
      kill_switch: killSwitch,
    },
  };
  // The status document is a SESSION report, not a secret carrier — and it still renders through
  // the call's suppression view. Uniformity is the property: no exit on this spine decides for
  // itself whether it is safe (the one call whose document could name a resolved value is a
  // decision made at a distance, in dispatch.ts).
  return mcpSuccess(document, call.secrets.suppressed());
}

/**
 * Run ONE probe command's registry handler, swallowing everything. A probe is a session-context
 * READ: it must never change the tool's outcome, so a 401, a 404 (a project that never engaged its
 * kill switch), an unset project, a transport failure and a malformed body all read as null.
 */
async function probe(ctx: Ctx, spec: AnyCommandSpec): Promise<unknown> {
  try {
    const result = await spec.handler(ctx, spec.args.parse({}));
    return result.data;
  } catch {
    return null;
  }
}

/**
 * T-227 S4.5 — the once-per-session update banner. The FIRST successful `agkit_status` result in a
 * session whose document reports an update gets ONE extra text item; every later status call (and
 * every other tool, which never routes through here) serves the un-bannered shape. Once per
 * session because the banner is operator prose, not data: the FACT stays readable on every call at
 * `data.update_available`, and re-printing the prose each call would train an agent to skip it.
 *
 * ENTIRELY SYNCHRONOUS, and that is the concurrency design, not a convenience: the check and the
 * set share one uninterruptible step below, so N concurrent first calls produce exactly one banner
 * — whichever construction resolves first burns the cell before any other can observe it unburned.
 */
function withUpdateBanner(result: CallToolResult, cell: UpdateBannerCell): CallToolResult {
  // Only a SUCCESS banners. The `isError` KEY (presence, not value — D0-B v2) is the tier fact,
  // and it also covers the two degraded shapes `mcpSuccess` itself can fall to (the
  // `[response_too_large]` refusal, the inert-failure result): both carry the key and bail here
  // with the cell untouched, so a failed construction never burns the one-shot.
  if (Object.prototype.hasOwnProperty.call(result, "isError")) return result;
  // The update fact comes from the DOCUMENT THE CLIENT READS — the served `structuredContent`,
  // i.e. the post-redaction bytes — never re-derived from the stamp file or the wire (§B-11,
  // bytes over claims). A refusal body carries no `data` member, so this read is also what keeps
  // any domain-tier refusal banner-free without a second tier check.
  const envelope = asRecord(result.structuredContent);
  const data = envelope === null ? null : asRecord(envelope["data"]);
  if (data === null) return result;
  const latest = data["update_available"];
  // An absent/null `update_available` returns BEFORE the cell is read: an update-free success
  // must not consume the one-shot — a later status that does report an update still banners.
  if (typeof latest !== "string" || latest.length === 0) return result;
  // THE ATOMIC CONSUME POINT: read + flip with no await between them (none exists anywhere in
  // this function), after the result above was successfully constructed.
  if (cell.consumed) return result;
  cell.consumed = true;
  const current = typeof data["cli_version"] === "string" ? data["cli_version"] : "this build";
  // Static prose + the document's own two version members, through the same redact → escape → cap
  // discipline `result.ts` applies to every summary/hint line (`bounded()`). The versions cannot
  // carry a secret, but the hygiene is a policy of the SURFACE, not a per-site judgement.
  const banner = displayCapped(
    redactText(
      `Update available: agkit ${latest} is newer than ${current}. Update: npm install -g @storybloq/agkit@latest. (Shown once per session; data.update_available carries the same fact on every status call.)`,
    ),
    MAX_SUMMARY_CHARS,
  );
  // PREPENDED, never appended: the canonical machine JSON must stay the LAST content item (the
  // `resultBody` convention every consumer keys on). Only the content ARRAY is rebuilt — the
  // machine text item and `structuredContent` ride through as the same objects `mcpSuccess`
  // produced, so the serialize-once identity (`structuredContent` = JSON.parse of the last item's
  // exact bytes) and the CLI/MCP byte-identity golden are untouched by construction: the banner
  // exists only as a content item, never inside the machine bytes or the structured twin.
  return { ...result, content: [{ type: "text", text: banner }, ...result.content] };
}

/**
 * Remember a freshly-minted plan's resolved secrets under its id. Only a call that actually
 * registered something writes (the common no-secret plan pays a length check), and only a result
 * that actually carries a plan id can be keyed — both read from the bytes at hand, never inferred.
 * NEVER evicts — the pre-wire gate in `callTool`'s plan branch is what holds the bound.
 */
function rememberPlanSecrets(store: PlanSecretStore, minted: CommandResult, suppressed: SuppressedSecrets): void {
  if (suppressed.length === 0) return;
  const id = asRecord(asRecord(minted)?.["data"])?.["id"];
  if (typeof id !== "string" || id.length === 0) return;
  store.plans.set(id, suppressed);
}

/**
 * Re-arm the CURRENT call's registry from the session memory when its input names a remembered
 * plan. Both spellings are read because the fixed tools advertise `plan_id` while the derived
 * `agkit_plan_read` branch advertises the registry's own `id`; an id that names anything else (a
 * project, an issuer) simply misses the map. Registration is idempotent and every stored value
 * already passed the 16-byte floor at its original registration.
 */
function rearmPlanSecrets(store: PlanSecretStore, input: unknown, call: McpCall): void {
  const record = asRecord(input);
  if (record === null) return;
  for (const member of ["plan_id", "id"]) {
    const id = record[member];
    if (typeof id !== "string") continue;
    for (const secret of store.plans.get(id) ?? []) call.secrets.register(secret);
  }
}

// ── narrow readers (no `any`, no trust) ──────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}
