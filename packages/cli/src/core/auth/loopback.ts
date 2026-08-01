// The RFC 8252 loopback redirect listener for the auth-code+PKCE browser login (T-213 S3).
// This is the FIRST (and only) node:http server in the CLI, so it is written paranoid:
//
//   • BIND — 127.0.0.1 (or [::1]) on an EPHEMERAL kernel-assigned port; NEVER 0.0.0.0 /
//     unspecified, and the literal hostname `localhost` is REJECTED at construction (it can
//     DNS-resolve off-box). The redirect_uri handed to the AS is `http://127.0.0.1:{port}/callback`.
//   • ONE-SHOT — only a well-formed `GET /callback` from a LOOPBACK peer, carrying exactly the
//     matching `state` and exactly one of `code`/`error`, consumes the listener. Everything else
//     (wrong method/path, missing/duplicate/oversized params, MISMATCHED state, a non-loopback
//     peer, a `localhost` Host header) gets a byte-constant 404 and does NOT consume it — so an
//     attacker racing the port cannot kill an in-flight login, and a stray probe is harmless.
//   • BYTE-CONSTANT RESPONSES — the success/failure/404 bodies interpolate ZERO request data
//     (no reflected `error_description`, no path echo): a localhost origin is still an origin, and
//     a reflected `<script>`/ANSI payload is a real XSS / terminal-injection foothold. The CLI
//     surfaces the teachable outcome from the RESOLVED value, never from the browser page.
//   • BOUNDED + LEAK-FREE — an overall login watchdog (default 300s, injectable timers) closes the
//     server; `close()` is idempotent and every settle path releases the port (a test re-binds it).
//
// Everything is injected (createServer / timers) so the strict-parser matrix, the peer check, and
// the watchdog are driven deterministically; a couple of tests still exercise REAL node:http on an
// ephemeral port for the socket-level guarantees (bind, one-shot, port release).
import { createServer as nodeCreateServer } from "node:http";

/** The one bound path a callback may hit. */
export const CALLBACK_PATH = "/callback";
/** Default overall login watchdog — the browser round-trip must complete inside this. */
export const DEFAULT_LOOPBACK_WATCHDOG_MS = 300_000;
/** Upper bound on the request-target length (a callback URL is short; anything huge is hostile). */
const MAX_REQUEST_TARGET = 8192;
/** Upper bound on any single OAuth parameter value. */
const MAX_PARAM_VALUE = 4096;
/** The loopback hosts we will bind / accept. `localhost` is deliberately EXCLUDED (it can resolve off-box). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

/** The minimal request slice the listener reads (structurally satisfied by http.IncomingMessage). */
export interface LoopbackRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string };
}

/** The minimal response slice the listener writes (structurally satisfied by http.ServerResponse). */
export interface LoopbackResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/** The minimal HTTP server surface (structurally satisfied by http.Server). */
export interface LoopbackHttpServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export type LoopbackHandler = (req: LoopbackRequest, res: LoopbackResponse) => void;
export type CreateLoopbackServer = (handler: LoopbackHandler) => LoopbackHttpServer;

/** What a consumed callback yielded — a code (success) or a teachable OAuth error (e.g. access_denied). */
export type CallbackOutcome =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: string; readonly description: string | null };

export interface LoopbackDeps {
  /** Server factory. Default: node:http.createServer. Injected for the strict-parser / peer tests. */
  readonly createServer?: CreateLoopbackServer;
  /** Watchdog timers. Default: the globals. Injected so the timeout fires with no real wait. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Overall login watchdog budget (ms). Default DEFAULT_LOOPBACK_WATCHDOG_MS. */
  readonly watchdogMs?: number;
  /** Loopback host to bind. Default "127.0.0.1". "localhost" is REJECTED. */
  readonly host?: string;
}

/** The overall watchdog fired before any matching callback arrived (bounded wait — RULES). */
export class LoopbackTimeoutError extends Error {
  override name = "LoopbackTimeoutError";
  constructor(ms: number) {
    super(`loopback login timed out after ${ms}ms waiting for the browser callback`);
  }
}

/** The listener was closed (login aborted / caller torn down) before a callback arrived. */
export class LoopbackClosedError extends Error {
  override name = "LoopbackClosedError";
  constructor() {
    super("loopback login listener was closed before a callback arrived");
  }
}

