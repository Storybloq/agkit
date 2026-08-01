// T-227 S2 — THE INBOUND RAW-BYTE FRAME VALIDATOR (RELAY-A, v3-1, v4-4, v6-1).
//
// A `Transform` composed between the real stdin and the stream `StdioServerTransport` reads. It is
// COMPOSITION, not a subclass (R2-F5 stands): the SDK exposes `_stdin` as a constructor parameter,
// so a validator that sees the raw bytes BEFORE the SDK does needs no override of anything.
//
// ── WHY WE OWN BOTH -32700 AND -32600 (v3-1) ─────────────────────────────────────────────────────
// The SDK's `deserializeMessage` is ONE call — `JSONRPCMessageSchema.parse(JSON.parse(line))` — and
// both faults (a `SyntaxError` from `JSON.parse`, a `ZodError` from the schema) land in the same
// `processReadBuffer` catch, which calls `onerror` and emits NOTHING on the wire. The SDK cannot
// even tell them apart for us. So a client that sends one malformed line gets SILENCE and waits
// forever for a response that will never come. Owning both codes here is not a preference; it is the
// only way either frame is ever emitted.
//
// ── FRAMING MUST MATCH THE SDK BYTE FOR BYTE (the S2 grounding hazard) ────────────────────────────
// This file does its OWN line splitting, and the SDK does its own again on whatever we forward. If
// the two disagreed about where a line ends, a line we skipped but the SDK accepted would be a
// VALIDATOR BYPASS — the exact hole this seam exists to close. `FrameLineSplitter` and
// `decodeFrameLine` therefore replicate `ReadBuffer.readMessage` exactly:
//
//     const index = buffer.indexOf('\n');            → split on `\n` ONLY (never on `\r\n`)
//     buffer.toString('utf8', 0, index)              → decode the segment as UTF-8…
//       .replace(/\r$/, '')                          → …then strip ONE trailing `\r`
//     buffer = buffer.subarray(index + 1)            → consume index+1 bytes
//
// `frame-guard.test.ts` pins the agreement DIFFERENTIALLY against a real `ReadBuffer` rather than
// against a re-statement of the rules above.
//
// TWO DELIBERATE DEPARTURES, both fail-SAFE (they refuse more, never less):
//   • The decoder is FATAL (v3-1): invalid UTF-8 is a syntax failure and the line is NEVER
//     forwarded. `Buffer.toString('utf8')` would silently substitute U+FFFD; the SDK would then
//     reject the mojibake anyway, so the only difference is that the client is TOLD.
//   • `ignoreBOM: true` is LOAD-BEARING and not what its name suggests: it means "leave a leading
//     U+FEFF in the string", which is what `Buffer.toString('utf8')` does. The WHATWG default
//     STRIPS the BOM — under which `﻿{"jsonrpc":…}` would parse HERE and be forwarded, only to
//     throw inside the SDK, putting us back at silence for a line we said was fine.
import { Transform, type TransformCallback } from "node:stream";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/** The line delimiter, as the one byte `Buffer.indexOf('\n')` actually searches for. */
const LF = 0x0a;
/** `\r`, stripped from the END of a decoded line — a single one, exactly like `/\r$/`. */
const CR = "\r";

/**
 * FATAL + BOM-preserving, for the two reasons in the file header. Stateless at `stream: false`
 * (the default), so one module-level instance is safe to share across lines and sessions.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The two static protocol frames. STATIC IS THE POINT (RELAY-A): a malformed line can carry a
 * secret — a mistyped shell command, a pasted token, a truncated request body — so the frame we
 * answer with never contains one byte of it. There is no message parameter to get wrong.
 *
 * Hand-composed bytes rather than a re-serialization: these are CONSTANTS, not a serialization of
 * caller data, which is exactly what makes their size provable and their content non-reflective.
 * (The "no second serializer" rule governs result bodies — one `JSON.stringify` producing both the
 * machine text and `structuredContent`; it is not a rule about literal protocol constants.)
 */
export const PARSE_ERROR_FRAME =
  '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n';

/**
 * The -32600 frame for a line that IS JSON but is not a JSON-RPC message. `idJson` is the caller's
 * own id, already serialized and already bounded by `boundedRequestId` — the ONLY caller-derived
 * bytes in any frame this file emits, and they ride because a response the client cannot correlate
 * is barely better than silence. Everything else is a literal.
 */
export function invalidRequestFrame(idJson: string): string {
  return `{"jsonrpc":"2.0","id":${idJson},"error":{"code":-32600,"message":"Invalid Request"}}\n`;
}

/** The serialized `null` id — what an unusable, absent or oversized id degrades to. */
const NULL_ID = "null";

