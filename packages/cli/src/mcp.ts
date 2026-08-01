// L3 MCP server module (T-226 S1) — the stdio server BOOT: an SDK `Server`, the bounded
// stdio transport, and the two tool request handlers, wired to a tool table that is
// INJECTED rather than built here.
//
// WHY THE LOW-LEVEL `Server` AND NOT `McpServer` (ratified D0-b, and it SURVIVES the SDK v2
// migration — v2 keeps both the class and `setRequestHandler`). The sugar API owns tool
// registration, so the `tools/list` payload would be ITS serialization of our schemas. Our
// tool defs are byte-locked against a golden and derived from the CommandSpec registry, so
// the bytes on the wire must be OUR canonical serializer's output — which means we keep
// `setRequestHandler` and hand the SDK a finished payload. The SDK keeps everything that is
// genuinely protocol: framing, the lifecycle state machine, version negotiation,
// initialize/initialized, notification semantics (a notification NEVER gets a response) and
// unknown-method errors. We do not re-implement any of it, and the interop smoke drives the
// server through BOTH a hand-scripted stdio session and the SDK's own `Client` so that
// locally-authored request shapes are not our only oracle (R2-F6).
//
// WHO OWNS THE ERA (T-300). This file no longer decides which protocol revision a connection
// speaks. `serveStdio` does: it reads the opening exchange, pins the connection to ONE era
// (legacy `initialize` or modern `server/discover`), and serves everything after it from ONE
// instance built by the FACTORY we hand it. `legacy: "serve"` is not a default we inherited —
// it is ratified, because every host that drives this binary today is legacy-only, and
// `"reject"` is FORBIDDEN. `server/discover` is likewise NOT ours to register: the SDK derives
// it from the `Server`'s own options and silently clobbers a hand-registered one.
//
// WHY THE TOOL TABLE IS INJECTED. `createMcpServer()` is the boot seam and nothing more: it
// knows how to speak MCP, not what `agkit` exposes. The roster (derived tool defs + the
// canonical serializer) and dispatch (allowlist → branch validation → the one registry
// adapter) land in `src/mcp/tool-defs.ts` and `src/mcp/dispatch.ts` and are handed in. That
// keeps this file free of any path from a tool NAME to a wire call, and it is why the
// default table below is an EMPTY roster rather than a stub of the real one — a placeholder
// that guessed at tool names would be a second, unlockable source of truth.
//
// STDOUT BELONGS TO THE PROTOCOL. `mcp serve` is the CLI's one stdout-takeover command: from
// the moment this module runs, the ONLY bytes on stdout are JSON-RPC frames written by the
// transport. Nothing here logs, prints, or renders — diagnostics go to stderr, and they go
// there through the single redaction chokepoint (`toMcpResult`, S3), never via a bare write.
// The ONE exception is `serveDiagnostic` below, and it is an exception only in the plumbing: it
// carries a FIXED VOCABULARY — an allowlisted error class name and nothing else — so there is no
// attacker-controlled byte in it for a redactor to have anything to do.
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { Server, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBoundedTransport } from "./mcp/transport";
import { invalidParams, unknownTool } from "./mcp/result";
import { MCP_CACHE_HINTS, SERVER_NAME } from "./mcp/eras";
import { WORKFLOW_CONTRACT } from "./workflow-contract";
import { VERSION } from "./version";

/**
 * T-227 R13b — the 5-line micro-skill carried in the opening exchange (the SDK's `instructions`
 * member). T-300 byte-verified at v2: ONE `ServerOptions.instructions` field rides BOTH eras'
 * openings — the legacy `InitializeResult` and the modern `DiscoverResult` — from the same string,
 * so there is no per-era instructions hook here. T-300 R6 moved the LINES themselves out to
 * `./workflow-contract`: this is a JOIN of that one array, not a second authoring site.
 *
 * WHY IT IS FIVE IMPERATIVE LINES AND NOTHING MORE. They carry the workflow facts an agent cannot
 * discover from the roster alone: which tool to call first, which calls are free, the
 * plan→show→apply shape of every mutation, where the human-approval line sits, and that a confirm
 * value is READ, never guessed. Each line is a rule the tool table actually enforces (`tools.ts`:
 * the auth gate, the withheld-challenge descriptor, the apply ceremony) — an instruction the server
 * did not back would be a false affordance (§B-2).
 *
 * WHY THERE IS A SECOND CARRIER (T-300 R6). On the legacy era `instructions` rode `initialize`,
 * which every client must send. On the modern era it rides `DiscoverResult`, and a client MAY skip
 * `server/discover` entirely — so `instructions` no longer guarantees delivery before an agent's
 * first tool call, and nothing here claims it does. The status document's `workflow` field
 * (`core/config/status.ts`, from the same array) is the second carrier: skip-proof for any client
 * that follows LINE 1 of the contract — "Call `agkit_status` first" — whichever era it speaks and
 * whether or not it read the opening exchange. That is a weaker guarantee than the 2025 one, and
 * the honest one: we recommend the first call, we do not gate on it.
 *
 * The interop smoke pins these exact bytes in the opening exchange, via import, so a deliberate
 * edit moves the pin and an accidental drop breaks it.
 */
