// T-222 6b (D-5 / A11) — MCP client-registration DETECTION, plus (T-224) the registration
// SNIPPETS that name the same shape.
//
// CREATION CUSTODY: T-224 (`agkit setup`) owns the WRITE side over this SAME candidate
// model and path constants — extend HERE, never fork a second list. selftest's check 8
// consumes `detectMcpRegistration`; T-224's writer targets `mcpConfigCandidates` rows.
// T-224 claimed that custody for the SNIPPET half only: `claudeMcpAddCommand` /
// `codexServerBlock` at the foot of this file render the exact bytes a registration
// consists of, so the manual instructions setup prints (and T-228's `print-config`) can
// never drift from what the writer writes. The detection below is unchanged.
//
// A11 semantic gate: finding a candidate file — or an entry that merely MENTIONS agkit —
// is NOT a registration. Success requires the `agkit` server entry to resolve to an agkit
// binary (basename `agkit`, Windows `.cmd`/`.exe` variants included) whose command is
// EXACTLY `mcp serve`. Malformed or oversized files are skipped (bounded parse, never a
// crash, never a false positive).
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { InstallFs } from "../housekeeping/install";
import { CODEX_SERVE_ARGS, codexServerTable, shellQuotePosix, shellQuoteWin } from "../../commands/setup/codex-toml";

/** Bounded parse cap for a candidate config (A11) — a config is a small file by nature. */
export const MCP_CONFIG_MAX_BYTES = 262_144;

/** The name every host indexes this server under — the same key on both sides of the wire. */
export const MCP_SERVER_ENTRY = "agkit";