export interface LoopbackListener {
  /** The exact `http://127.0.0.1:{port}/callback` to register as the OAuth redirect_uri. */
  readonly redirectUri: string;
  /** The kernel-assigned ephemeral port. */
  readonly port: number;
  /** Resolves on the FIRST matching-state callback; rejects on watchdog expiry or close(). Call once. */
  waitForCallback(): Promise<CallbackOutcome>;
  /** Idempotent teardown — clears the watchdog, closes the server, releases the port. */
  close(): void;
}

// ── byte-constant response bodies (zero request-data interpolation — B-17) ───────────────────
const SUCCESS_BODY =
  "<!doctype html><meta charset=utf-8><title>agkit</title>" +
  "<p>Login complete. You may close this window and return to the terminal.</p>";
const FAILURE_BODY =
  "<!doctype html><meta charset=utf-8><title>agkit</title>" +
  "<p>Authorization did not complete. You may close this window and return to the terminal.</p>";
const NOT_FOUND_BODY =
  "<!doctype html><meta charset=utf-8><title>agkit</title><p>Not found.</p>";

function writeConstant(res: LoopbackResponse, status: number, body: string): void {
  res.statusCode = status;
  // Fixed content-type; a fixed body. No request data ever reaches these bytes.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

/** Is this socket peer a loopback address? (127.0.0.0/8, ::1, and the v4-mapped form.) */
function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (typeof remoteAddress !== "string" || remoteAddress.length === 0) return false;
  const a = remoteAddress.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return v4 === "127.0.0.1" || v4.startsWith("127.");
}

/** Single-header value (node folds duplicates into a comma string or an array — reject an array). */
function singleHeader(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  return null; // absent, or an array (duplicated header) → treat as not-usable
}

/**
 * The STRICT callback parser (B-17). Returns the matching-state outcome to CONSUME on, or null to
 * respond 404 WITHOUT consuming. Every rejection path is non-consuming so a malformed/forged probe
 * never terminates a live login. `expectedState` gates CSRF: a mismatch is silently non-consuming.
 */
function parseCallback(req: LoopbackRequest, ownOrigin: string, expectedState: string): CallbackOutcome | null {
  if (req.method !== "GET") return null;
  if (!isLoopbackPeer(req.socket?.remoteAddress)) return null;

  const target = req.url;
  if (typeof target !== "string" || target.length === 0 || target.length > MAX_REQUEST_TARGET) return null;
  // Origin-form only: a callback target is `/callback?…`; an absolute-form target (with an
  // authority/userinfo) is never legitimate here and must not be re-pointed off the loopback host.
  if (!target.startsWith("/")) return null;
  // A network-path reference ("//host/…") resolves to a FOREIGN authority under WHATWG relative
  // parsing — reject it before it can masquerade as the local /callback path (P5a).
  if (target.startsWith("//")) return null;

  // Host header (if present) must name a loopback IP — never `localhost` (DNS-rebinding guard).
  const hostHeader = singleHeader(req.headers?.host);
  if (hostHeader !== null) {
    const hostname = hostHeader.replace(/:\d+$/, "").toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostname)) return null;
  }

  let u: URL;
  try {
    u = new URL(target, ownOrigin);
  } catch {
    return null;
  }
  // The parsed request must sit on the listener's OWN origin (P5a) — belt-and-braces with the
  // "//" reject above: no relative-resolution quirk may ever land the callback off this origin.
  if (u.origin !== ownOrigin) return null;
  if (u.pathname !== CALLBACK_PATH) return null;
  if (u.hash !== "" || u.username !== "" || u.password !== "") return null;

  const params = u.searchParams;
  // Exactly one non-empty `state`.
  const states = params.getAll("state");
  if (states.length !== 1) return null;
  const state = states[0];
  if (state === undefined || state.length === 0 || state.length > MAX_PARAM_VALUE) return null;

  // At most one each of code/error, and EXACTLY one of the two present.
  const codes = params.getAll("code");
  const errors = params.getAll("error");
  if (codes.length > 1 || errors.length > 1) return null;
  const hasCode = codes.length === 1;
  const hasError = errors.length === 1;
  if (hasCode === hasError) return null; // neither, or both → malformed

  // CSRF: the state must match. A mismatch is NON-consuming (an attacker cannot kill the login).
  if (state !== expectedState) return null;

  if (hasError) {
    const error = errors[0];
    if (error === undefined || error.length === 0 || error.length > MAX_PARAM_VALUE) return null;
    const descRaw = params.get("error_description");
    const description = typeof descRaw === "string" && descRaw.length > 0 && descRaw.length <= MAX_PARAM_VALUE ? descRaw : null;
    return { kind: "error", error, description };
  }

  const code = codes[0];
  if (code === undefined || code.length === 0 || code.length > MAX_PARAM_VALUE) return null;
  return { kind: "code", code };
}