export const SERVER_INSTRUCTIONS = WORKFLOW_CONTRACT.join("\n");

/** A `tools/call` request, narrowed to what a tool implementation may see. */
export interface McpToolCall {
  /** The requested tool name — UNTRUSTED input; the table decides whether it exists. */
  readonly name: string;
  /** The raw `arguments` object, still unvalidated (the table owns branch validation). */
  readonly arguments?: Record<string, unknown>;
  /** Aborted when the client cancels the call or the connection closes. */
  readonly signal: AbortSignal;
}

/**
 * The seam between the protocol shell (this file) and the `agkit` roster (S2/S3). Both
 * halves are total: `listTools` returns the finished `tools/list` payload, and `callTool`
 * either resolves a `CallToolResult` (including the `isError: true` domain-failure shape)
 * or rejects with a `ProtocolError` for a protocol-level fault such as an unknown tool.
 */
export interface McpToolTable {
  listTools(): ListToolsResult;
  callTool(call: McpToolCall): Promise<CallToolResult>;
}

export interface CreateMcpServerOptions {
  /** Overrides the empty default roster. S2/S3 pass the real, registry-derived table. */
  readonly tools?: McpToolTable;
}

export interface StartMcpServerOptions extends CreateMcpServerOptions {
  /** Test-only stream injection; production passes neither (process.stdin/stdout). */
  readonly stdin?: Readable;
  readonly stdout?: Writable;
}

/**
 * The default roster: EMPTY, and every call is an unknown tool. Not a mock — this is the
 * honest description of a server whose roster has not been supplied, and it is what makes
 * "the shell never invents a tool" checkable. Its unknown-tool error is the ONE
 * `unknownTool` constructor the production table also throws (relay chunk-09 finding): the
 * name is attacker-controlled and unbounded on the wire, so every echo of it goes through
 * the same redact-then-cap hygiene — a bare truncation here would be a second, weaker
 * policy that reproduced secret-shaped names verbatim.
 */
const EMPTY_TOOL_TABLE: McpToolTable = {
  listTools: () => ({ tools: [] }),
  callTool: ({ name }): never => {
    throw unknownTool(name);
  },
};

/**
 * RELAY-B v2 (T-300) — the DELIBERATELY LAX `tools/list` params schema.
 *
 * The hazard RELAY-B was built for is NOT gone in SDK v2; it MOVED. `tools/call` is now
 * special-cased by the SDK (`Server._wrapHandler` validates the request against the era codec and
 * authors a correct **-32602** on both eras), so the lax `tools/call` registration is dead and its
 * schema is deleted. `tools/list` is not special-cased: registered by METHOD STRING alone, its
 * params parse happens inside the SDK's stored handler, where the thrown value is a plain `Error`
 * with no numeric `code` — so a `cursor: 12345` came back as **-32603, "the server had a bug"**,
 * for what is plainly the caller's malformed request (live-verified on BOTH eras).
 *
 * The 3-arg Standard-Schema registration takes the other branch, which throws
 * `ProtocolError(InvalidParams)` = -32602. The schema below is DELIBERATELY LAX — it accepts `{}`,
 * `{_meta}` and `{cursor: anything}` — so the shape decision and its static message stay OURS,
 * which is exactly the RELAY-B discipline: the SDK routes, we answer.
 */
const LaxToolsListParams = z.looseObject({});

