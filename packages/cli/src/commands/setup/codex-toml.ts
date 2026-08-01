// T-224 D6 / D6v2 — the Codex `config.toml` surgeon. PURE: string in, string out. No fs, no env,
// no process. The atomic follow-write seam is the command layer's; this module only decides BYTES.
//
// NO TOML DEPENDENCY, IN EITHER DIRECTION. The repo ships none and this ticket adds none: the
// emitted shape is exactly what the existing conservative scanner (`core/mcp/registration.ts`
// `tomlHasAgkitServe`) can re-read, and the tests re-parse every output with an INDEPENDENT parser
// (`smol-toml`, a devDependency — never shipped) so "we can read our own output" is never the only
// evidence that the output is valid TOML.
//
// SURGICAL AND FAIL-CLOSED. The file belongs to the user: every byte outside the tables we own is
// preserved verbatim, and any shape this conservative scanner cannot interpret EXACTLY refuses the
// whole edit (`CodexConfigError`, zero output) rather than guessing. Concretely it refuses:
// duplicate `[mcp_servers.agkit]` (or duplicate target tool-table) headers, a non-canonical
// spelling of any header inside our own `mcp_servers` namespace (quoted keys, array-of-tables,
// odd spacing), a dotted-key or inline-table definition of the server, a multi-line string, and
// any statement whose extent it cannot determine. A refusal costs the user one manual paste; a
// wrong guess costs them their config.
//
// "CANONICAL SPELLING" MEANS THE WHOLE LINE, comment included — MEASURED, not stylistic. The
// shipped detector recognizes a section header with `/^\[.*\]$/`, so `[mcp_servers.agkit] # mine`
// is INVISIBLE to it: writing into such a file would produce a registration the CLI itself then
// reports as absent, and `--check` would report drift forever. Refusing is the honest answer.
//
// THE SCANNER IS A WRITER'S SCANNER, and that is why it is not `registration.ts`'s reader: the
// reader DECODES the two values the A11 gate judges, while this one locates STATEMENT SPANS so an
// edit can replace exactly one of them and leave the rest of the file alone. Both are deliberately
// conservative in the same direction — a shape they cannot read is a refusal, never a hit.

// ── the shape we own ──────────────────────────────────────────────────────────────────────
//
// Named ONCE here; `codexServerTable` / `codexToolTable` are the only renderers, and
// `core/mcp/registration.ts` calls THEM for its display snippets rather than retyping the block.
// `CODEX_SERVE_ARGS` mirrors the argv `isAgkitServeEntry` (registration.ts) gates on — the detector
// and the writer must agree by construction, which is what the round-trip test proves.

/** The dotted path of the agkit server table. */
export const CODEX_SERVER_PATH = ["mcp_servers", "agkit"] as const;
/** The sub-table each per-tool approval lives under. */
export const CODEX_TOOLS_KEY = "tools";
/** The argv an MCP host runs — the CLI's one stdout-takeover command. */
export const CODEX_SERVE_ARGS = ["mcp", "serve"] as const;
/** The approval mode a read-only tool gets. (`approve` = the host may run it without asking.) */
export const CODEX_APPROVAL_MODE = "approve";
/** The key that carries it. */
export const CODEX_APPROVAL_KEY = "approval_mode";

const SERVER_DOTTED = CODEX_SERVER_PATH.join(".");
const NAMESPACE_ROOT = CODEX_SERVER_PATH[0];
const SERVER_KEY = CODEX_SERVER_PATH[1];
/** `[mcp_servers.agkit]` — the exact header this module writes and re-recognizes. */
export const CODEX_SERVER_HEADER = `[${SERVER_DOTTED}]`;
const TOOLS_DOTTED = `${SERVER_DOTTED}.${CODEX_TOOLS_KEY}`;

// ── refusals ──────────────────────────────────────────────────────────────────────────────

