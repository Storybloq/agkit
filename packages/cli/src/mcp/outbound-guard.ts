// T-227 S2 — THE OUTBOUND BOUNDED FRAME WRITER (v6-1 + v7-1).
//
// A `Writable` composed between the SDK's `_stdout` and the real stdout — the mirror of the inbound
// validator, and the same seam type (a constructor parameter, no subclass of the SDK transport).
//
// ── WHY THIS SEAM AND NOT A RESULT-SIZE CHECK (v6-1) ──────────────────────────────────────────────
// `StdioServerTransport.send` is `this._stdout.write(JSON.stringify(message) + '\n')` — ONE write
// per message, of the FINAL serialized JSON-RPC frame. So this stream observes exactly what v6-1
// asks the 768 KiB budget to measure: the envelope, the echoed id, the framing newline, everything,
// for EVERY outbound frame class — tools/call results, the 35-tool tools/list payload, protocol
// errors the SDK authors, and the inbound validator's own -32700/-32600 frames (which are written
// through `sendFrame` below, so they are measured by the same bound they exist to serve).
//
// `result.ts`'s `MAX_BODY_BYTES` stays the EARLY GRACEFUL path: it turns an oversized tool result
// into a small, honest `[response_too_large]` answer while it still can. This is the BACKSTOP —
// the bound that cannot be bypassed, because nothing reaches the wire except through it.
//
// ── THE BACKSTOP IS DETERMINISTIC (v7-1) ─────────────────────────────────────────────────────────
// Refusing to write an oversized frame is only half an answer: a client that asked a question and
// gets nothing hangs. So an oversized RESPONSE with a usable id is answered with ONE pre-sized
// STATIC -32603 frame built from static bytes plus that id — provably under budget a priori
// (`EMERGENCY_STATIC_BYTES` + the inbound 4 KiB id cap), never a re-serialization of the thing that
// was too big, and never routed back through this bound (no recursion).
//
// Everything else — a notification, an outbound request, an unusable id, or a failure of the
// emergency write ITSELF — hangs up: one bounded static stderr diagnostic, then the session closes.
// That is the T-226 oversize-INBOUND precedent applied outbound: a transport that cannot answer
// honestly says nothing and disconnects, rather than emitting a half-frame that desynchronizes the
// client's parser for the rest of the session.
import { Writable } from "node:stream";

/** The write callback Node hands `_write`. */
type WriteCallback = (error?: Error | null) => void;

/**
 * The emergency frame, split at its ONE variable point. `{"jsonrpc":"2.0","id":` + the caller's own
 * serialized id + the static error tail. The message is a fixed string: the frame that reports "the
 * answer was too big" must never contain any of the answer.
 */
const EMERGENCY_PREFIX = '{"jsonrpc":"2.0","id":';
const EMERGENCY_SUFFIX =
  ',"error":{"code":-32603,"message":"response exceeds the server frame limit"}}\n';

/** The frame's size with an EMPTY id — the a-priori bound is this plus the id cap. */
export const EMERGENCY_STATIC_BYTES =
  Buffer.byteLength(EMERGENCY_PREFIX, "utf8") + Buffer.byteLength(EMERGENCY_SUFFIX, "utf8");

/**
 * MODULE-LOAD ASSERTION (v7-1: "a startup assertion pins the static portion's size"). The whole
 * backstop rests on the emergency frame's size being known BEFORE it is built; if an edit to either
 * literal above moved that number, the proof would be stale and this file would be quietly shipping
 * a frame whose size nobody has bounded. 100 = 22 (`{"jsonrpc":"2.0","id":`) + 78 (the tail).
 */
const EMERGENCY_STATIC_BYTES_PIN = 100;
if (EMERGENCY_STATIC_BYTES !== EMERGENCY_STATIC_BYTES_PIN) {
  throw new Error(
    `agkit mcp: the emergency frame's static size is ${EMERGENCY_STATIC_BYTES} bytes, not the pinned ${EMERGENCY_STATIC_BYTES_PIN} — the v7-1 a-priori bound proof is stale`,
  );
}

export interface OutboundGuardOptions {
  /** The real sink (production: `process.stdout`). Written to ONLY from here. */
  readonly stdout: Writable;
  /** The 768 KiB whole-frame budget (v6-1). */
  readonly maxFrameBytes: number;
  /** The ratified 4 KiB serialized-id cap (v6-1) — the other half of the a-priori proof. */
  readonly maxIdBytes: number;
  /** Bounded static stderr diagnostics. Best-effort by contract; MUST NOT throw. */
  readonly diagnostic: (text: string) => void;
}

export class BoundedFrameWriter extends Writable {
  /** Fail closed: close the session. Wired by `createBoundedTransport`. */
  onFatal?: () => void;

  private dead = false;

  /**
   * The sink's `'error'` event, OWNED (an after-S2 relay fold). A failed write delivers its error
   * to the write CALLBACK — which `attempt` handles — *and* Node emits `'error'` on the sink; with
   * no listener, that emission is an uncaughtException, i.e. a CRASH where this seam's contract
   * promises a controlled hangup (the real `agkit mcp serve | dying-client` EPIPE case). The
   * handler is idempotent with the callback path (`hangUp` fires once), and it stays attached for
   * the writer's lifetime ON PURPOSE: after a hangup the serve loop is already unwinding, and
   * absorbing a late second sink error is strictly safer than letting it throw.
   */
  private readonly onSinkError = (): void => {
    this.hangUp("the stdout stream errored");
  };