/** A `tools/call` whose `params` satisfied every shape rule below. */
interface ParsedToolCall {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

/** A plain JSON object — the shape `params`, `arguments` and `_meta` must each take. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * RELAY-B's translation: EVERY `tools/call` params-shape fault → a PROTOCOL -32602, never a tool
 * result. The distinction is the caller's whole basis for retrying: a protocol error means the call
 * did not happen, and an `isError` result would tell them the tool ran and failed.
 *
 * Every message is STATIC. `params` is attacker-controlled and can carry a secret (a mistyped
 * credential in an argument, a pasted token in a name), so no fault echoes the value that caused it
 * — the caller is told which MEMBER is wrong, never what they sent. `invalidParams` is the shared
 * constructor (redact → escape → cap), so these ride the identical hygiene as every other echo.
 *
 * Shapes the ENVELOPE schema already refused never arrive here: `JSONRPCRequestSchema` requires
 * `params` to be an object with an object-shaped `_meta`, so a primitive/null `params` or a
 * malformed `_meta` is rejected one layer earlier as a -32600 by the inbound frame guard (v3-1).
 * The checks below are still total — the guarantee this function makes must not depend on which
 * transport delivered the request.
 */
function parseToolCall(params: unknown): ParsedToolCall {
  if (params === undefined) {
    throw invalidParams("tools/call requires a params object with a tool name");
  }
  if (!isPlainObject(params)) {
    throw invalidParams("tools/call params must be an object");
  }
  const name = params["name"];
  if (typeof name !== "string") {
    throw invalidParams("tools/call params.name must be a string naming a tool");
  }
  if (name.length === 0) {
    throw invalidParams("tools/call params.name must not be empty");
  }
  const args = params["arguments"];
  if (args !== undefined && !isPlainObject(args)) {
    throw invalidParams("tools/call params.arguments must be an object when present");
  }
  const meta = params["_meta"];
  if (meta !== undefined && !isPlainObject(meta)) {
    throw invalidParams("tools/call params._meta must be an object when present");
  }
  return args === undefined ? { name } : { name, arguments: args };
}

/**
 * Build the configured MCP server. Advertises `tools` with `listChanged: false` — the
 * roster is fixed at boot and this server NEVER emits `notifications/tools/list_changed`,
 * so a client may cache `tools/list` for the life of the session (and `cacheHints` below says
 * so on the wire, on the one era that has a place to say it).
 *
 * THIS IS A FACTORY, AND IT IS CALLED MORE THAN ONCE PER PROCESS (T-300 D1). `serveStdio` builds
 * up to TWO instances for a single connection — a modern probe instance, discarded if the client
 * turns out to be legacy, and then the pinned instance — because a `Server` can be connected only
 * once. That is safe here, and the reason is worth writing down: the per-SESSION cells (the
 * once-per-session update banner, the plan-secret custody memory) live in the TOOL TABLE's closure,
 * and the table is injected once per PROCESS. "Once per session" for those means once per stdio
 * process — one operator session — which sharing the table preserves EXACTLY. The discarded probe
 * instance never executes a tool call (in the probe phase only the SDK's own `server/discover` and
 * notifications are delivered), and the two instances never run concurrently. What must NOT be
 * introduced is module-scope session state: that would be shared across processes, not merely
 * across instances, and no amount of factory discipline would save it.
 */
export function createMcpServer(options?: CreateMcpServerOptions): Server {
  const tools = options?.tools ?? EMPTY_TOOL_TABLE;
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      // `instructions` rides the opening exchange of BOTH eras (R13b): the micro-skill reaches the
      // agent before its first `tools/list`. The SDK forwards the string verbatim to the legacy
      // `InitializeResult` and to the modern `DiscoverResult` from this one field.
      instructions: SERVER_INSTRUCTIONS,
      // The SDK's default is `ttlMs: 0, cacheScope: "private"` — the WORST policy for a roster that
      // is a property of the build. Ours is stated once, in `mcp/eras.ts`, and validated here at
      // construction (an invalid hint is a `RangeError` at boot, never a wrong byte on the wire).
      cacheHints: MCP_CACHE_HINTS,
    },
  );

  // `tools/list` — the 3-arg lax form, for the RELAY-B reason spelled out at `LaxToolsListParams`.
  // A well-formed string cursor is ACCEPTED AND IGNORED: this server does not paginate, and that
  // has always been its answer. The 3-arg handler is always handed an object (`{...params}`), so
  // the only fault left to own is the cursor's type.
  server.setRequestHandler("tools/list", { params: LaxToolsListParams }, (params): ListToolsResult => {
    const cursor = (params as Record<string, unknown>)["cursor"];
    if (cursor !== undefined && typeof cursor !== "string") {
      throw invalidParams("tools/list params.cursor must be a string when present");
    }
    return tools.listTools();
  });
  // `tools/call` — the 2-arg method-string form. The SDK validates the request against the era
  // codec BEFORE this runs and authors its own -32602 on a shape fault, on both eras, so the lax
  // registration that used to be here has nothing left to buy. `parseToolCall` STAYS: it is the
  // owner of the empty-name refusal (which the SDK schema permits), and its static messages are
  // still the wire text for every fault that reaches it — belt and braces over validated params.
  server.setRequestHandler("tools/call", (request, ctx) => {
    const call = parseToolCall(request.params);
    return tools.callTool({
      name: call.name,
      arguments: call.arguments,
      signal: ctx.mcpReq.signal,
    });
  });

  return server;
}