export interface McpDetectDeps {
  readonly homeDir: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

export interface McpConfigCandidate {
  readonly path: string;
  readonly format: "json" | "toml";
  // Underscore spellings (never `claude-…`): the source-literal guard forbids the `claude-`
  // model-name prefix in code, and these provenance tags name the Claude CLIENT config, not a model.
  readonly source: "project" | "claude_user" | "claude_desktop" | "codex";
}

/**
 * `~/.codex/config.toml` — the file `agkit setup --client codex` splices, the last candidate the
 * walk below reads, and the path `agkit mcp print-config` REPORTS as the Codex snippet's target.
 * One spelling, so the file we name to an operator is provably the file we then look in (T-228).
 */
export function codexConfigPath(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

/**
 * The ordered candidate list: project `.mcp.json` (cwd walk-up to the fs root), the
 * user-scope `~/.claude.json` (`claude mcp add -s user`), the Claude desktop config
 * (darwin / win32-with-APPDATA), and the Codex `~/.codex/config.toml`.
 */
export function mcpConfigCandidates(deps: McpDetectDeps): McpConfigCandidate[] {
  const out: McpConfigCandidate[] = [];
  let dir = deps.cwd;
  for (;;) {
    out.push({ path: join(dir, ".mcp.json"), format: "json", source: "project" });
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  out.push({ path: join(deps.homeDir, ".claude.json"), format: "json", source: "claude_user" });
  if (deps.platform === "darwin") {
    out.push({
      path: join(deps.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      format: "json",
      source: "claude_desktop",
    });
  }
  if (deps.platform === "win32" && deps.env.APPDATA) {
    out.push({
      path: join(deps.env.APPDATA, "Claude", "claude_desktop_config.json"),
      format: "json",
      source: "claude_desktop",
    });
  }
  out.push({ path: codexConfigPath(deps.homeDir), format: "toml", source: "codex" });
  return out;
}

/** The detection outcome: `source` is the winning candidate's path (null when none). */
export interface McpRegistration {
  readonly registered: boolean;
  readonly source: string | null;
}

/**
 * EVERYTHING the candidate walk reads: one bounded UTF-8 read, `null` for "not there / not
 * readable". `InstallFs` structurally satisfies it, so `selftest`'s check 8 (which passes the whole
 * housekeeping port) compiles and behaves EXACTLY as before — this is a widening, not a change.
 *
 * WHY IT IS WIDER THAN `InstallFs` (T-228, ruling PR-3/D-7). The housekeeping port's production
 * `readUtf8` is `readUtf8NoFollow`: it opens with `O_NOFOLLOW` and returns `null` on `ELOOP`, so a
 * dotfiles-managed (chezmoi / stow / dotbot) `~/.claude.json` — a symlink — reads as ABSENT. For
 * `selftest` that was soft (check 8 reports `ok:true` either way); for `agkit mcp doctor`, whose
 * whole verdict is "is the integration wired?", it would be a hard exit 2 on a CORRECTLY registered
 * machine. `mcp doctor` therefore hands this parameter a merged reader whose bounded, symlink-
 * FOLLOWING reads come from `runtime.readTextFile`. The NOFOLLOW discipline exists because the
 * housekeeping port also WRITES (staging / lock / swap custody), where a symlink at the target is
 * an attack; a bounded READ of a path derived from homeDir/cwd/platform/env, whose CONTENT is never
 * echoed, carries no such hazard — the same posture T-224 ratified for this exact file (see the
 * narrow user-scope reader's header below).
 */
export type McpConfigReader = Pick<InstallFs, "readUtf8">;

/** Walk the candidates; the FIRST semantically-valid `agkit` entry wins. */
export function detectMcpRegistration(fs: McpConfigReader, deps: McpDetectDeps): McpRegistration {
  for (const cand of mcpConfigCandidates(deps)) {
    let text: string | null;
    try {
      text = fs.readUtf8(cand.path);
    } catch {
      continue; // an unreadable candidate is a skip, never a crash
    }
    // The cap is BYTES, not UTF-16 code units: a non-ASCII config is up to 3x longer on
    // disk than in `String.length`, so measuring units would let it past the bounded parse.
    if (text === null || Buffer.byteLength(text, "utf8") > MCP_CONFIG_MAX_BYTES) continue;
    const hit = cand.format === "json" ? jsonHasAgkitServe(text) : tomlHasAgkitServe(text);
    if (hit) return { registered: true, source: cand.path };
  }
  return { registered: false, source: null };
}

/** JSON candidate: an `mcpServers`/`mcp_servers` entry named `agkit` passing the A11 gate. */
function jsonHasAgkitServe(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false; // malformed → skip
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  for (const key of ["mcpServers", "mcp_servers"]) {
    const servers = obj[key];
    if (servers === null || typeof servers !== "object") continue;
    const entry = (servers as Record<string, unknown>)[MCP_SERVER_ENTRY];
    if (isAgkitServeEntry(entry)) return true;
  }
  return false;
}

/**
 * A11: is `command` a path whose FINAL COMPONENT is an agkit launcher? Windows configs carry
 * backslash paths, which node's posix-aware `basename` will not split — so normalize first.
 * Exported (T-224) because the WRITE side's convergence test asks the same question of the shim
 * it is about to bake in: detector and writer must agree by construction, not by coincidence.
 */
export function isAgkitShimPath(command: string): boolean {
  const base = basename(command.replace(/\\/g, "/")).toLowerCase();
  return base === "agkit" || base === "agkit.cmd" || base === "agkit.exe" || base === "agkit.ps1";
}

/**
 * A11: the entry must resolve to an agkit BINARY (basename `agkit`, or the Windows
 * launcher variants) with args EXACTLY ["mcp","serve"] — never "references agkit".
 */
export function isAgkitServeEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  if (!isServeArgv(args)) return false;
  return isAgkitShimPath(command);
}

/** `args` is EXACTLY the serve argv — the shared constant, never a retyped pair. */
export function isServeArgv(args: unknown): boolean {
  return (
    Array.isArray(args) &&
    args.length === CODEX_SERVE_ARGS.length &&
    CODEX_SERVE_ARGS.every((token, i) => args[i] === token)
  );
}

/**
 * Codex TOML candidate — a CONSERVATIVE assignment scan (no TOML parser dependency): the
 * `[mcp_servers.agkit]` section must exist AND its OWN body (up to the next section
 * header) must ASSIGN `command` + `args` that pass the same A11 gate the JSON path uses.
 * Content in a different server's section never counts, a commented-out body never counts,
 * and any value shape this scanner cannot read fails CLOSED (a miss, never a false hit).
 */
function tomlHasAgkitServe(text: string): boolean {
  const body = agkitSectionBody(text);
  let command: string | null = null;
  let args: readonly string[] | null = null;
  for (let n = 0; n < body.length; n += 1) {
    const trimmed = body[n]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue; // a commented-out entry is not a registration
    const assign = /^(command|args)\s*=(.*)$/.exec(trimmed); // bare keys only; a quoted key is a miss
    if (assign === null) continue;
    if (assign[1] === "command") {
      command = tomlStringValue(assign[2]!);
      continue;
    }
    // An array literal may wrap, so `args` reads from its `=` to the end of the section.
    args = tomlStringArrayValue([assign[2]!, ...body.slice(n + 1)].join("\n"));
  }
  return isAgkitServeEntry({ command, args });
}

/** The body lines of the FIRST `[mcp_servers.agkit]` section, up to the next header. */
function agkitSectionBody(text: string): string[] {
  let inSection = false;
  const body: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      if (inSection) break; // the section ended at the next header
      inSection = /^\[mcp_servers\.agkit\]$/.test(trimmed);
      continue;
    }
    if (inSection) body.push(line);
  }
  return body;
}

/**
 * Read one single-line TOML basic (`"…"`) or literal (`'…'`) string at `start`. The
 * multi-line (`"""`/`'''`) forms and invalid escapes are REFUSED rather than guessed at —
 * a value we cannot read exactly must not be allowed to satisfy the A11 gate.
 */
function readTomlString(src: string, start: number): { value: string; end: number } | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") return null;
  if (src.startsWith(quote.repeat(3), start)) return null;
  let out = "";
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === quote) return { value: out, end: i + 1 };
    if (ch === "\n") return null; // a single-line string never crosses a newline
    if (quote === "'" || ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = src[i + 1];
    if (esc === "u" || esc === "U") {
      const width = esc === "u" ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff) return null;
      out += String.fromCodePoint(cp);
      i += 2 + width;
      continue;
    }
    const simple = TOML_ESCAPES[esc ?? ""];
    if (simple === undefined) return null;
    out += simple;
    i += 2;
  }
  return null; // unterminated on its line
}

