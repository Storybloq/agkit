// L3 MCP server module (T-226 S1) — the stdio server BOOT: an SDK `Server`, the bounded
// stdio transport, and the two tool request handlers, wired to a tool table that is
// INJECTED rather than built here.
//
// WHY THE LOW-LEVEL `Server` AND NOT `McpServer` (ratified D0-b). The sugar API owns tool
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
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createBoundedTransport } from "./mcp/transport";
import { invalidParams, unknownTool } from "./mcp/result";
import { VERSION } from "./version";

/** The MCP server name clients see in `initialize`. Matches the binary, deliberately. */
const SERVER_NAME = "agkit";

/**
 * T-227 R13b — the 5-line micro-skill every client receives in `initialize` (the SDK's
 * `instructions` member, byte-verified at 1.30.0: `ServerOptions.instructions` rides the
 * InitializeResult verbatim and the SDK `Client` surfaces it via `getInstructions()`).
 *
 * WHY IT IS FIVE IMPERATIVE LINES AND NOTHING MORE. `instructions` is the one channel that
 * reaches an agent BEFORE it has called a single tool, so it carries the workflow facts an
 * agent cannot discover from the roster alone: which tool to call first, which calls are
 * free, the plan→show→apply shape of every mutation, where the human-approval line sits, and
 * that a confirm value is READ, never guessed. Each line is a rule the tool table actually
 * enforces (`tools.ts`: the auth gate, the withheld-challenge descriptor, the apply
 * ceremony) — an instruction the server did not back would be a false affordance (§B-2).
 * The interop smoke pins these exact bytes in the initialize result, via import, so a
 * deliberate edit here moves the pin and an accidental drop breaks it.
 */
export const SERVER_INSTRUCTIONS = [
  "Call agkit_status first: it reports auth, project, server reachability and version skew, and it answers in every session state.",
  "Reads are free: agkit_status and every agkit_*_read tool never mutate anything — call them whenever they help.",
  "Mutate in three steps: create a plan (agkit_*_plan), read its diff (agkit_plan_read, verb 'show'), then agkit_apply it by id.",
  "Plans classed D or PR require human approval: stop and get the operator's explicit go-ahead before applying one.",
  "Never guess a confirm value: read the plan (agkit_plan_read, verb 'show') to see its confirm string, then pass it to agkit_apply.",
].join("\n");

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
 * or rejects with an `McpError` for a protocol-level fault such as an unknown tool.
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
 * RELAY-B (T-227 S2, v2) — the DELIBERATELY LAX `tools/call` registration.
 *
 * `Protocol.setRequestHandler` parses the request with the registered schema BEFORE calling the
 * handler (`parseWithCompat(requestSchema, request)`), and a thrown `ZodError` carries no numeric
 * `code`, so `_onrequest`'s rejection path falls back to `ErrorCode.InternalError`. Registered with
 * the SDK's own `CallToolRequestSchema`, a `tools/call` with no `name` therefore came back as
 * **-32603 — "the server had a bug"** for what is plainly the caller's malformed request, and no
 * handler of ours ever ran to say otherwise.
 *
 * So the registration validates only what the SDK needs to ROUTE (the method literal, taken from the
 * SDK's own schema so the two can never drift), leaves `params` opaque, and the handler below owns
 * every shape decision — which is the only place that can answer -32602 (RELAY-B). `params` is
 * `unknown`, never an object schema: an object schema would reject a primitive `params` inside the
 * SDK's parse and put us straight back on the -32603 path.
 */
const LaxCallToolRequestSchema = z.object({
  method: CallToolRequestSchema.shape.method,
  // `.optional()` is LOAD-BEARING and was found by a red cell, not by reading: in Zod 4 a key whose
  // schema merely ACCEPTS `undefined` is still a REQUIRED key, so a bare `z.unknown()` rejected a
  // `tools/call` sent with no `params` at all — inside the SDK's parse, i.e. back on the -32603
  // path this registration exists to leave. The absent case is the handler's to answer.
  params: z.unknown().optional(),
});

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
 * so a client may cache `tools/list` for the life of the session.
 */
export function createMcpServer(options?: CreateMcpServerOptions): Server {
  const tools = options?.tools ?? EMPTY_TOOL_TABLE;
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    // `instructions` rides the initialize result (R13b): the micro-skill reaches the agent in the
    // handshake, before its first `tools/list`. The SDK forwards the string verbatim.
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );

  // `tools/list` keeps the SDK's own schema: it has no params worth owning, so there is no fault to
  // translate and nothing to gain from a laxer parse.
  server.setRequestHandler(ListToolsRequestSchema, () => tools.listTools());
  // NO CAST IS NEEDED, and that was verified rather than assumed: `setRequestHandler<T extends
  // AnyObjectSchema>` infers the handler's `request` through `SchemaOutput<T>`, which for the lax
  // schema is `{method: "tools/call", params?: unknown}` — so `request.params` typechecks as
  // `unknown`, which is exactly the honest type for a value nothing has validated yet.
  server.setRequestHandler(LaxCallToolRequestSchema, (request, extra) => {
    const call = parseToolCall(request.params);
    return tools.callTool({
      name: call.name,
      arguments: call.arguments,
      signal: extra.signal,
    });
  });

  return server;
}

/**
 * T-222 seam: the in-process MCP server entry `agkit mcp serve` hands off to. Resolves on
 * clean server shutdown; MUST write nothing but protocol frames to stdout (diagnostics →
 * stderr).
 *
 * SHUTDOWN IS OURS TO WIRE (SDK seam, byte-verified at 1.30.0). `StdioServerTransport`
 * listens for `'data'` and `'error'` on stdin and nothing else — it does NOT hang up when
 * stdin reaches EOF. For a stdio server the client closing stdin IS the shutdown signal, so
 * this function translates EOF into `transport.close()`, which fires the server's `onclose`
 * and resolves the returned promise. Without it `mcp serve` would never return and would
 * instead depend on the event loop happening to drain — a shutdown by accident.
 */
export async function startMcpServer(options?: StartMcpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  const stdin = options?.stdin ?? process.stdin;
  const transport = createBoundedTransport(stdin, options?.stdout);

  const closed = new Promise<void>((resolve) => {
    // Protocol.connect() routes the transport's close through here, so this covers BOTH a
    // client hangup and the transport failing closed on an oversize frame.
    server.onclose = resolve;
  });

  let hangingUp = false;
  const onHangup = (): void => {
    if (hangingUp) return;
    hangingUp = true;
    // close() resolves synchronously in the SDK and cannot reject; the catch is belt-and-
    // braces so a future SDK change cannot turn shutdown into an unhandled rejection.
    void transport.close().catch(() => {});
  };
  // Both events: `'end'` is EOF on a readable stream; `'close'` covers a DESTROYED stdin
  // (a killed parent) that may never emit `'end'` at all.
  stdin.once("end", onHangup);
  stdin.once("close", onHangup);

  try {
    await server.connect(transport);
    // connect() puts stdin in flowing mode. If it had ALREADY finished before we attached
    // (an empty stdin), neither event will fire again — hang up on the spot rather than
    // waiting for a close that has already happened.
    if (stdin.readableEnded) onHangup();
    await closed;
  } finally {
    stdin.off("end", onHangup);
    stdin.off("close", onHangup);
  }
}
