// T-226 S3b — the PRODUCTION session seams: the one module under `src/mcp/**` that binds the
// server to real process I/O. Everything else in this directory is pure over the injected
// `McpCallSeams`, which is what lets the whole dispatch path be driven in tests over a recording
// fetch and a hermetic runtime.
//
// IT REUSES THE SHELL'S OWN SEAMS ON PURPOSE. `createShellDeps` (cli/run.ts) already owns the
// production credential chain, the effective-context snapshot, the stderr writer and the clock;
// `createShellManagementClient` (cli/wire-client.ts) already owns the guard → credential → typed
// client composition with its retry / refresh / idempotency / version-fence stack. Re-deriving
// either here would be a SECOND credential chain and a SECOND client — two things that could
// disagree with the CLI about which profile a token belongs to. So this file wires, and owns
// nothing.
//
// FRESH PER CALL, DELIBERATELY. `createShellDeps` memoizes the credential read and the context
// snapshot for ONE invocation — which is right for a CLI process and wrong for a server that lives
// for hours. Building a fresh `ShellDeps` per `tools/call` gives each call exactly one credential
// resolution and one context snapshot, and makes a mid-session `agkit login`, an `AGKIT_TOKEN`
// change or a config edit visible to the NEXT call. The RUNTIME (env, home, cwd, the keyring port,
// the stderr sink) is built once and shared — it is a description of the process, not a snapshot of
// its state.
//
// NO SUBPROCESS IS IMPORTED HERE (D0-f): the credential helper's bounded execution rides inside
// `core/auth`, behind the shell's own resolver. The only node built-in this file names is
// `node:crypto`, for the idempotency-key generator the typed client requires.
import { randomUUID } from "node:crypto";
import type { CliRuntime, ManagementClient } from "../commands/types";
import { createShellDeps } from "../cli/run";
import { createShellManagementClient } from "../cli/wire-client";
import { VERSION } from "../version";
import { displayCapped } from "../core/output/display";
import { redactText } from "../core/output/redaction";
import type { McpToolTable } from "../mcp";
import { createAgkitToolTable } from "./tools";
import { bindCallAbort, bindCallSleep, type McpCallSeams, type McpClientBinding, type McpSession } from "./ctx";

/** Bound on ONE stderr diagnostic line. Diagnostics are for an operator tailing the server log. */
const MAX_DIAGNOSTIC_CHARS = 4_096;

/**
 * T-227 R13a — the MCP surface's `X-AgentKit-Client` tag. Built from the SAME `VERSION` source the
 * transport's `cli/<VERSION>` default reads (never a second hardcoded version — one build-injected
 * cell, two surface prefixes), so the server's PLAN_APPLIED audit rows can tell an agent-driven
 * MCP mutation from a human-driven CLI one. Exported so the MCP test harness stamps the IDENTICAL
 * bytes production stamps — a harness-local copy could drift and the pin would prove nothing.
 */
export const MCP_CLIENT_TAG = `mcp-local/${VERSION}`;

/** A real, bounded sleep — the retry engine's backoff seam (run.ts `realSleep` precedent). */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The per-call environment injected into the ONE MCP management-client composition below —
 * exactly the members that legitimately differ between production (`beginCall`) and the hermetic
 * test harness (process-backed vs recorded seams). Everything NOT here is MCP-surface policy and
 * lives inside `createMcpManagementClient` alone.
 */
export interface McpClientEnvironment {
  /** The serve invocation's argv (relay chunk-29): `--profile`/`--project` must reach every call. */
  readonly argv: readonly string[];
  readonly runtime: CliRuntime;
  /** The memoized effective-profile snapshot the credential chain read (A32). */
  readonly effectiveProfile: () => string;
  /** The call's diagnostic sink (redacted/escaped/bounded by the caller). */
  readonly warn: (message: string) => void;
  /** UNBOUND base seams — the composition binds fetch/sleep to the call's signal itself. */
  readonly baseFetch: typeof globalThis.fetch;
  readonly baseSleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly uuid: () => string;
  readonly now: () => number;
}

/**
 * THE one MCP management-client composition (S8 relay fold, chunk 23). Production (`beginCall`)
 * and the MCP test harness both build their client HERE, injecting only the environment members
 * above — so every MCP-surface policy below is exercised by the suites through the production
 * code path rather than restated in a fixture that could drift or keep a deleted line green:
 *
 *   • `clientTag: MCP_CLIENT_TAG` (T-227 R13a) — the ONE production line that distinguishes the
 *     surfaces on the wire: every management request an MCP tool call issues is tagged
 *     `mcp-local/<VERSION>` instead of the transport's `cli/<VERSION>` default, and the server
 *     audits the tag into PLAN_APPLIED rows. Because the harness routes through this function,
 *     deleting this line reddens the client-tag pin — it covers the threading, not just the value.
 *   • `confirm: async () => false` — there is no interactive channel behind a stdio server: the
 *     API-URL guard can never be answered, so it declines and an unconfirmed non-default api_url
 *     stays a refusal.
 *   • `bindCallAbort` / `bindCallSleep` (relay chunk-34): the call's cancellation signal rides
 *     every wire request AND the retry engine's backoff — when the MCP client cancels, an
 *     in-flight fetch aborts, and an abort-blind sleep cannot re-send after the cancellation.
 *   • The bearer comes from the CALL's credential memo — one resolution serves the auth verdict,
 *     `ctx.credential` and the wire client (the A32 single-identity discipline).
 */