/** The single-character escapes TOML basic strings admit; anything else is malformed. */
const TOML_ESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Only whitespace and a trailing `#` comment may follow a value on ITS line. */
function isValueTail(rest: string): boolean {
  const trimmed = rest.split("\n", 1)[0]!.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** Advance past the whitespace, newlines and `#` comments a TOML array may contain. */
function skipArrayGap(src: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
    if (src[i] !== "#") return i;
    const nl = src.indexOf("\n", i);
    if (nl === -1) return src.length;
    i = nl + 1;
  }
}

/** `raw` (everything right of `=`) as a lone TOML string; null when it is anything else. */
function tomlStringValue(raw: string): string | null {
  const src = raw.trimStart();
  const read = readTomlString(src, 0);
  if (read === null || !isValueTail(src.slice(read.end))) return null;
  return read.value;
}

/** `raw` as a TOML array of strings, order preserved; null when it is anything else. */
function tomlStringArrayValue(raw: string): string[] | null {
  const src = raw.trimStart();
  if (src[0] !== "[") return null;
  const out: string[] = [];
  let i = 1;
  for (;;) {
    i = skipArrayGap(src, i);
    if (src[i] === "]") return isValueTail(src.slice(i + 1)) ? out : null;
    const read = readTomlString(src, i);
    if (read === null) return null;
    out.push(read.value);
    i = skipArrayGap(src, read.end);
    if (src[i] === ",") {
      i += 1;
      continue;
    }
    if (src[i] === "]") return isValueTail(src.slice(i + 1)) ? out : null;
    return null; // an unterminated or non-string array is a miss
  }
}

