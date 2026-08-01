// The browser-open seam (T-213 S4, decision (e) + B-10). Used ONLY in the browser login flow to
// open the AS authorize URL — NEVER for the device flow's `verification_uri_complete` (which is
// printed as a plain URL). Every launch is `spawn` with `shell:false`, per-platform argv:
//
//   darwin → `open <url>` · linux/other → `xdg-open <url>` · win32 → `rundll32.exe
//   url.dll,FileProtocolHandler <url>`.
//
// win32 deliberately does NOT route through `cmd.exe` (`cmd /c start …`): even with shell:false,
// cmd RE-TOKENIZES its command line and splits at unescaped `&` — and every real authorize URL
// has `&` between query params — so a URL would break or, worse, inject a command. rundll32's
// FileProtocolHandler takes the URL as a single, non-reparsed argument (B-10 / codex #5).
//
// The URL itself is validated BEFORE launch (defence in depth — as-metadata already validated the
// authorization_endpoint): parsed with `new URL`, required to be https (or http to a loopback host
// for local dev), and RE-SERIALIZED, so a hostile/garbage value can never reach the OS launcher.
import { spawn as nodeSpawn } from "node:child_process";

/** The narrow child surface the opener needs — fire-and-forget (unref) + a non-throwing error sink. */
export interface OpenedChild {
  unref(): void;
  on(event: "error", listener: (err: Error) => void): void;
}

/** The narrow `spawn` slice (shell:false always). Injected so per-platform argv is asserted in tests. */
export type OpenUrlSpawn = (
  command: string,
  args: readonly string[],
  options: { shell: false; stdio: "ignore"; detached: boolean; windowsHide: boolean },
) => OpenedChild;

export interface OpenUrlDeps {
  readonly spawn?: OpenUrlSpawn;
  readonly platform?: NodeJS.Platform;
}

/** A refused open (bad scheme / unparseable URL). Mapped to an existing code by the caller. */
export class OpenUrlError extends Error {
  override name = "OpenUrlError";
}

/**
 * Is `hostname` a LITERAL loopback IP? (Cleartext http is only permitted to loopback for local
 * dev.) The hostname `localhost` is deliberately EXCLUDED (P4): it can DNS-resolve off-box, so
 * "http to localhost" is not provably local.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * Validate + re-serialize an https (or http-to-literal-loopback) URL. Throws `OpenUrlError` on
 * anything else (never hand a garbage/hostile value to the OS launcher) — including any URL
 * carrying USERINFO (P4): `URL.href` PRESERVES userinfo through re-serialization, so it must be
 * rejected explicitly, never assumed stripped. Exported for the caller/tests.
 */
export function validateOpenableUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new OpenUrlError(`refusing to open a malformed URL`);
  }
  if (u.username !== "" || u.password !== "") {
    throw new OpenUrlError("refusing to open a URL carrying embedded credentials (userinfo)");
  }
  const httpsOk = u.protocol === "https:";
  const httpLoopbackOk = u.protocol === "http:" && isLoopbackHostname(u.hostname);
  if (!httpsOk && !httpLoopbackOk) {
    throw new OpenUrlError(`refusing to open a non-https URL (scheme '${u.protocol.replace(/:$/, "")}')`);
  }
  // Re-serialized + normalized. Userinfo was rejected above (href would have PRESERVED it).
  return u.href;
}

/** The default spawn: node child_process, shell:false, detached + stdio ignore (fire-and-forget). */
const defaultSpawn: OpenUrlSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as OpenedChild;

/** Per-platform launcher argv (B-10). win32 uses rundll32 (never cmd.exe re-parsing). */
export function browserLauncherArgv(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] }; // linux + other unixes
}

/**
 * Open `rawUrl` in the user's default browser (best-effort). Validates + re-serializes first
 * (throws `OpenUrlError` on a bad scheme), then spawns the per-platform launcher with shell:false.
 * The spawn is fire-and-forget: the child is unref'd and its `error` event swallowed (a machine
 * with no browser is not a login failure — the caller can fall back to printing the URL).
 */
export function openUrl(rawUrl: string, deps: OpenUrlDeps = {}): void {
  const url = validateOpenableUrl(rawUrl);
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn;
  const { command, args } = browserLauncherArgv(platform, url);
  const child = spawn(command, args, { shell: false, stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => {
    /* best-effort: a failed launch is surfaced by the caller's fallback (print the URL), not here */
  });
  child.unref();
}
