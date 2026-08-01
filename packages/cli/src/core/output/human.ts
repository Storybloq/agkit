// Human formatter (T-205, canonical L2-CLI-03, deliverable 5). TTY changes only
// the FORMAT, never behavior or the field set:
//   - TTY      : aligned tables / `key: value`, with color.
//   - non-TTY  : TSV, NO truncation, NO ANSI (safe for pipes).
// Zero-state (`[]`) renders "(no matches)" with exit 0. Color honors NO_COLOR /
// --no-color (already folded into `config.color`). All input here is ALREADY
// redacted — this formatter is downstream of the registry.
//
// T-227 S7 (req 9) — TENANT FREE TEXT RIDES IN A DATA BLOCK. This is the ONE human data surface
// in the CLI (`formatHuman` has exactly one caller: the serializer chokepoint), so it is where an
// agent's `static_system_prompt`, an audit entry's `details` blob and an `agent_profile_tools`
// `description` become bytes a human or an agent reads. A value like that is tenant-authored: left
// inline it can forge a `key: value` line or an extra table row with a single LF, and it is not
// visibly distinguishable from OUR structure. Two gates route such a value into an auto-sized,
// labelled-as-data fenced block instead (`./fence`): its KEY names a free-text family, or its
// rendered text carries ANY control character (the name-blind gate — it closes row forgery for
// every field, named or not). Both gates fire IDENTICALLY on a TTY and when piped: the block is
// byte-identical in both, and tenant text is NEVER painted (color is ours, structure is ours).
// The machine modes (json / jq / template) are untouched — their own grammar delimits a string.
import type { OutputConfig } from "./config";
import type { ErrorEnvelope } from "./envelope";
import { fenceData, hasControlChars, isTenantFreeTextField } from "./fence";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
} as const;

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/** Format success `data` for human/TSV output. */
export function formatHuman(data: unknown, config: OutputConfig): string {
  if (Array.isArray(data)) return formatArray(data, config);
  if (data !== null && typeof data === "object") return formatObject(data as Record<string, unknown>, config);
  return formatScalar(data);
}

/**
 * Format an error for the HUMAN stream (prose to stderr) — the two-line teachable
 * format (T-207, canonical L2-CLI-04, deliverable 4):
 *
 *   error <code>: <title> (<detail>)
 *   → try: <hint>
 *
 * If `detail` is absent, line 1 is just `error <code>: <title>`; if `hint` is
 * absent, the second line is omitted. `title` falls back to `message` for a legacy
 * `{code, message}` envelope that carries no teachable `title` (backward compatible).
 * Color honors NO_COLOR / --no-color (already folded into `config.color`); the JSON
 * path renders the `error` member verbatim (hint/exit_code included) — this
 * formatter is the HUMAN face of the same fields.
 */
export function formatHumanError(error: ErrorEnvelope["error"], config: OutputConfig): string {
  const code = String(error.code);
  const title = nonEmptyString(error["title"]) ?? error.message;
  const detail = nonEmptyString(error["detail"]);
  const hint = nonEmptyString(error["hint"]);

  const head = paint(`error ${code}`, ANSI.red, config.color);
  let first = `${head}: ${title}`;
  if (detail !== undefined) first += ` (${detail})`;

  const lines = [first];
  if (hint !== undefined) lines.push(`${paint("→ try:", ANSI.cyan, config.color)} ${hint}`);
  return lines.join("\n") + "\n";
}

/** A trimmed, non-empty string value, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// --- tenant free text -> data blocks (T-227 S7, req 9) -----------------------
/** What stands in the grid/key line for a value that was moved into a data block below. */
function blockReference(index: number): string {
  return `(data block ${index})`;
}

/**
 * Must this value be moved OUT of its inline position and into a data block? Two gates:
 * (1) the KEY names a tenant free-text family (`…prompt` / `…details` / `…description`), or
 * (2) the rendered text carries a control character — a value that would forge a line or drive
 *     the terminal if written inline, whatever its key is called.
 * An EMPTY cell is never blocked: there is nothing to delimit and a block would be pure noise.
 */