// ── the WRITE side's snippets (T-224) ───────────────────────────────────────────────────
//
// THE SEAM: these two functions are the ONLY place the registration bytes are spelled out.
// `agkit setup` prints them when it cannot write a client's config itself (no `claude`
// binary on PATH, a refused TOML edit), and T-228's `print-config` will render them for its
// absolute-path variants — one source, so an instruction we PRINT can never describe a
// registration different from the one we WRITE. The TOML half calls the same emitter the
// splice writes with (`codexServerTable`), and the argv is the shared `CODEX_SERVE_ARGS`
// constant that `isAgkitServeEntry` above gates on.
//
// DISPLAY QUOTING ONLY. `claudeMcpAddCommand` returns a line for a human to paste; the CLI
// itself runs `claude` through the `runChild` seam with RAW argv and no shell, so the
// quoting here is never an injection surface.

/**
 * The `claude mcp add` line that registers this server at USER scope with an absolute binary
 * path. `-s user` is deliberate: a project-scope entry would follow the repo, while `setup`
 * provisions the developer's machine.
 *
 * The quoting follows the shell the PASTER will use: `cmd.exe` rules on win32 (double quotes;
 * a token cmd cannot quote faithfully is REFUSED), POSIX single-quote rules everywhere else —
 * a Windows shim path rendered in POSIX quotes would paste as a different command.
 */
export function claudeMcpAddCommand(absBin: string, platform: NodeJS.Platform): string {
  const quote = platform === "win32" ? shellQuoteWin : shellQuotePosix;
  return ["claude", "mcp", "add", MCP_SERVER_ENTRY, "-s", "user", "--", absBin, ...CODEX_SERVE_ARGS]
    .map(quote)
    .join(" ");
}

/**
 * The `[mcp_servers.agkit]` block for `~/.codex/config.toml`, one trailing LF — byte-identical
 * to what `spliceCodexConfig` writes into that file.
 */
export function codexServerBlock(absBin: string): string {
  return `${codexServerTable(absBin)}\n`;
}

// ── the NARROW user-scope reader (T-224 D4v2) ───────────────────────────────────────────
//
// `detectMcpRegistration` above is a DIAGNOSTIC: it walks every candidate a host might use and
// answers "is agkit registered anywhere?". That is the wrong question for a WRITER. `setup`
// reconciles exactly ONE file — the user-scope `~/.claude.json` that `claude mcp add -s user`
// owns — so it reads exactly that file, and it reads the ENTRY, not a boolean: convergence,
// the reproducibility gate, and the private custody snapshot all need the members themselves.
//
// The bytes arrive through the command layer's follow-READ seam (a dotfiles-managed
// `~/.claude.json` must be read THROUGH its link, never misread as empty and then "reconciled"
// by clobbering it), so this function takes TEXT and stays pure.

/** `~/.claude.json` — the file `claude mcp add -s user` writes. */
export function claudeUserConfigPath(homeDir: string): string {
  return join(homeDir, ".claude.json");
}

/** The user-scope `agkit` entry as READ — never as judged. */
export type ClaudeUserEntry =
  /** No file, no `mcpServers` table, or no `agkit` key in it. */
  | { readonly status: "absent" }
  /** The file exists but we cannot locate the entry safely — we touch NOTHING in this state. */
  | { readonly status: "unreadable"; readonly reason: "malformed_json" | "not_an_object" | "entry_not_an_object" }
  | { readonly status: "present"; readonly entry: Readonly<Record<string, unknown>> };

/**
 * Read the `mcpServers.agkit` entry out of a `~/.claude.json` document.
 *
 * Both spellings are accepted on READ (`mcpServers` is what Claude writes; `mcp_servers` is the
 * tolerant alias the detector above already honors) — but note the caller never WRITES this file:
 * every mutation goes through the `claude` CLI, which owns the schema.
 */