/** Why an edit refused. The command layer maps these to an honest `refused` leg detail. */
export type CodexConfigRefusal =
  /** More than one `[mcp_servers.agkit]` header — which of them is ours is not knowable. */
  | "duplicate_server_table"
  /** More than one `[mcp_servers.agkit.tools.<tool>]` header for a tool we were asked to approve. */
  | "duplicate_tool_table"
  /** A header inside our namespace spelled in a form other than the exact canonical one. */
  | "ambiguous_header"
  /** A header line this scanner cannot parse at all. */
  | "unreadable_header"
  /** A statement whose key or value extent this scanner cannot determine. */
  | "unreadable_assignment"
  /** The same key assigned twice inside one section (invalid TOML; never silently "fixed"). */
  | "duplicate_assignment"
  /** A multi-line (`"""`/`'''`) string — a line-oriented editor cannot bound it safely. */
  | "multiline_string"
  /** The server (or one of its tool tables) defined as a key / inline table rather than a section. */
  | "inline_definition"
  /** A requested tool name that is not a bare TOML key, or a duplicate in the request. */
  | "invalid_tool_name"
  /** An empty binary path — `command = ""` would be a lie on the wire. */
  | "invalid_bin"
  /** A display token no shell quoting can render safely (control char, cmd expansion). */
  | "unsafe_display_token";

/** A refused edit. Thrown, never returned: a partial TOML edit has no honest representation. */
export class CodexConfigError extends Error {
  override name = "CodexConfigError";
  constructor(
    readonly reason: CodexConfigRefusal,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (reason: CodexConfigRefusal, message: string): CodexConfigError =>
  new CodexConfigError(reason, message);

// ── value serialization ───────────────────────────────────────────────────────────────────

/** C0 controls + DEL. TOML basic strings must escape every one of them (tab included here: `\t`
 *  round-trips through `registration.ts`'s reader, and escaping is always legal). */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\\\"],
  ['"', '\\"'],
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
]);

