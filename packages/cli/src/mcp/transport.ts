// The BOUNDED stdio transport — a thin COMPOSITION factory over the SDK's own
// `StdioServerTransport` (T-226, ratified R2-F5). There is deliberately NO subclass here.
//
// WHY A FACTORY AND NOT JUST AN INLINE `new`. The frame caps are security invariants (an unbounded
// stdin is a memory-exhaustion channel into a process that holds the operator's credential; an
// unbounded stdout is the same channel pointed at the client), and an invariant that is spelled out
// at each call site is an invariant with one silently-wrong copy in its future. This file is the ONE
// place every bound is named; `mcp.ts` never constructs a transport itself.
//
// ── WHAT T-227 S2 ADDED: TWO COMPOSED STREAMS, STILL NO SUBCLASS ─────────────────────────────────
// SDK 1.30.0 takes `_stdin` and `_stdout` as constructor parameters, so both bounds land as STREAM
// COMPOSITION around the transport rather than as overrides inside it:
//
//     real stdin ──▶ InboundFrameGuard ──▶ [ StdioServerTransport ] ──▶ BoundedFrameWriter ──▶ real stdout
//                    (frame-guard.ts)                                   (outbound-guard.ts)
//
//   • INBOUND (RELAY-A, v3-1, v4-4): validates raw bytes BEFORE the SDK sees them — a malformed
//     line gets a bounded static -32700/-32600 instead of the SDK's silence, and the 1 MiB
//     accumulation cap MOVES here because this stream is the one that buffers first.
//   • OUTBOUND (v6-1, v7-1): measures the FINAL serialized frame against a 768 KiB budget, with a
//     deterministic emergency answer for an oversized response.
//
// Each guard's fail-closed hook is wired to `transport.close()` below, which is why they are built
// here and not inside either module: only this function knows the transport they belong to.
//
// WHY NO SUBCLASS. SDK 1.30.0 already implements every behavior we would otherwise have written,
// byte-verified against `dist/esm/server/stdio.js` + `dist/esm/shared/stdio.js` at the pinned
// version. All three are LOAD-BEARING for us, so `bounded-transport.test.ts` pins each one directly
// — an SDK upgrade that drops any of them reddens the suite instead of quietly removing our bound:
//
//   1. THE CAP IS ON BUFFERED BYTES, NOT ON COMPLETED LINES. `ReadBuffer.append`
//      compares `(buffered + chunk.length)` against `maxBufferSize` BEFORE concatenating,
//      so an attacker cannot evade the cap by simply never sending a `\n` — the bound trips on
//      accumulation, which is the only version of this check that actually bounds memory. Our
//      inbound guard now owns the FIRST copy of exactly that check (v4-4); `maxBufferSize` is still
//      passed to the SDK as belt and braces, so an upgrade that drops it still reddens.
//   2. AN OVERSIZE READ FAILS CLOSED. `append`'s throw lands in `_ondata`'s catch, which
//      calls `onerror` AND `close()`. A transport that reported the error and kept
//      reading would leave a desynchronized byte stream feeding the JSON-RPC framer;
//      hanging up is the honest outcome. The inbound guard reproduces both halves.
//   3. `send()` AWAITS `'drain'`. When stdout's buffer is full `write()` returns false
//      and the SDK resolves the send only on the subsequent `'drain'`, so a slow reader
//      applies backpressure rather than growing an unbounded write queue in our process. The
//      bounded writer preserves this (see its `highWaterMark: 1` note).
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInboundGuard } from "./frame-guard";
import { BoundedFrameWriter } from "./outbound-guard";