export function claudeUserAgkitEntry(text: string): ClaudeUserEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable", reason: "malformed_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", reason: "not_an_object" };
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of ["mcpServers", "mcp_servers"]) {
    const servers = obj[key];
    if (servers === null || typeof servers !== "object" || Array.isArray(servers)) continue;
    if (!Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_ENTRY)) continue;
    const entry = (servers as Record<string, unknown>)[MCP_SERVER_ENTRY];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { status: "unreadable", reason: "entry_not_an_object" };
    }
    return { status: "present", entry: entry as Record<string, unknown> };
  }
  return { status: "absent" };
}

// ── the ABSOLUTE-shim resolution ladder (T-224 D4) ──────────────────────────────────────
//
// Whatever we register must be an ABSOLUTE path whose basename is an agkit launcher: a relative
// path or an `npx` invocation is FORBIDDEN (it would resolve differently, or not at all, in the
// host's environment), and a realpath'd `dist/cli.js` would fail our OWN detector (`isAgkitShimPath`)
// and selftest check 8 — so the shim is NEVER resolved through its symlink.

/** Everything the ladder may consult. All injected — no `process`, no `node:fs`. */
export interface AgkitBinDeps {
  /** `process.argv[1]` — the path the shell invoked us through (a shim, or a bundle in dev). */
  readonly argv1: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** lstat-only fs probe (the housekeeping port), so a PATH walk needs no new seam. */
  readonly fs: InstallFs;
}

/** The Windows launcher extensions to try when PATHEXT says nothing useful. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Walk `PATH` for an executable named `name`, returning an ABSOLUTE path or null.
 *
 * Only ABSOLUTE `PATH` entries are considered: a relative entry (`.`, `bin`) resolves against a
 * cwd we do not control and could never yield a registration we are willing to bake in. A
 * candidate counts when it exists as a regular file OR a symlink — a global npm shim is usually
 * the latter, and we deliberately do NOT resolve it (see above).
 */
export function resolvePathBinary(name: string, deps: AgkitBinDeps): string | null {
  const win = deps.platform === "win32";
  const raw = deps.env.PATH ?? deps.env.Path ?? "";
  if (raw === "") return null;
  const exts = win ? pathExtensions(deps.env.PATHEXT) : [""];
  for (const dir of raw.split(win ? ";" : ":")) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      const st = deps.fs.lstat(candidate);
      if (st !== null && (st.isFile() || st.isSymbolicLink())) return candidate;
    }
  }
  return null;
}

/** PATHEXT, deduped, in BOTH the declared case and lowercase (npm ships `.cmd`, not `.CMD`). */
function pathExtensions(pathext: string | undefined): string[] {
  const declared = (pathext === undefined || pathext.trim() === "" ? DEFAULT_PATHEXT : pathext)
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext !== "");
  const out: string[] = [];
  for (const ext of declared) {
    for (const form of [ext, ext.toLowerCase()]) if (!out.includes(form)) out.push(form);
  }
  return out;
}

/**
 * The absolute `agkit` shim to register, or null when there is none we would stand behind.
 *
 *   1. We were invoked THROUGH a shim (`basename(argv1)` is an agkit launcher) — resolve it to an
 *      absolute path and use it VERBATIM. Never `realpath`: the shim is the stable, host-visible
 *      name; its target is `dist/cli.js`, which our own detector rejects.
 *   2. Otherwise walk `PATH` for `agkit` (plus PATHEXT on Windows) — the ordinary dev-build case,
 *      where argv1 is `node …/dist/cli.js` but a released `agkit` is nonetheless installed.
 *   3. Otherwise NULL. The caller reports a `manual` leg with the exact command to paste; it never
 *      invents a relative path or an `npx` line (honor-or-reject).
 */
export function resolveAgkitBin(deps: AgkitBinDeps): string | null {
  if (deps.argv1 !== undefined && deps.argv1 !== "" && isAgkitShimPath(deps.argv1)) {
    return resolve(deps.argv1);
  }
  return resolvePathBinary("agkit", deps);
}