/**
 * Serialize `value` as a TOML BASIC string, quotes included. Escapes `\` and `"` first, then every
 * control character — the named escape where TOML has one, `\u00XX` otherwise. A Windows path
 * (`C:\Program Files\agkit.cmd`) therefore emits with doubled backslashes and reads back
 * byte-identical through the `registration.ts` scanner, which is the round-trip the tests pin.
 */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const simple = SIMPLE_ESCAPES.get(ch);
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    if (CONTROL_CHAR.test(ch)) {
      out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

// ── display quoting (NEVER used to build argv) ────────────────────────────────────────────
//
// These quote a token for a command line a HUMAN pastes. Child processes always receive raw argv
// through the `runChild` seam — no shell — so nothing here can become an injection surface. The
// POSIX rule is `core/plan/invocation.ts`'s `quoteToken` rule (safe token bare, otherwise
// single-quoted); it is restated rather than imported so this pure module carries no dependency on
// the plan-hint encoder, whose mandatory `agkit …` prefix is not ours.

/** The token class that needs no quoting in a POSIX shell. */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** The `cmd.exe`-safe class: adds `\` (path separator), drops the shell-expansion characters. */
const WIN_SAFE = /^[A-Za-z0-9_@+=:,./\\-]+$/;

/** POSIX: a safe token bare, anything else single-quoted with the `'"'"'` escape. */
export function shellQuotePosix(token: string): string {
  if (CONTROL_CHAR.test(token)) {
    throw refuse("unsafe_display_token", "shell token carries a control character");
  }
  if (token.length > 0 && POSIX_SAFE.test(token)) return token;
  return `'${token.split("'").join(`'"'"'`)}'`;
}

/**
 * `cmd.exe`: a safe token bare, anything else double-quoted. Quoting neutralizes spaces and the
 * `& | < > ( ) ^` metacharacters, but NOT `%VAR%` / `!VAR!` expansion and not an embedded `"` —
 * cmd has no in-quote escape for those, so a token carrying one is REFUSED rather than rendered as
 * a line that would silently mean something else when pasted. (Caret escaping is not the fix the
 * name suggests: `^` is literal inside a quoted region, and the token needs the quotes.)
 */
export function shellQuoteWin(token: string): string {
  if (CONTROL_CHAR.test(token)) {
    throw refuse("unsafe_display_token", "shell token carries a control character");
  }
  if (token.length > 0 && WIN_SAFE.test(token)) return token;
  if (/["%!]/.test(token)) {
    throw refuse("unsafe_display_token", 'cmd.exe cannot quote a token containing ", % or !');
  }
  return `"${token}"`;
}

// ── the canonical emission (THE single source, reused by registration.ts) ─────────────────

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** `command = "<abs>"` — the exact line `tomlHasAgkitServe` re-reads. */
export function codexCommandLine(absBin: string): string {
  if (absBin.trim() === "") throw refuse("invalid_bin", "the agkit binary path is empty");
  return `command = ${tomlBasicString(absBin)}`;
}

/** `args = ["mcp", "serve"]` — rendered from the shared constant, never retyped. */
export function codexArgsLine(): string {
  return `args = [${CODEX_SERVE_ARGS.map(tomlBasicString).join(", ")}]`;
}

/**
 * THE `[mcp_servers.agkit]` block. Single-sourced: the splice below and
 * `core/mcp/registration.ts`'s `codexServerBlock` (the manual-snippet leg, and T-228's
 * `print-config`) both render THIS function, so a printed snippet can never drift from what
 * `agkit setup` actually writes.
 */
export function codexServerTable(absBin: string): string {
  return [CODEX_SERVER_HEADER, codexCommandLine(absBin), codexArgsLine()].join("\n");
}

/** The canonical header of one tool's approval table. */
export function codexToolHeader(tool: string): string {
  if (!BARE_KEY.test(tool)) throw refuse("invalid_tool_name", `tool name is not a bare TOML key: ${tool}`);
  return `[${TOOLS_DOTTED}.${tool}]`;
}

/** One `[mcp_servers.agkit.tools.<tool>]` / `approval_mode = "approve"` table. */
export function codexToolTable(tool: string): string {
  return [codexToolHeader(tool), approvalLine()].join("\n");
}

const approvalLine = (): string => `${CODEX_APPROVAL_KEY} = ${tomlBasicString(CODEX_APPROVAL_MODE)}`;

// ── the conservative statement scanner ────────────────────────────────────────────────────

interface HeaderStatement {
  readonly kind: "header";
  readonly line: number;
  /** The header LINE exactly as written, trimmed — a trailing comment included (see below). */
  readonly raw: string;
  readonly path: readonly string[];
  readonly arrayOfTables: boolean;
}
interface AssignStatement {
  readonly kind: "assignment";
  /** The NORMALIZED key path: `command` → ["command"]; `a.b` / `"a".b` → ["a", "b"]. */
  readonly path: readonly string[];
  /** The TOML shape of the value, so a key we REPLACE can be required to already hold its type. */
  readonly valueKind: ValueKind;
  /** Column on `start` where the VALUE begins — lets an owned array be re-walked element-wise. */
  readonly valueCol: number;
  /** Inclusive line range the statement occupies (a wrapped array spans several). */
  readonly start: number;
  readonly end: number;
}
type Statement = HeaderStatement | AssignStatement;

const stripCr = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** Only whitespace or a `#` comment may follow a value / header on its own line. */
function requireTail(rest: string, line: number): void {
  const trimmed = rest.trim();
  if (trimmed !== "" && !trimmed.startsWith("#")) {
    throw refuse("unreadable_assignment", `line ${line + 1}: unexpected text after a value`);
  }
}

/** Index just past the closing quote of the single-line string at `start`; -1 when unterminated. */
function skipString(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote === '"' && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

const KEY_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  '"': '"',
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Decode a QUOTED key part (header or assignment). An escape we do not know refuses. */
function readQuotedKey(
  text: string,
  start: number,
  reason: CodexConfigRefusal = "unreadable_header",
): { value: string; end: number } {
  const quote = text[start]!;
  if (text.startsWith(quote.repeat(3), start)) throw refuse(reason, "multi-line quoted key");
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === quote) return { value: out, end: i + 1 };
    if (quote === "'" || ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const esc = text[i + 1] ?? "";
    if (esc === "u" || esc === "U") {
      const width = esc === "u" ? 4 : 8;
      const hex = text.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw refuse(reason, "malformed unicode escape in a key");
      }
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff) throw refuse(reason, "out-of-range unicode escape in a key");
      out += String.fromCodePoint(cp);
      i += 2 + width;
      continue;
    }
    const simple = KEY_ESCAPES[esc];
    if (simple === undefined) throw refuse(reason, `unknown escape in a key: \\${esc}`);
    out += simple;
    i += 2;
  }
  throw refuse(reason, "unterminated quoted key");
}

