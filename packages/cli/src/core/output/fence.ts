// The auto-sized DATA FENCE (T-227 S7, req 9) — the human-surface discipline for TENANT FREE
// TEXT: an agent's `static_system_prompt`, an audit entry's `details` blob, an
// `agent_profile_tools` `description`. These are strings a TENANT authored; we render them, but
// we must never let them be mistaken for OUR structure — not by a terminal, not by a human, and
// not by an agent reading the render. So they are emitted inside a fenced block whose info string
// SAYS the block is data.
//
// This is the third member of the output-hygiene family, and the three do different jobs:
//   • redaction.ts  — decides WHAT may not be shown at all (a secret).
//   • display.ts    — makes an INLINE interpolation terminal-safe (escape C0/DEL/ESC to `\xNN`).
//   • fence.ts      — DELIMITS a multi-line value so its content cannot forge the render around it.
//
// ── AUTO-SIZING IS THE WHOLE MECHANISM ───────────────────────────────────────────────────────────
// A fixed ``` fence is escapable: content containing ``` at a line start CLOSES the block early,
// and everything after it renders as OUR structure — exactly the injection this defends against.
// So the fence is sized to the CONTENT: `longest backtick run in the content + 1`, minimum 3. By
// construction no run inside the block can be as long as the fence, so no line inside it can close
// it. That property is the acceptance test (req 9: "adversarial backtick content").
//
// ── WHAT IS ESCAPED INSIDE A BLOCK ───────────────────────────────────────────────────────────────
// `displaySafe` escapes EVERY C0 control including LF and TAB, which is right for a one-line
// interpolation and wrong here: LF is the BLOCK'S OWN STRUCTURE (escaping it would defeat the
// block) and TAB is horizontal whitespace inside prose. Every other C0/DEL — ESC (restyle the
// terminal), CR (overwrite a rendered line, incl. the closing fence), NUL/BEL — forges structure or
// drives the terminal and is escaped to the SAME visible `\xNN` form display.ts uses. So: LF and
// TAB pass; everything else in that class is escaped, exactly as it would be inline.
//
// ── MACHINE SURFACES ARE NOT FENCED ──────────────────────────────────────────────────────────────
// Fencing is a HUMAN-surface discipline. `--json` / `--jq` / `--template` and the MCP result
// document (src/mcp/result.ts) are machine documents whose own grammar already delimits a string;
// adding a fence there would corrupt the value. Only human.ts renders through this module.

/** The fence character (a markdown backtick fence — the info string is what labels it). */
const BACKTICK = "`";

/** CommonMark's minimum fence length. A shorter run is not a fence at all. */
const MIN_FENCE_LENGTH = 3;

/**
 * The block's info string: `<language> <marker> [label]`. The LANGUAGE is `text` so no renderer
 * ever interprets tenant bytes as code in some other grammar; the MARKER is the machine-greppable
 * claim that the block is DATA, not instruction; the optional LABEL names the field, mirroring
 * human.ts's convention of labelling a value with its own key.
 */
export const DATA_FENCE_LANGUAGE = "text";
export const DATA_FENCE_MARKER = "agkit:data";

/** Any C0 control or DEL — the class display.ts escapes. Non-global: `.test` must be stateless. */
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
/** The same class MINUS LF and TAB — what is escaped INSIDE a data block (see the header). */
const CONTROL_CHAR_IN_BLOCK = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Does this text carry a C0 control or DEL? Such a value can NEVER render inline in a key/value
 * line or a table row: an LF forges a row, a CR overwrites one, an ESC restyles the terminal. The
 * human formatter routes exactly these into a data block instead.
 */
export function hasControlChars(text: string): boolean {
  return CONTROL_CHAR.test(text);
}

/**
 * TENANT FREE-TEXT field names (req 9). A SUFFIX match, case-insensitive, because both wire
 * conventions put the family word last (`static_system_prompt`, `staticSystemPrompt`):
 *
 *   prompt      → `static_system_prompt` (agent_profile_create/update_request), `system_prompt`
 *   details     → `details`              (the audit_entry blob, account.ts audit.list)
 *   description → `description`          (tool_create/update_request → `agent_profile_tools`)
 *
 * Deliberately NOT here: `display_name` / `slug` / `tool_name` (short identifiers, and fencing
 * every one would wreck the list tables they are columns of) and `parameter_schema` /
 * `safety_settings` / `thinking_config` (JSON objects, whose own grammar already delimits them and
 * whose `cell()` rendering is a single control-free line). A value under any of those that DOES
 * carry a control character still lands in a block — `hasControlChars` is the second, name-blind
 * gate, so the row-forgery hazard is closed for every field, named or not.
 */
const TENANT_FREE_TEXT_FIELD = /(?:prompt|details|description)$/i;

/** Is this key one whose value is tenant-authored free text (see the pattern above)? */
export function isTenantFreeTextField(key: string): boolean {
  return TENANT_FREE_TEXT_FIELD.test(key);
}

/** The longest run of consecutive backticks anywhere in `content` (0 when there is none). */
export function longestBacktickRun(content: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    if (ch === BACKTICK) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * The fence length for `content`: the longest backtick run inside it PLUS ONE, never below the
 * CommonMark minimum of 3. The `+1` is what makes early closure impossible — no run in the content
 * can reach the fence's length, so no line inside the block can be read as the closing fence.
 */
export function fenceLength(content: string): number {
  return Math.max(longestBacktickRun(content) + 1, MIN_FENCE_LENGTH);
}

/** Escape the in-block hazard class (C0/DEL except LF and TAB) to display.ts's visible `\xNN`. */
function fenceSafe(content: string): string {
  return content.replace(CONTROL_CHAR_IN_BLOCK, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Bound on the info-string label — a field name, never prose. */
const MAX_LABEL_CHARS = 64;

/**
 * Sanitize an info-string label. A backtick inside the info string of a backtick fence is invalid
 * CommonMark (it would let a label close or re-open the block), so backticks are escaped to the
 * same visible form; the label is then display-escaped (it is a ONE-LINE token, so the full
 * `displaySafe` class applies, LF included) and capped.
 */
function fenceLabel(label: string): string {
  const noBackticks = label.replace(/`/g, "\\x60");
  const safe = noBackticks.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  return safe.length <= MAX_LABEL_CHARS ? safe : `${safe.slice(0, MAX_LABEL_CHARS)}…`;
}

export interface DataFenceOptions {
  /** Field name (or `field#n` reference) appended to the info string. Sanitized + capped. */
  readonly label?: string;
}

/**
 * Emit `content` as an auto-sized, labelled-as-DATA fenced block. Returns the block WITHOUT a
 * trailing newline so a caller composes it as a line group (human.ts joins its lines with `\n`).
 *
 * The content is never trimmed, padded or normalized — only the in-block control class is escaped.
 * An empty string yields an EMPTY block (opener immediately followed by the closer), and a content
 * ending in LF keeps its resulting empty last line, so `"a"` and `"a\n"` stay distinguishable.
 */
export function fenceData(content: string, options: DataFenceOptions = {}): string {
  const safe = fenceSafe(content);
  const fence = BACKTICK.repeat(fenceLength(safe));
  const label = options.label !== undefined && options.label.length > 0 ? ` ${fenceLabel(options.label)}` : "";
  const open = `${fence}${DATA_FENCE_LANGUAGE} ${DATA_FENCE_MARKER}${label}`;
  const body = safe.length === 0 ? [] : safe.split("\n");
  return [open, ...body, fence].join("\n");
}