/**
 * The ONLY error class names this process will name on stderr (T-300 A-II.3). A FINITE VALUE
 * allowlist, not a character filter: `error.name` is writable, so a request-shaped string — a
 * pasted token, a mistyped credential — can be sitting in it, and a pattern that merely LOOKS
 * syntactic (`/^[A-Za-z0-9_.-]+$/`) would wave exactly that through. Anything not on this list is
 * reported as `Error`, which loses nothing an operator can act on.
 */
const DIAG_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ProtocolError", "SdkError"]);

/**
 * The serving entry's out-of-band error sink. FIXED VOCABULARY: one line, an allowlisted class
 * name, and nothing else. NO `error.message` byte ever reaches stderr here — the entry reports
 * faults raised while handling arbitrary inbound frames, so the message can carry request bytes,
 * and the ONE place in this process allowed to echo attacker-controlled input is the redaction
 * chokepoint in `result.ts`, which this seam does not go through. Best-effort by contract: a
 * failing stderr is a lost diagnostic, never a failed shutdown.
 */
function serveDiagnostic(error: Error): void {
  try {
    const name = DIAG_ERROR_NAMES.has(error?.name ?? "") ? error.name : "Error";
    process.stderr.write(`agkit mcp: transport error [${name}]\n`);
  } catch {
    // A diagnostic that cannot be written is dropped. It must never become the failure.
  }
}

/**
 * T-222 seam: the in-process MCP server entry `agkit mcp serve` hands off to. Resolves on
 * clean server shutdown; MUST write nothing but protocol frames to stdout (diagnostics →
 * stderr).
 *
 * WHO OWNS WHAT (T-300 D1). `serveStdio` owns the transport: it STARTS it, receives every inbound
 * message, assigns `onmessage`/`onerror`/`onclose` on it, and closes it when the connection ends.
 * So this function must NEVER read or assign `transport.onclose` after handing it over — that
 * would clobber the entry's instance-teardown path.
 *
 * SHUTDOWN IS STILL OURS TO SIGNAL (SDK seam, byte-verified at v2). `StdioServerTransport` listens
 * for `'data'` and `'error'` on stdin and nothing else — it does NOT hang up when stdin reaches
 * EOF. For a stdio server the client closing stdin IS the shutdown signal, so EOF is translated
 * into a transport close here. The close SIGNAL comes back through the close-signal latch that
 * `createBoundedTransport` wires in AT CONSTRUCTION — it hands back the wrapped transport and its
 * `closed` promise as one pair — rather than through an `onclose` we own, which is what makes it
 * TOTAL: our EOF close, a fatal guard trip (oversize frame in or out), an EPIPE on stdout, the SDK
 * tearing the instance down, a factory that throws — every one of them closes the transport, and
 * every close resolves the latch. Composing the latch INSIDE the factory is load-bearing: the
 * guards' own fatal hangup is wired to the wrapped `close()` there, so the one close path this
 * function never initiates is latched exactly like the ones it does. Without it `mcp serve` would
 * never return and would instead depend on the event loop happening to drain — a shutdown by
 * accident.
 */
export async function startMcpServer(options?: StartMcpServerOptions): Promise<void> {
  const stdin = options?.stdin ?? process.stdin;
  const { transport, closed } = createBoundedTransport(stdin, options?.stdout);
  const handle = serveStdio(() => createMcpServer(options), {
    // FORBIDDEN: `"reject"`. Every host that drives this binary today opens with `initialize`.
    legacy: "serve",
    transport,
    onerror: serveDiagnostic,
  });

  const onHangup = (): void => {
    // The latch settles in the wrapper's `finally`, so a rejecting close still ends the wait; the
    // catch keeps a failed teardown from becoming an unhandled rejection on the way there.
    void transport.close().catch(() => {});
  };
  // Both events: `'end'` is EOF on a readable stream; `'close'` covers a DESTROYED stdin
  // (a killed parent) that may never emit `'end'` at all.
  stdin.once("end", onHangup);
  stdin.once("close", onHangup);

  try {
    // `serveStdio` starts the transport synchronously, which puts stdin in flowing mode. If it had
    // ALREADY finished before we attached (an empty stdin), neither event will fire again — hang up
    // on the spot rather than waiting for a close that has already happened.
    if (stdin.readableEnded) onHangup();
    await closed;
  } finally {
    stdin.off("end", onHangup);
    stdin.off("close", onHangup);
    // Idempotent against an already-closed wire (the entry guards on its own `closing`/`closed`
    // state), and the one call that tears down a still-live instance when the latch was tripped by
    // something other than the entry itself.
    await handle.close();
  }
}