/**
 * The SDK's `ReadBuffer` framing, and ONLY the framing: it decides where lines END, never what they
 * MEAN. Split out from the validator so the differential test can drive the framing against a real
 * `ReadBuffer` without going through the JSON policy at all.
 *
 * Like the SDK's, the cap is NOT enforced here — the buffer is bounded by its owner, which checks
 * `buffered + chunk.length` BEFORE appending (v4-4; see `InboundFrameGuard`).
 */
export class FrameLineSplitter {
  private buffer: Buffer | undefined;

  /** Bytes sitting UNCONSUMED — i.e. the partial line no `\n` has terminated yet. */
  get buffered(): number {
    return this.buffer?.length ?? 0;
  }

  append(chunk: Buffer): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
  }

  /**
   * The next complete line's ORIGINAL bytes INCLUDING its terminating `\n`, or null when no `\n` is
   * buffered yet. The terminator rides along because a VALID line is forwarded to the SDK verbatim
   * — re-serializing it would be a second source of bytes for the same message.
   */
  next(): Buffer | null {
    if (!this.buffer) return null;
    const index = this.buffer.indexOf(LF);
    if (index === -1) return null;
    const framed = this.buffer.subarray(0, index + 1);
    this.buffer = this.buffer.subarray(index + 1);
    return framed;
  }

  /** Drop everything unconsumed — the fail-closed path's first act (v4-4), and `ReadBuffer.clear`. */
  clear(): void {
    this.buffer = undefined;
  }
}

/**
 * Decode one framed line (terminator included) the way the SDK does — UTF-8, minus a single trailing
 * `\r` — but FATALLY. `null` means the segment was not valid UTF-8, which this seam treats as a
 * syntax failure (v3-1).
 */
export function decodeFrameLine(framed: Buffer): string | null {
  let text: string;
  try {
    // Everything before the `\n`; the SDK's `toString('utf8', 0, index)`.
    text = UTF8.decode(framed.subarray(0, framed.length - 1));
  } catch {
    return null;
  }
  return text.endsWith(CR) ? text.slice(0, -1) : text;
}

/** What the validator decided about one line. */
export type FrameVerdict =
  /** A valid JSON-RPC message: the ORIGINAL bytes go to the SDK untouched. */
  | { readonly kind: "forward" }
  /** A protocol fault: emit exactly this frame, and forward nothing. */
  | { readonly kind: "reject"; readonly frame: string };

/** What a message's `id` member is worth to us (v6-1). */
export type IdVerdict =
  /** No id, or not a correlatable id TYPE (`RequestIdSchema` = string | integer). */
  | { readonly kind: "none" }
  /** A valid id whose SERIALIZED form fits the cap — safe to echo. */
  | { readonly kind: "usable"; readonly json: string }
  /** A valid id type whose serialized form is over the cap. */
  | { readonly kind: "oversized" };

/**
 * Inspect a parsed message's `id` against the ratified 4 KiB cap (v6-1).
 *
 * A `{}` or `true` id is `none`, not `oversized`: it is not correlatable, and echoing it back would
 * be reflecting attacker bytes for no protocol benefit. An id over the cap is its own verdict
 * because the two callers do OPPOSITE things with it — the reject path degrades to `id:null`, and
 * the FORWARD path refuses the message outright.
 */
export function inspectId(value: unknown, maxIdBytes: number): IdVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "none" };
  const id: unknown = (value as Record<string, unknown>)["id"];
  const usable = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
  if (!usable) return { kind: "none" };
  const json = JSON.stringify(id);
  if (typeof json !== "string") return { kind: "none" };
  if (Buffer.byteLength(json, "utf8") > maxIdBytes) return { kind: "oversized" };
  return { kind: "usable", json };
}

/**
 * THE per-line policy. Syntax failure (bad UTF-8 or unparseable JSON) → -32700 with `id:null`,
 * because a line we could not parse is a line whose id we do not know. Parseable but not a JSON-RPC
 * message → -32600, correlated where we honestly can be. Otherwise forward the original bytes.
 *
 * The schema is the SDK's OWN `JSONRPCMessageSchema` — the same one `deserializeMessage` applies a
 * moment later — so "we accepted it" and "the SDK accepted it" cannot drift into different answers.
 * It does mean the envelope is parsed twice per message; at management-plane call rates that is
 * nothing next to a client hanging forever on a frame nobody sent.
 */