/**
 * The maximum number of bytes that may sit UNCONSUMED in the read buffer — i.e. the
 * largest single JSON-RPC frame the server will accept (a frame is only consumed once
 * its terminating newline arrives, so an unterminated line is bounded by the same
 * number). 1 MiB: comfortably above any real management-plane call — the biggest
 * arguments this server accepts are identifiers, a confirm string and small config
 * objects — and far below a size that could pressure the process. The SDK's own default
 * is 10 MiB (`STDIO_DEFAULT_MAX_BUFFER_SIZE`); we deliberately take a tighter bound.
 */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * The ratified 768 KiB budget on ONE outbound frame, whole and serialized (v6-1). Under the 1 MiB
 * inbound cap on purpose: a peer that mirrors our own limits back at us must be able to accept
 * everything we send, and the 256 KiB of headroom absorbs JSON escaping and fencing growth that a
 * body-level bound (`result.ts`'s `MAX_BODY_BYTES`) cannot see from where it sits.
 */
export const MAX_OUTBOUND_FRAME_BYTES = 768 * 1024;

/**
 * The ratified 4 KiB cap on a SERIALIZED request id (v6-1). Two jobs: an id is echoed on every
 * response and on the inbound validator's -32600, so an unbounded one is an amplification channel;
 * and bounding it is what makes v7-1's emergency frame provably small BEFORE it is built. An id
 * over the cap is answered with a static -32600 and `id:null` — the oversized id is never echoed.
 */
export const MAX_REQUEST_ID_BYTES = 4096;

export interface BoundedTransportOptions {
  /**
   * The sink for the guards' fail-closed diagnostics. Production writes to stderr (stdout belongs
   * to the protocol); tests inject a recorder. Best-effort by contract — it may throw, and the
   * guards treat a throw as nothing more than a lost diagnostic.
   */
  readonly diagnostic?: (text: string) => void;
}

/** The production diagnostic sink: stderr, never stdout, and never fatal to the hangup it reports. */
function stderrDiagnostic(text: string): void {
  process.stderr.write(text);
}

/**
 * Build the server's stdio transport with every frame bound applied. `stdin`/`stdout` are
 * injectable ONLY so tests can drive a real transport over paired in-memory streams;
 * production passes neither and we default to `process.stdin` / `process.stdout` — the same
 * defaults the SDK would have applied, resolved here because the guards need the real streams to
 * compose around.
 *
 * The caller owns the lifecycle (`start()` happens inside `Server.connect()`, and stdin
 * EOF → `close()` is wired in `mcp.ts`): this function names the bounds and wires the seams.
 */
export function createBoundedTransport(
  stdin?: Readable,
  stdout?: Writable,
  options?: BoundedTransportOptions,
): StdioServerTransport {
  const source = stdin ?? process.stdin;
  const sink = stdout ?? process.stdout;
  const diagnostic = options?.diagnostic ?? stderrDiagnostic;

  const outbound = new BoundedFrameWriter({
    stdout: sink,
    maxFrameBytes: MAX_OUTBOUND_FRAME_BYTES,
    maxIdBytes: MAX_REQUEST_ID_BYTES,
    diagnostic,
  });
  const inbound = createInboundGuard({
    maxFrameBytes: MAX_FRAME_BYTES,
    maxIdBytes: MAX_REQUEST_ID_BYTES,
    // The validator's own frames ride the bounded writer, so they are measured by the same budget
    // as every other frame class (v6-1) and inherit its backpressure.
    sendFrame: (frame) => outbound.sendFrame(frame),
  });

  const transport = new StdioServerTransport(inbound, outbound, { maxBufferSize: MAX_FRAME_BYTES });

  // close() resolves synchronously in the SDK and cannot reject; the catch is belt-and-braces so a
  // future SDK change cannot turn a hangup into an unhandled rejection.
  const hangUp = (): void => {
    void transport.close().catch(() => {});
  };
  // The inbound trip keeps T-226's exact observable shape — `onerror` AND `close()` — so a cap
  // breach still looks the same to the server that reads it, only with our seam's message.
  inbound.onFatal = (error) => {
    transport.onerror?.(error);
    hangUp();
  };
  outbound.onFatal = hangUp;
  // `pipe` does not forward errors, and the SDK's own `'error'` listener now sits on the GUARD
  // rather than on the real stdin. Forward the real stream's faults to the same place the SDK would
  // have reported them, so a broken stdin is still visible rather than an unhandled `'error'`.
  source.on("error", (error: Error) => transport.onerror?.(error));
  source.pipe(inbound);

  return transport;
}