export function createMcpManagementClient(env: McpClientEnvironment, binding: McpClientBinding): ManagementClient {
  return createShellManagementClient({
    // The caller's OWN invocation argv (relay chunk-29): the URL guard's context resolution reads
    // `deps.argv` independently, and an argv that differs from the credential chain's would split
    // the guard's profile from it — exactly the A32 divergence this file's header forbids.
    argv: [...env.argv],
    clientFlags: {},
    runtime: env.runtime,
    fenceMode: binding.fence,
    resolveCredential: binding.resolveCredential,
    effectiveProfile: env.effectiveProfile,
    confirm: async () => false,
    warn: env.warn,
    hintCell: { current: null },
    replayCell: binding.replayCell,
    clientTag: MCP_CLIENT_TAG,
    seams: {
      fetch: bindCallAbort(env.baseFetch, binding.signal),
      sleep: bindCallSleep(env.baseSleep, binding.signal),
      random: env.random,
      uuid: env.uuid,
      now: env.now,
    },
  });
}

/**
 * The production session. The runtime is captured once; every call gets its own credential memo,
 * context snapshot, replay cell and client.
 *
 * `contextArgv` is the SERVE INVOCATION's argv (relay chunk-29, critical): the takeover dispatcher
 * deliberately accepts `--profile`/`--project` on `agkit mcp serve` with the documented contract
 * that "the MCP server consumes context per tool call" — so those tokens must reach EVERY per-call
 * context resolution here, or an operator's selected profile/project is accepted and then silently
 * dropped (an honor-or-reject violation that targets mutations at the wrong project). Defaulted to
 * the live process argv because this module is the one sanctioned process-I/O binding; tests inject
 * their own.
 */
export function productionMcpSession(contextArgv: readonly string[] = process.argv.slice(2)): McpSession {
  // One `ShellDeps` build purely to obtain the process-backed runtime (env / homeDir / cwd / the
  // lazy native keyring port / stdin-TTY / the stderr writer). It is never used to RESOLVE
  // anything: each call builds its own deps over this same runtime.
  const runtime = createShellDeps().runtime ?? emptyRuntime();
  return { beginCall: () => beginCall(runtime, contextArgv) };
}

/** The production tool table — what `mcp serve` hands to the protocol shell. */
export function productionMcpToolTable(contextArgv: readonly string[] = process.argv.slice(2)): McpToolTable {
  return createAgkitToolTable(productionMcpSession(contextArgv));
}

function beginCall(runtime: CliRuntime, contextArgv: readonly string[]): McpCallSeams {
  // A FRESH shell-deps per call: fresh credential memo, fresh effective-context snapshot — resolved
  // over the SERVE INVOCATION's argv, so the operator's `--profile`/`--project` selectors hold for
  // the whole session while env/config edits underneath them stay visible to the NEXT call (the
  // flag layer only pins what the operator explicitly pinned; every lower layer re-reads fresh).
  const deps = createShellDeps({ runtime }, contextArgv);
  const warn = deps.warn;
  // The stderr sink for THIS call: redacted, control-escaped and bounded before a byte is written,
  // so the ceremony's plan render and our own internal-error diagnostics ride the same policy the
  // wire results do. Best-effort by contract — a broken stderr can never fail a tool call.
  const diagnostic = (text: string): void => {
    try {
      warn(displayCapped(redactText(text), MAX_DIAGNOSTIC_CHARS));
    } catch {
      /* diagnostics are best-effort — never let one break a call */
    }
  };
  const now = deps.now ?? ((): number => Date.now());
  const effectiveProfile = deps.effectiveProfile ?? ((): string => "default");

  return {
    runtime,
    resolveCredential: deps.resolveCredential,
    createClient: (binding: McpClientBinding) =>
      // The SHARED production composition (see its header for the policy it owns). The argv is the
      // SAME invocation argv as the deps above (relay chunk-29) — an empty argv here would split
      // the guard's profile from the credential chain's.
      createMcpManagementClient(
        {
          argv: contextArgv,
          runtime,
          effectiveProfile,
          warn: diagnostic,
          baseFetch: globalThis.fetch,
          baseSleep: realSleep,
          random: Math.random,
          uuid: () => randomUUID(),
          now,
        },
        binding,
      ),
    diagnostic,
    now,
    effectiveContext: () => {
      const read = deps.effectiveContext;
      if (!read) throw new Error("agkit mcp: internal — the shell deps carry no effective-context reader");
      return read();
    },
  };
}

/** Unreachable in production (`createShellDeps` always supplies a runtime); total by contract. */
function emptyRuntime(): CliRuntime {
  throw new Error("agkit mcp: internal — the shell deps supplied no runtime seam");
}