function needsDataBlock(key: string | undefined, text: string): boolean {
  if (text.length === 0) return false;
  if (key !== undefined && isTenantFreeTextField(key)) return true;
  return hasControlChars(text);
}

/**
 * Render one value for an INLINE slot (a `key: value` line or a table cell), appending a fenced
 * data block to `blocks` and returning a `(data block N)` reference when the value may not ride
 * inline. `blocks` is the ONE accumulator per rendered document, so the reference numbers a caller
 * sees are the emission order of the blocks that follow.
 */
function inlineCell(key: string | undefined, value: unknown, blocks: string[]): string {
  const text = cell(value);
  if (!needsDataBlock(key, text)) return text;
  const index = blocks.length + 1;
  blocks.push(fenceData(text, { label: key !== undefined ? `${key}#${index}` : `#${index}` }));
  return blockReference(index);
}

/** Append the collected data blocks under a rendered body (blank-line separated), if any. */
function withBlocks(bodyText: string, blocks: string[]): string {
  if (blocks.length === 0) return bodyText;
  return [bodyText, ...blocks].join("\n\n");
}

function formatObject(obj: Record<string, unknown>, config: OutputConfig): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "(empty)";

  const blocks: string[] = [];
  // The value text is computed ONCE, before either layout branch, so the TTY and TSV renders make
  // the identical block/inline decision for every key (format differs; the decision never does).
  const cells = keys.map((k) => inlineCell(k, obj[k], blocks));

  if (!config.isTTY) {
    // TSV: `key<TAB>value` per line.
    return withBlocks(keys.map((k, i) => `${k}\t${cells[i]}`).join("\n"), blocks);
  }

  const width = keys.reduce((max, k) => Math.max(max, k.length), 0);
  const lines = keys.map((k, i) => `${paint(k.padEnd(width), ANSI.cyan, config.color)}  ${cells[i]}`);
  return withBlocks(lines.join("\n"), blocks);
}

function formatArray(rows: unknown[], config: OutputConfig): string {
  if (rows.length === 0) return "(no matches)";

  const blocks: string[] = [];
  const allObjects = rows.every(
    (row) => row !== null && typeof row === "object" && !Array.isArray(row),
  );
  if (!allObjects) {
    // A scalar list has no keys, so only the name-blind gate applies: a scalar carrying an LF would
    // otherwise forge extra rows in a one-row-per-item render.
    const lines = rows.map((row) =>
      typeof row === "string" ? inlineCell(undefined, row, blocks) : formatScalar(row),
    );
    return withBlocks(lines.join("\n"), blocks);
  }

  const records = rows as Record<string, unknown>[];
  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
  }

  // The grid is materialized ONCE (a row-major array of already-decided cell texts) and BOTH
  // layouts render from it. A fenced block cannot live inside a row — a grid row is single-line by
  // construction — so a free-text or control-bearing cell becomes a `(data block N)` reference and
  // its content is emitted below the table, in row-major order. That keeps the row grammar intact
  // AND keeps column widths sane (an audit `details` blob no longer sets the table's width).
  const grid = records.map((record) => columns.map((col) => inlineCell(col, record[col], blocks)));

  if (!config.isTTY) {
    // TSV: a header row, then one row per record, tab-separated, no truncation.
    const header = columns.join("\t");
    return withBlocks([header, ...grid.map((row) => row.join("\t"))].join("\n"), blocks);
  }

  // Aligned table: column widths sized to the widest cell (including the header).
  const widths = columns.map((col, i) =>
    grid.reduce((max, row) => Math.max(max, (row[i] ?? "").length), col.length),
  );
  const headerCells = columns.map((col, i) => paint(col.padEnd(widths[i] ?? col.length), ANSI.cyan + ANSI.bold, config.color));
  const header = headerCells.join("  ");
  const body = grid.map((row) => row.map((text, i) => text.padEnd(widths[i] ?? 0)).join("  ").trimEnd());
  return withBlocks([header, ...body].join("\n"), blocks);
}
