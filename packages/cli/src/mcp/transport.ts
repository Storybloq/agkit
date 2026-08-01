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
// The SDK takes `_stdin` and `_stdout` as constructor parameters, so both bounds land as STREAM
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
// Each guard's fail-closed hook is wired to the close-signalled transport's `close()` below, which
// is why they are built here and not inside either module: only this function knows the transport
// they belong to.
//
// WHY NO SUBCLASS. The SDK already implements every behavior we would otherwise have written,
// byte-verified against `@modelcontextprotocol/server@2.0.0`'s `dist/stdio.mjs` (and, before
// T-300, against SDK 1.30.0's `dist/esm/server/stdio.js` — the constructor, the 10 MiB default and
// all three behaviors below are IDENTICAL across the two majors, which is why the compose chain
// moved verbatim). All three are LOAD-BEARING for us, so `bounded-transport.test.ts` pins each one
// directly — an SDK upgrade that drops any of them reddens the suite instead of quietly removing
// our bound:
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
//
// ── WHAT T-300 ADDED: THE SDK v2 SWAP AND THE ONE TRANSPORT-OBJECT DECORATOR ──────────────────────
// TWO v2 DELTAS worth naming, neither of which touches the composition above: `close()` now PAUSES
// the stdin stream when it removes the last `'data'` listener, and `send()` REJECTS once closed
// (1.30.0 resolved). Both are strictly tighter than what we relied on, and the guards' fail-closed
// hooks already treat a hangup as terminal.
//
// THE DECORATOR RULE (D1). Everything above wraps the STREAMS, so the object handed to the SDK is
// the SDK's own `StdioServerTransport` and no `Transport` member can be dropped by us. That changes
// for `withCloseSignal` below, which wraps the transport OBJECT: any such wrapper MUST forward
// EVERY optional `Transport` member — `setSupportedProtocolVersions`, `setProtocolVersion`,
// `sessionId`, `hasPerRequestStream` — and must forward `onmessage`/`onerror` as ACCESSORS, because
// the serving entry assigns those on the object it is handed. A wrapper that silently swallowed
// `onmessage` would leave both eras hanging with no type error to show for it.
//
// COMPOSITION ORDER IS ITSELF AN INVARIANT. The close-signal wrap is applied HERE, AT CONSTRUCTION,
// before a single fatal hook is wired — so EVERY close initiator (a fatal guard trip, stdin EOF, the
// SDK's own teardown, the serving entry, the caller) flows through the latch-guaranteed wrapper
// `close()`, whose `finally` settles the latch even when the underlying close REJECTS. Wrapping
// LATER — at the `mcp.ts` call site, as this file first did — left the guards' fatal hangup holding
// the RAW transport, i.e. the most security-relevant close path was the one path outside the latch:
// a raw `close()` that rejected before emitting `onclose` settled nothing and `startMcpServer` waited
// forever. Hence the factory returns the PAIR (wrapped transport + `closed`), and nothing downstream
// ever sees the raw object.
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { JSONRPCMessage, Transport, TransportSendOptions } from "@modelcontextprotocol/server";
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
 * The caller owns the lifecycle (T-300: `start()` and the final `close()` are the serving entry's
 * — `serveStdio` owns the transport it is handed — and stdin EOF → `close()` is wired in `mcp.ts`):
 * this function names the bounds and wires the seams.
 *
 * RETURNS THE PAIR, NEVER THE RAW TRANSPORT. `transport` is already wrapped by `withCloseSignal`
 * (see the header's composition-order note), and `closed` is the latch every close path resolves —
 * including this factory's own fatal hangup, which is wired to the WRAPPER's `close()` so a
 * rejecting teardown still settles the wait instead of hanging the server.
 */
export function createBoundedTransport(
  stdin?: Readable,
  stdout?: Writable,
  options?: BoundedTransportOptions,
): { readonly transport: Transport; readonly closed: Promise<void> } {
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

  const sdk = new StdioServerTransport(inbound, outbound, { maxBufferSize: MAX_FRAME_BYTES });
  // FIRST thing after construction, BEFORE any fatal hook: everything below closes the WRAPPER, so
  // no close path can exist that the latch does not answer for (header, composition order).
  const signalled = withCloseSignal(sdk);

  // The SDK's close() resolves synchronously and cannot reject today; the wrapper's `finally`
  // settles the latch even if that ever changes, and the catch is belt-and-braces so a hangup cannot
  // turn into an unhandled rejection on the way there.
  const hangUp = (): void => {
    void signalled.transport.close().catch(() => {});
  };
  // The inbound trip keeps T-226's exact observable shape — `onerror` AND `close()` — so a cap
  // breach still looks the same to the server that reads it, only with our seam's message.
  // (`onerror` is a pass-through accessor on the wrapper, so the raw handle and the wrapped one name
  // the SAME handler; only `close()` differs, which is why only `close()` goes through the wrapper.)
  inbound.onFatal = (error) => {
    sdk.onerror?.(error);
    hangUp();
  };
  outbound.onFatal = hangUp;
  // `pipe` does not forward errors, and the SDK's own `'error'` listener now sits on the GUARD
  // rather than on the real stdin. Forward the real stream's faults to the same place the SDK would
  // have reported them, so a broken stdin is still visible rather than an unhandled `'error'`.
  source.on("error", (error: Error) => sdk.onerror?.(error));
  source.pipe(inbound);

  return signalled;
}

/**
 * T-300 A-I.3/A-II.1/A-II.2 — THE CLOSE SIGNAL, as a transport decorator.
 *
 * WHY A WRAPPER AND NOT A HOOK. `serveStdio` OWNS the transport it is handed: it assigns
 * `onmessage`/`onerror`/`onclose` on it, starts it, and closes it when the connection ends. So
 * `mcp.ts` can no longer read `transport.onclose` to learn that the session is over — doing that
 * would clobber the entry's own instance-teardown path. A hook wired into ONE close path (the
 * guards' fatal trip, say) would answer only for that path and leave the others — SDK-internal
 * teardown, a stdout error, a factory failure — hanging forever. Wrapping the object instead makes
 * the signal TOTAL: every close, whoever initiates it, runs through this one seam.
 *
 * WHAT IS COMPOSED AND WHAT IS NOT. `onmessage`/`onerror` are pure pass-through ACCESSORS — the
 * entry's handlers must reach the real transport untouched, and intercepting either would put a
 * second, weaker copy of the framing contract in the path. Only `onclose` is composed, and only
 * additively: the latch resolves first, then the entry's own handler runs, exactly once.
 */
class CloseSignallingTransport implements Transport {
  private readonly delegate: Transport;
  private readonly latch: () => void;
  /** The entry's own teardown handler, as assigned through `onclose`. */
  private downstream: (() => void) | undefined = undefined;
  /** Guards the DOWNSTREAM handler at exactly-once — a stub delegate need not guard its own. */
  private tornDown = false;

  constructor(delegate: Transport, latch: () => void) {
    this.delegate = delegate;
    this.latch = latch;
    // Subscribed ONCE, at construction, so no later `onclose` assignment can displace it.
    this.delegate.onclose = (): void => {
      if (this.tornDown) return;
      this.tornDown = true;
      this.latch();
      this.downstream?.();
    };
  }

  get onclose(): (() => void) | undefined {
    return this.downstream;
  }

  set onclose(handler: (() => void) | undefined) {
    this.downstream = handler;
  }

  get onmessage(): Transport["onmessage"] {
    return this.delegate.onmessage;
  }

  set onmessage(handler: Transport["onmessage"]) {
    this.delegate.onmessage = handler;
  }

  get onerror(): Transport["onerror"] {
    return this.delegate.onerror;
  }

  set onerror(handler: Transport["onerror"]) {
    this.delegate.onerror = handler;
  }

  get sessionId(): string | undefined {
    return this.delegate.sessionId;
  }

  set sessionId(value: string | undefined) {
    this.delegate.sessionId = value;
  }

  /** HTTP-only in practice (stdio leaves it undefined) — forwarded so the wrapper never LIES. */
  get hasPerRequestStream(): boolean | undefined {
    return this.delegate.hasPerRequestStream;
  }

  start(): Promise<void> {
    return this.delegate.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.delegate.send(message, options);
  }

  /**
   * The latch settles in a `finally`: a delegate whose `close()` REJECTS must still end the wait,
   * or a failed teardown becomes a hang. The rejection still propagates to the caller — the entry's
   * own close path tolerates it, and ours swallows it deliberately at the call site.
   */
  async close(): Promise<void> {
    try {
      await this.delegate.close();
    } finally {
      this.latch();
    }
  }

  setProtocolVersion(version: string): void {
    this.delegate.setProtocolVersion?.(version);
  }

  /** The member the D1 decorator rule exists for: dropped silently, with no type error. */
  setSupportedProtocolVersions(versions: string[]): void {
    this.delegate.setSupportedProtocolVersions?.(versions);
  }
}

/**
 * Wrap a transport so that EVERY close — ours, the serving entry's, the SDK's, a fatal guard trip,
 * a stdout error — resolves one promise. `closed` never rejects: it is a signal, not an outcome.
 *
 * PRODUCTION NEVER CALLS THIS DIRECTLY: `createBoundedTransport` applies it at construction, which
 * is what puts the guards' fatal hangup on the latched side of the seam. It stays exported for the
 * unit cells that drive the decorator against a stub transport (`close-signal.test.ts`) — the
 * rejecting-close and member-forwarding claims are the wrapper's own, and are cheapest to state
 * where nothing else is in the frame.
 */
export function withCloseSignal(transport: Transport): {
  readonly transport: Transport;
  readonly closed: Promise<void>;
} {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return { transport: new CloseSignallingTransport(transport, () => resolveClosed()), closed };
}