const skipSpaces = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
};

/** Parse a header line into its normalized dotted path. Refuses anything it cannot read exactly. */
function parseHeader(text: string, line: number): { path: string[]; arrayOfTables: boolean } {
  const where = `line ${line + 1}`;
  let i = 1; // the leading "[" is the caller's precondition
  const arrayOfTables = text[i] === "[";
  if (arrayOfTables) i += 1;
  const path: string[] = [];
  for (;;) {
    i = skipSpaces(text, i);
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const read = readQuotedKey(text, i);
      path.push(read.value);
      i = read.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (bare === null) throw refuse("unreadable_header", `${where}: unreadable table key`);
      path.push(bare[0]);
      i += bare[0].length;
    }
    i = skipSpaces(text, i);
    if (text[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  if (text[i] !== "]") throw refuse("unreadable_header", `${where}: unterminated table header`);
  i += 1;
  if (arrayOfTables) {
    if (text[i] !== "]") throw refuse("unreadable_header", `${where}: unterminated array-of-tables header`);
    i += 1;
  }
  requireTail(text.slice(i), line);
  return { path, arrayOfTables };
}

/** The value shapes the scanner distinguishes. Only the first two may ever be REPLACED. */
type ValueKind = "string" | "array" | "inline-table" | "primitive";

/** The last line index of the value that starts at `col` on `startLine`, plus its TOML shape. */
function scanValue(lines: readonly string[], startLine: number, col: number): { end: number; kind: ValueKind } {
  const first = stripCr(lines[startLine]!);
  const rest = first.slice(col);
  const head = rest.trimStart();
  const offset = col + (rest.length - head.length);
  if (head.startsWith('"""') || head.startsWith("'''")) {
    throw refuse("multiline_string", `line ${startLine + 1}: multi-line strings cannot be edited safely`);
  }
  const lead = head[0];
  if (lead === undefined || lead === "#") {
    throw refuse("unreadable_assignment", `line ${startLine + 1}: assignment has no value`);
  }
  if (lead === '"' || lead === "'") {
    const end = skipString(first, offset);
    if (end < 0) throw refuse("unreadable_assignment", `line ${startLine + 1}: unterminated string value`);
    requireTail(first.slice(end), startLine);
    return { end: startLine, kind: "string" };
  }
  if (lead === "[" || lead === "{") {
    return { end: scanBracketed(lines, startLine, offset), kind: lead === "[" ? "array" : "inline-table" };
  }
  const value = head.split("#", 1)[0]!.trim();
  if (value === "") {
    throw refuse("unreadable_assignment", `line ${startLine + 1}: assignment has no value`);
  }
  // TOML's unquoted-value grammar is CLOSED (booleans, numbers, dates/times) — so a value that
  // matches none of it is a shape we do not understand, and editing around (or over) a statement
  // we could not read would be a guess. The regexes are marginally loose (a superset of the spec)
  // on purpose: over-acceptance of one-line junk costs nothing HERE (the span is still exact, and
  // a foreign statement is only ever stepped over), while under-acceptance would refuse a valid
  // config. Nothing we REWRITE rests on this looseness — an owned key must pass `requireValueKind`,
  // which admits only the exact TOML type we are about to write.
  if (!isTomlPrimitive(value)) {
    throw refuse("unreadable_assignment", `line ${startLine + 1}: unrecognized value shape`);
  }
  return { end: startLine, kind: "primitive" };
}

const PRIMITIVE_SHAPES: readonly RegExp[] = [
  /^(?:true|false)$/,
  /^[+-]?(?:inf|nan)$/,
  /^[+-]?(?:0[xob][0-9A-Za-z_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)$/,
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/,
  /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/,
];

const isTomlPrimitive = (value: string): boolean => PRIMITIVE_SHAPES.some((shape) => shape.test(value));

/**
 * Walk a bracketed value (array / inline table) to its balancing delimiter, across lines. A STACK,
 * not a depth counter: each closer must match its own opener, so `[}` is the refusal it should be
 * rather than a "balanced" pair we then edit around.
 */
function scanBracketed(lines: readonly string[], startLine: number, col: number): number {
  const open: ("]" | "}")[] = [];
  for (let ln = startLine; ln < lines.length; ln += 1) {
    const text = stripCr(lines[ln]!);
    let i = ln === startLine ? col : 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "#") break; // the rest of the line is a comment
      if (ch === '"' || ch === "'") {
        if (text.startsWith(ch.repeat(3), i)) {
          throw refuse("multiline_string", `line ${ln + 1}: multi-line string inside a value`);
        }
        const end = skipString(text, i);
        if (end < 0) throw refuse("unreadable_assignment", `line ${ln + 1}: unterminated string in a value`);
        i = end;
        continue;
      }
      if (ch === "[" || ch === "{") {
        open.push(ch === "[" ? "]" : "}");
        i += 1;
        continue;
      }
      if (ch === "]" || ch === "}") {
        if (open.pop() !== ch) {
          throw refuse("unreadable_assignment", `line ${ln + 1}: mismatched value delimiter`);
        }
        i += 1;
        if (open.length === 0) {
          requireTail(text.slice(i), ln);
          return ln;
        }
        continue;
      }
      i += 1;
    }
  }
  throw refuse("unreadable_assignment", `line ${startLine + 1}: unterminated value`);
}

/**
 * Parse an assignment's KEY — a dot-separated sequence of bare or quoted parts, then `=` — and
 * return the normalized path plus the column the value starts at. `null` when the line is not an
 * assignment at all. Foreign sections of a real config legitimately carry dotted and quoted keys
 * (`tools.web_search = true` is a documented Codex setting), so the SCANNER must read them all;
 * whether a key may touch OUR namespace is `assertUnambiguous`'s judgement, not a parse error.
 */
function readAssignmentKey(raw: string): { path: string[]; valueCol: number } | null {
  let i = skipSpaces(raw, 0);
  const path: string[] = [];
  for (;;) {
    i = skipSpaces(raw, i);
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const read = readQuotedKey(raw, i, "unreadable_assignment");
      path.push(read.value);
      i = read.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(raw.slice(i));
      if (bare === null) return null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    i = skipSpaces(raw, i);
    if (raw[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  if (raw[i] !== "=") return null;
  return { path, valueCol: i + 1 };
}

/** Every statement in the document, in order. Throws on the first shape it cannot read. */
function scanStatements(lines: readonly string[]): Statement[] {
  const out: Statement[] = [];
  let i = 0;
  while (i < lines.length) {
    const text = stripCr(lines[i]!).trim();
    if (text === "" || text.startsWith("#")) {
      i += 1;
      continue;
    }
    if (text.startsWith("[")) {
      out.push({ kind: "header", line: i, raw: text, ...parseHeader(text, i) });
      i += 1;
      continue;
    }
    const assign = readAssignmentKey(stripCr(lines[i]!));
    if (assign === null) {
      throw refuse("unreadable_assignment", `line ${i + 1}: not a key assignment`);
    }
    const { end, kind } = scanValue(lines, i, assign.valueCol);
    out.push({ kind: "assignment", path: assign.path, start: i, end, valueKind: kind, valueCol: assign.valueCol });
    i = end + 1;
  }
  return out;
}

// ── sections ──────────────────────────────────────────────────────────────────────────────

interface Section {
  /** null for the ROOT region (statements before the first header). */
  readonly path: readonly string[] | null;
  /** The header line as written, trimmed ("" for the root region). */
  readonly header: string;
  readonly headerLine: number;
  readonly arrayOfTables: boolean;
  readonly assignments: readonly AssignStatement[];
  /** Exclusive end of the section's body (the next header line, or EOF). */
  readonly bodyEnd: number;
}

function toSections(statements: readonly Statement[], lineCount: number): Section[] {
  const out: Section[] = [];
  let head: Omit<Section, "assignments" | "bodyEnd"> = {
    path: null,
    header: "",
    headerLine: -1,
    arrayOfTables: false,
  };
  let assignments: AssignStatement[] = [];
  for (const statement of statements) {
    if (statement.kind === "assignment") {
      assignments.push(statement);
      continue;
    }
    out.push({ ...head, assignments, bodyEnd: statement.line });
    head = {
      path: statement.path,
      header: statement.raw,
      headerLine: statement.line,
      arrayOfTables: statement.arrayOfTables,
    };
    assignments = [];
  }
  out.push({ ...head, assignments, bodyEnd: lineCount });
  return out;
}

const samePath = (a: readonly string[] | null, b: readonly string[]): boolean =>
  a !== null && a.length === b.length && a.every((part, i) => part === b[i]);

/** One key per section, at most once — a repeat is invalid TOML and never silently rewritten. */
function assignmentFor(section: Section, key: string): AssignStatement | null {
  const hits = section.assignments.filter((a) => a.path.length === 1 && a.path[0] === key);
  if (hits.length > 1) {
    throw refuse(
      "duplicate_assignment",
      `'${key}' is assigned more than once in ${section.header === "" ? "the root table" : section.header}`,
    );
  }
  return hits[0] ?? null;
}

/**
 * The gate between RECOGNIZING a statement and REPLACING it.
 *
 * `PRIMITIVE_SHAPES` is a deliberate superset — it accepts `0xGARBAGE`, `0b222`, and impossible
 * dates — because its only job for FOREIGN statements is to find where the value ends so the
 * statement can be stepped over untouched. That looseness is harmless there and load-bearing
 * nowhere else. It is NOT harmless for a key we overwrite: `command = 0xGARBAGE` is not a config
 * we read, it is a config we failed to read, and rewriting a section we did not validly parse is
 * exactly the silent-corruption this surgeon exists to prevent. So every owned key must already
 * hold the TOML TYPE we are about to write — string for `command`/`approval_mode` (basic OR
 * literal: `command = 'C:\bin\agkit'` is a valid config), array for `args` — or we refuse.
 */
function requireValueKind(found: AssignStatement, key: string, want: "string" | "array"): void {
  if (found.valueKind !== want) {
    throw refuse(
      "unreadable_assignment",
      `line ${found.start + 1}: '${key}' must already hold ${want === "array" ? "an array" : "a string"}`,
    );
  }
}

/**
 * The SAME gate, one nesting level down — because `[` … `]` bounds a span without saying a word
 * about what is inside it (relay addendum B1). `args = [0xGARBAGE]`, `args = [{x=1}]`, and
 * `args = [1]` all bound cleanly and would otherwise be replaced wholesale, which is the exact
 * "edit a section we did not validly parse" the outer gate exists to stop.
 *
 * `args` is an argv. A list of strings is its TYPE, not a schema preference we are imposing —
 * anything else is not a value we can claim to have read as "the server's arguments", so we
 * refuse and say why rather than silently substitute over it. Comments, newlines and a trailing
 * comma are all legal TOML and all accepted; only the ELEMENTS are constrained.
 */
function requireStringArray(lines: readonly string[], found: AssignStatement, key: string): void {
  const bad = (why: string, line: number): never =>
    refuseThrow("unreadable_assignment", `line ${line + 1}: '${key}' must be an array of strings (${why})`);
  let ln = found.start;
  let col = skipSpaces(stripCr(lines[ln]!), found.valueCol);
  col += 1; // past the `[` — guaranteed present, the caller checked valueKind === "array"
  let wantValue = true; // true = a string or the close; false = a comma or the close
  for (;;) {
    if (ln > found.end) bad("unterminated", found.start); // unreachable: the span is balanced
    const text = stripCr(lines[ln]!);
    col = skipSpaces(text, col);
    const ch = text[col];
    if (ch === undefined || ch === "#") {
      ln += 1; // end of line (or a comment tail) — elements may continue on the next one
      col = 0;
      continue;
    }
    if (ch === "]") {
      requireTail(text.slice(col + 1), ln);
      return;
    }
    if (ch === ",") {
      if (wantValue) bad("empty element", ln);
      wantValue = true;
      col += 1;
      continue;
    }
    if (!wantValue) bad("missing comma between elements", ln);
    if (ch !== '"' && ch !== "'") bad("a non-string element", ln);
    // Redundant today, kept deliberately: `scanBracketed` already refused any `"""`/`'''` in this
    // span under the precise `multiline_string` reason, so the document-wide policy lives THERE.
    // A multi-line string IS legal TOML; a line-oriented editor refusing one (fail-closed, zero
    // output) is a real, documented limit. This keeps the walker correct standing alone.
    if (text.startsWith('"""', col) || text.startsWith("'''", col)) bad("a multi-line string element", ln);
    const end = skipString(text, col);
    if (end < 0) bad("an unterminated string element", ln);
    col = end;
    wantValue = false;
  }
}

/** `refuse` builds the error; this throws it, so the walker above reads as an expression. */
function refuseThrow(reason: CodexConfigRefusal, detail: string): never {
  throw refuse(reason, detail);
}

// ── the splice ────────────────────────────────────────────────────────────────────────────

interface Edit {
  /** Inclusive replace range; `end = start - 1` means "insert before `start`". */
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

/** Where a new assignment goes inside an existing section: after its last non-blank body line. */
function appendPointIn(lines: readonly string[], section: Section): number {
  for (let i = section.bodyEnd - 1; i > section.headerLine; i -= 1) {
    if (stripCr(lines[i]!).trim() !== "") return i + 1;
  }
  return section.headerLine + 1;
}

/** Refuse every ambiguous shape inside our own namespace BEFORE a single byte is planned. */
function assertUnambiguous(sections: readonly Section[], tools: readonly string[]): void {
  for (const section of sections) {
    // A DOTTED key whose full path lands on (or inside) `mcp_servers.agkit` defines server state
    // outside the canonical section — a section surgeon cannot edit it, and TOML forbids a later
    // `[header]` from redefining a dotted-defined table, so our append could collide with it.
    // Foreign dotted keys (`tools.web_search`, `mcp_servers.other.command`) pass through verbatim.
    for (const a of section.assignments) {
      if (a.path.length < 2) continue;
      const full = [...(section.path ?? []), ...a.path];
      if (full[0] === NAMESPACE_ROOT && full[1] === SERVER_KEY) {
        throw refuse("inline_definition", `'${full.join(".")}' is defined with a dotted key, not as a table`);
      }
    }
    if (section.path === null) {
      if (assignmentFor(section, NAMESPACE_ROOT) !== null) {
        throw refuse("inline_definition", `'${NAMESPACE_ROOT}' is defined as a root key, not as a table`);
      }
      continue;
    }
    if (section.path[0] !== NAMESPACE_ROOT) continue;
    if (section.arrayOfTables) {
      throw refuse("ambiguous_header", `array-of-tables header inside the agkit namespace: ${section.header}`);
    }
    if (samePath(section.path, [NAMESPACE_ROOT]) && assignmentFor(section, SERVER_KEY) !== null) {
      throw refuse("inline_definition", `'${SERVER_KEY}' is defined as an inline key under [${NAMESPACE_ROOT}]`);
    }
    if (samePath(section.path, CODEX_SERVER_PATH) && section.header !== CODEX_SERVER_HEADER) {
      throw refuse("ambiguous_header", `non-canonical spelling of ${CODEX_SERVER_HEADER}: ${section.header}`);
    }
    for (const tool of tools) {
      if (samePath(section.path, [...CODEX_SERVER_PATH, CODEX_TOOLS_KEY]) && assignmentFor(section, tool) !== null) {
        throw refuse("inline_definition", `'${tool}' is defined as an inline key under [${TOOLS_DOTTED}]`);
      }
      const header = codexToolHeader(tool);
      if (samePath(section.path, [...CODEX_SERVER_PATH, CODEX_TOOLS_KEY, tool]) && section.header !== header) {
        throw refuse("ambiguous_header", `non-canonical spelling of ${header}: ${section.header}`);
      }
    }
  }
}

/**
 * Splice the agkit server table (and the requested per-tool approval tables) into a Codex
 * `config.toml`.
 *
 * - `existing === null` (file absent) or empty → the canonical document, one trailing LF.
 * - `[mcp_servers.agkit]` present → its `command`/`args` are rewritten IN PLACE (comments, blank
 *   lines and every other key inside the section survive verbatim); a missing key is appended to
 *   the section rather than replacing it.
 * - absent → the whole block is appended after the file's last non-blank line, one blank-line
 *   separator.
 * - each requested tool table: present → its `approval_mode` is ensured; absent → appended.
 * - every other byte of the file is preserved exactly, CRLF line endings included.
 *
 * Re-running on this function's own output is byte-identical (the acceptance).
 */
export function spliceCodexConfig(existing: string | null, absBin: string, tools: readonly string[]): string {
  const commandLine = codexCommandLine(absBin); // refuses an empty bin BEFORE anything is read
  const argsLine = codexArgsLine();
  const requested = new Set<string>();
  for (const tool of tools) {
    codexToolHeader(tool); // validates the bare-key shape
    if (requested.has(tool)) throw refuse("invalid_tool_name", `tool '${tool}' appears twice in the request`);
    requested.add(tool);
  }

  if (existing === null || existing === "") {
    return `${[codexServerTable(absBin), ...tools.map((tool) => codexToolTable(tool))].join("\n\n")}\n`;
  }

  const cr = existing.includes("\r\n") ? "\r" : "";
  const lines = existing.split("\n");
  const sections = toSections(scanStatements(lines), lines.length);
  assertUnambiguous(sections, tools);

  const edits: Edit[] = [];
  const appended: string[] = [];

  const serverSections = sections.filter((s) => samePath(s.path, CODEX_SERVER_PATH));
  if (serverSections.length > 1) {
    throw refuse("duplicate_server_table", `${CODEX_SERVER_HEADER} appears ${serverSections.length} times`);
  }
  const server = serverSections[0];
  if (server === undefined) {
    appended.push(...codexServerTable(absBin).split("\n"));
  } else {
    const missing: string[] = [];
    for (const [key, text, want] of [
      ["command", commandLine, "string"],
      ["args", argsLine, "array"],
    ] as const) {
      const found = assignmentFor(server, key);
      if (found === null) missing.push(text);
      else {
        requireValueKind(found, key, want);
        if (want === "array") requireStringArray(lines, found, key);
        edits.push({ start: found.start, end: found.end, lines: [text] });
      }
    }
    if (missing.length > 0) {
      const at = appendPointIn(lines, server);
      edits.push({ start: at, end: at - 1, lines: missing });
    }
  }

  for (const tool of tools) {
    const found = sections.filter((s) => samePath(s.path, [...CODEX_SERVER_PATH, CODEX_TOOLS_KEY, tool]));
    if (found.length > 1) {
      throw refuse("duplicate_tool_table", `${codexToolHeader(tool)} appears ${found.length} times`);
    }
    const table = found[0];
    if (table === undefined) {
      if (appended.length > 0) appended.push("");
      appended.push(...codexToolTable(tool).split("\n"));
      continue;
    }
    const approval = assignmentFor(table, CODEX_APPROVAL_KEY);
    if (approval === null) {
      const at = appendPointIn(lines, table);
      edits.push({ start: at, end: at - 1, lines: [approvalLine()] });
    } else {
      requireValueKind(approval, CODEX_APPROVAL_KEY, "string");
      edits.push({ start: approval.start, end: approval.end, lines: [approvalLine()] });
    }
  }

  // Bottom-up so earlier indices stay valid, then append whatever had no home.
  const out = [...lines];
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out.splice(edit.start, edit.end - edit.start + 1, ...edit.lines.map((line) => `${line}${cr}`));
  }
  if (appended.length === 0) return out.join("\n");
  let tail = out.length;
  while (tail > 0 && stripCr(out[tail - 1]!).trim() === "") tail -= 1;
  const head = out.slice(0, tail);
  const block = appended.map((line) => (line === "" ? cr : `${line}${cr}`));
  return [...head, ...(head.length > 0 ? [cr] : []), ...block, ""].join("\n");
}
