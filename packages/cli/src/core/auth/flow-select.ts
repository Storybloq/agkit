// Login-flow auto-detection (T-213 S4, decision (e)). PURE + table-tested: given the flags, the
// TTY signal, the platform, and the env, decide browser (RFC 8252 loopback) vs device (RFC 8628)
// flow — and surface the stderr announcement the handler prints (G: interactive progress → stderr).
//
// Device flow is chosen iff ANY of: --device, --no-browser, an SSH session (SSH_CLIENT / SSH_TTY /
// SSH_CONNECTION set), headless linux (no DISPLAY / WAYLAND_DISPLAY), or a non-interactive terminal
// (!isTTY). On macOS-over-SSH we additionally emit the keychain caveat (the login keychain may be
// locked/absent over SSH → recommend the device flow, already selected, + AGKIT_TOKEN) — acceptance 5.

export type LoginFlow = "browser" | "device";

/** Why the device flow was selected (drives the announcement); null when the browser flow is chosen. */
export type DeviceReason = "device-flag" | "no-browser-flag" | "ssh-session" | "headless-linux" | "non-interactive";

export interface FlowSelectInput {
  readonly deviceFlag: boolean;
  readonly noBrowserFlag: boolean;
  readonly isTTY: boolean;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

export interface FlowDecision {
  readonly flow: LoginFlow;
  readonly reason: DeviceReason | null;
  readonly sshDetected: boolean;
  /** The stderr line announcing the chosen flow. */
  readonly announcement: string;
  /** The macOS-over-SSH keychain caveat (recommends device flow + AGKIT_TOKEN), or null. */
  readonly caveat: string | null;
}

/** Is an env var present and non-empty (after trim)? */
function isSet(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** An SSH session? Any of the three standard sshd-exported vars being set. */
export function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return isSet(env.SSH_CLIENT) || isSet(env.SSH_TTY) || isSet(env.SSH_CONNECTION);
}

/** Headless linux — no X11 / Wayland display, so no browser can be opened. */
function isHeadlessLinux(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === "linux" && !isSet(env.DISPLAY) && !isSet(env.WAYLAND_DISPLAY);
}

const REASON_TEXT: Record<DeviceReason, string> = {
  "device-flag": "--device was requested",
  "no-browser-flag": "--no-browser was requested",
  "ssh-session": "an SSH session was detected",
  "headless-linux": "no graphical display was detected",
  "non-interactive": "the terminal is non-interactive",
};

/** The macOS-over-SSH keychain caveat text (acceptance 5). Mentions device flow + AGKIT_TOKEN. */
export const MACOS_SSH_KEYCHAIN_CAVEAT =
  "note: over SSH the macOS login keychain is often locked or unavailable, so a stored login may " +
  "fail to persist — the device flow (selected) is recommended, and AGKIT_TOKEN=<management token> " +
  "is the non-interactive alternative.";

/** Decide the login flow + the messages to announce on stderr. Pure. */
export function selectLoginFlow(input: FlowSelectInput): FlowDecision {
  const ssh = isSshSession(input.env);
  // First matching cause wins (deterministic announcement).
  let reason: DeviceReason | null = null;
  if (input.deviceFlag) reason = "device-flag";
  else if (input.noBrowserFlag) reason = "no-browser-flag";
  else if (ssh) reason = "ssh-session";
  else if (isHeadlessLinux(input.platform, input.env)) reason = "headless-linux";
  else if (!input.isTTY) reason = "non-interactive";

  if (reason === null) {
    return {
      flow: "browser",
      reason: null,
      sshDetected: ssh,
      announcement: "using the browser login flow (opening your browser to authorize).",
      caveat: null,
    };
  }

  const caveat = ssh && input.platform === "darwin" ? MACOS_SSH_KEYCHAIN_CAVEAT : null;
  return {
    flow: "device",
    reason,
    sshDetected: ssh,
    announcement: `using the device login flow — ${REASON_TEXT[reason]}.`,
    caveat,
  };
}