/** A tiny handled-by-default deferred so a close()-rejection never becomes an unhandled rejection. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve(v) {
      if (this.settled) return;
      this.settled = true;
      resolve(v);
    },
    reject(e) {
      if (this.settled) return;
      this.settled = true;
      reject(e);
    },
  };
  // Attach an internal no-op handler so a reject with no external awaiter is never "unhandled".
  promise.catch(() => {});
  return d;
}

/**
 * Bind a one-shot loopback callback listener and return its redirect_uri + the awaitable outcome.
 * `expectedState` is the CSRF nonce a callback must carry verbatim. Rejects at construction if
 * `host` is not a bound-able loopback IP (never `localhost`).
 */
export async function createLoopbackListener(expectedState: string, deps: LoopbackDeps = {}): Promise<LoopbackListener> {
  const host = deps.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`refusing to bind loopback listener to non-loopback host '${host}' (localhost is not permitted)`);
  }
  const bindHost = host === "[::1]" ? "::1" : host;
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const watchdogMs = deps.watchdogMs ?? DEFAULT_LOOPBACK_WATCHDOG_MS;
  const create = deps.createServer ?? ((handler) => nodeCreateServer(handler) as unknown as LoopbackHttpServer);

  // The URL-authority form of the loopback host (an IPv6 literal is bracketed in a URL).
  const displayHost = host === "::1" ? "[::1]" : host;

  const result = deferred<CallbackOutcome>();
  let closed = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  // Assigned once the kernel binds an ephemeral port (below); read by the handler closure, which
  // only ever runs AFTER the bind completes, so it always observes the real port.
  let port = 0;

  const server = create((req, res) => {
    const outcome = parseCallback(req, `http://${displayHost}:${port}`, expectedState);
    if (outcome === null) {
      writeConstant(res, 404, NOT_FOUND_BODY);
      return; // non-consuming
    }
    writeConstant(res, 200, outcome.kind === "code" ? SUCCESS_BODY : FAILURE_BODY);
    result.resolve(outcome);
    teardown();
  });

  server.on("error", (err) => {
    result.reject(err);
    teardown();
  });

  function teardown(): void {
    if (closed) return;
    closed = true;
    if (watchdog !== null) {
      timers.clearTimeout(watchdog);
      watchdog = null;
    }
    try {
      server.close();
    } catch {
      /* best-effort — the port is released either way */
    }
  }

  // P5c: the watchdog is armed BEFORE the bind so it bounds the BIND phase too — a `listen` that
  // never calls back (and emits no error) must reject construction, never hang it forever.
  watchdog = timers.setTimeout(() => {
    result.reject(new LoopbackTimeoutError(watchdogMs));
    teardown();
  }, watchdogMs);

  // Bind on the ephemeral port; the kernel assigns it in the listen callback.
  const bound = new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    try {
      server.listen(0, bindHost, () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          // P5b: release the socket BEFORE rejecting — a failed construction must not leak a server.
          teardown();
          reject(new Error("loopback listener did not receive a numeric port from the kernel"));
          return;
        }
        port = addr.port;
        resolve();
      });
    } catch (err) {
      // A SYNCHRONOUS listen() throw would otherwise reject construction while leaving the
      // already-armed watchdog (P5c arms it before the bind) running to its full timeout —
      // tear down (cancels the watchdog, closes the server) BEFORE rejecting.
      teardown();
      reject(err);
    }
  });
  // Race the bind against the outcome promise: `result` can only settle pre-bind via the watchdog
  // (LoopbackTimeoutError) or close(), and either must surface as a construction rejection (P5c).
  await Promise.race([bound, result.promise]);

  return {
    redirectUri: `http://${displayHost}:${port}${CALLBACK_PATH}`,
    port,
    waitForCallback: () => result.promise,
    close() {
      if (!result.settled) result.reject(new LoopbackClosedError());
      teardown();
    },
  };
}