export function classifyFrameLine(framed: Buffer, maxIdBytes: number): FrameVerdict {
  const text = decodeFrameLine(framed);
  if (text === null) return { kind: "reject", frame: PARSE_ERROR_FRAME };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Includes the EMPTY line: `JSON.parse("")` throws, so a blank line is a syntax error here
    // exactly as it already is inside the SDK — the difference is that the client is told.
    return { kind: "reject", frame: PARSE_ERROR_FRAME };
  }
  const id = inspectId(value, maxIdBytes);
  if (JSONRPCMessageSchema.safeParse(value).success) {
    // v6-1 — THE ID CAP BINDS WELL-FORMED MESSAGES TOO, and this is the load-bearing half.
    // `RequestIdSchema` accepts a string of any length, so a 10 MiB id on an otherwise perfect
    // request would be ECHOED by the SDK on every response to it. That would break the a-priori
    // size proof the outbound backstop rests on (v7-1: static bytes + an id known to be ≤ 4 KiB)
    // and hand a client a cheap amplification channel. Refuse the request instead, with `id:null`
    // — the oversized id never appears in one outbound byte.
    if (id.kind === "oversized") return { kind: "reject", frame: invalidRequestFrame(NULL_ID) };
    return { kind: "forward" };
  }
  return { kind: "reject", frame: invalidRequestFrame(id.kind === "usable" ? id.json : NULL_ID) };
}

export interface InboundGuardOptions {
  /** The accumulation cap, in bytes (v4-4 — it MOVES to this seam and stays fail-closed). */
  readonly maxFrameBytes: number;
  /** The ratified 4 KiB bound on a serialized echoed id (v6-1). */
  readonly maxIdBytes: number;
  /**
   * Write ONE protocol frame on the outbound side. Resolves when the frame is flushed, so a slow
   * reader backpressures the INBOUND stream too rather than queueing error frames without bound.
   */
  readonly sendFrame: (frame: string) => Promise<void>;
}

/**
 * The composed validator. Bytes in from real stdin, validated bytes out to the SDK transport.
 *
 * THE CAP LIVES HERE NOW (v4-4). It has to: this stream buffers first, so a cap that only existed
 * downstream would bound the SDK's buffer while ours grew without limit. The semantics T-226 pinned
 * are preserved EXACTLY — the check is on `buffered + chunk.length` BEFORE appending (so an
 * attacker cannot evade it by never sending a `\n`), and a trip CLEARS the buffer, emits NOTHING
 * (no -32700, no reflection of the bytes that caused it — that would be a memory-exhaustion attempt
 * echoing itself back), closes the session, and forwards nothing that arrives afterwards. Survival
 * applies to malformed lines WITHIN the cap; an unbounded one hangs up.
 */
export class InboundFrameGuard extends Transform {
  /** Fail closed: report the fault and close the session. Wired by `createBoundedTransport`. */
  onFatal?: (error: Error) => void;

  private readonly splitter = new FrameLineSplitter();
  private dead = false;

  constructor(private readonly options: InboundGuardOptions) {
    super();
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    // `decodeStrings` defaults to true, so a piped stream always hands us a Buffer; the conversion
    // is for a caller that wrote a string into this stream directly (a test, or a future embedder).
    // Node passes the runtime sentinel `"buffer"` as the encoding for pre-decoded chunks, which is
    // outside the `BufferEncoding` type — hence the widening compare rather than a direct one.
    const declared: string = encoding;
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), declared === "buffer" ? "utf8" : encoding);
    this.consume(bytes).then(
      () => callback(),
      // `consume` swallows nothing on its own; this is the belt-and-braces path for an error-frame
      // write that rejected. Fail closed rather than continuing to read a stream we cannot answer.
      (error: unknown) => {
        this.failClosed(error instanceof Error ? error : new Error(String(error)));
        callback();
      },
    );
  }

  private async consume(chunk: Buffer): Promise<void> {
    if (this.dead) return;
    if (this.splitter.buffered + chunk.length > this.options.maxFrameBytes) {
      this.failClosed(
        new Error(
          `agkit mcp: inbound frame buffer exceeded maximum size of ${this.options.maxFrameBytes} bytes`,
        ),
      );
      return;
    }
    this.splitter.append(chunk);
    for (;;) {
      const framed = this.splitter.next();
      if (framed === null || this.dead) return;
      const verdict = classifyFrameLine(framed, this.options.maxIdBytes);
      if (verdict.kind === "forward") {
        this.push(framed);
        continue;
      }
      // AWAITED, so the frames for two malformed lines in one chunk keep their order and a blocked
      // stdout stops us reading rather than growing a queue.
      await this.options.sendFrame(verdict.frame);
    }
  }

  private failClosed(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.splitter.clear();
    this.onFatal?.(error);
  }
}

export function createInboundGuard(options: InboundGuardOptions): InboundFrameGuard {
  return new InboundFrameGuard(options);
}