  constructor(private readonly options: OutboundGuardOptions) {
    // `highWaterMark: 1` IS THE BACKPRESSURE (T-226 behavior (d), which this seam must not break).
    // The SDK resolves `send()` immediately when `write()` returns true, and only awaits `'drain'`
    // when it returns false. At the default 16 KiB mark this stream would answer TRUE for every
    // realistic frame while the real stdout was still blocked — silently converting the SDK's
    // await-drain into fire-and-forget and letting an unbounded write queue grow in our process.
    // At 1, any in-flight chunk makes `write()` return false, so the SDK waits for the real reader.
    super({ highWaterMark: 1 });
    if (EMERGENCY_STATIC_BYTES + options.maxIdBytes > options.maxFrameBytes) {
      // The a-priori proof, checked against THESE bounds rather than assumed from the defaults.
      throw new Error(
        "agkit mcp: the emergency frame's worst case does not fit the outbound frame budget",
      );
    }
    options.stdout.on("error", this.onSinkError);
  }

  /**
   * Write ONE already-serialized protocol frame (the inbound validator's -32700/-32600). Deliberately
   * mirrors `StdioServerTransport.send`: resolve on a true `write()`, otherwise on `'drain'` — one
   * backpressure behavior on this stream, not two.
   */
  sendFrame(frame: string): Promise<void> {
    return new Promise((resolve) => {
      // After a hangup there is no session left to answer to; resolving keeps the inbound guard's
      // await from stranding while the close propagates.
      if (this.dead) {
        resolve();
        return;
      }
      if (this.write(frame)) resolve();
      else this.once("drain", () => resolve());
    });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
    // Post-hangup bytes are DROPPED, never written: the session is closing precisely because we
    // could not be trusted to frame it correctly, and a trailing frame after a partial one is the
    // corruption we hung up to avoid. The callback still fires so nothing upstream hangs.
    if (this.dead) {
      callback();
      return;
    }
    // The whole frame as the wire carries it — the serialized message AND its framing newline.
    if (chunk.length <= this.options.maxFrameBytes) {
      this.forward(chunk, callback);
      return;
    }
    this.backstop(chunk, callback);
  }

  /** The under-budget path: pass the bytes through, preserving the SDK's await-drain semantics. */
  private forward(chunk: Buffer, callback: WriteCallback): void {
    this.attempt(chunk, "the stdout write failed", callback);
  }

  /** v7-1: answer if we honestly can, hang up if we cannot. */
  private backstop(chunk: Buffer, callback: WriteCallback): void {
    const id = boundedResponseId(chunk, this.options.maxIdBytes);
    if (id === null) {
      // A notification, an outbound request, or a response whose id is absent/oversized/not a valid
      // id type: there is no frame that would correlate, so there is no honest answer to write.
      this.hangUp(
        `an outbound frame of ${chunk.length} bytes exceeds the ${this.options.maxFrameBytes}-byte frame limit and carries no usable response id`,
      );
      callback();
      return;
    }
    this.attempt(
      EMERGENCY_PREFIX + id + EMERGENCY_SUFFIX,
      "the emergency frame could not be written",
      callback,
    );
  }

  /**
   * ONE write attempt, and at most one. The two failure shapes are distinct and both fail closed:
   *   (a) a SYNCHRONOUS throw from `write()` — nothing reached stdout, so no bytes are on the wire;
   *   (b) an error delivered to the write CALLBACK — the frame may be partially out, which makes it
   *       transport corruption. Neither is retried: a second attempt after a partial frame appends
   *       bytes to a half-written one, which is worse than silence.
   */
  private attempt(chunk: Buffer | string, reason: string, callback: WriteCallback): void {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // A failed write emits no `'drain'`, so the listener the backpressure path may have armed
      // would otherwise outlive the write it belonged to.
      this.options.stdout.off("drain", release);
      callback();
    };
    try {
      const flushed = this.options.stdout.write(chunk, (error) => {
        if (!error) return;
        this.hangUp(reason);
        // Release explicitly: without it the SDK's `send()` would stay pending for the life of the
        // process, waiting on a `'drain'` that a failed write will never emit.
        release();
      });
      if (flushed) release();
      else this.options.stdout.once("drain", release);
    } catch {
      this.hangUp(reason);
      release();
    }
  }

  /** Fail closed, once: a bounded STATIC diagnostic, then the session closes. */
  private hangUp(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    // Static text plus two integers this module computed — no caller bytes, so there is nothing
    // here to redact and nothing to bound beyond the fixed length it already has.
    this.diagnose(`agkit mcp: ${reason}; hanging up the session\n`);
    this.onFatal?.();
  }

  private diagnose(text: string): void {
    try {
      this.options.diagnostic(text);
    } catch {
      /* diagnostics are best-effort — a broken stderr must not break the hangup itself */
    }
  }
}

/**
 * The id of an oversized frame, SERIALIZED and bounded, or `null` when there is no honest answer.
 *
 * The frame is OUR OWN serialization, so parsing it back is reading a document we wrote — not
 * trusting caller input. It is the only way to recover the id: the SDK serializes a result response
 * as `{result, jsonrpc, id}`, so the id is at the END of a frame we already refused to write, and a
 * prefix scan would find nothing.
 *
 * `result`/`error` presence is what makes it a RESPONSE. A notification has no id at all and an
 * outbound REQUEST's id belongs to a call WE made — answering ourselves with -32603 would look to
 * the client like a response to a request it never sent.
 */
export function boundedResponseId(frame: Buffer, maxIdBytes: number): string | null {
  let value: unknown;
  try {
    value = JSON.parse(frame.toString("utf8"));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!("result" in record) && !("error" in record)) return null;
  const id: unknown = record["id"];
  if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) return null;
  const json = JSON.stringify(id);
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxIdBytes) return null;
  return json;
}
