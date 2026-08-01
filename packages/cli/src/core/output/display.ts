// The ONE terminal-safe display encoder (T-212 review round F-D1). The redaction registry
// (redaction.ts) masks WHAT must not be shown; THIS module makes what IS shown safe to write
// to a terminal: a plan-controlled string (id, diff op/resource/path, a string before/after
// leaf, confirm_string), a direct_confirm preview line, or a user-supplied token echoed by a
// usage error can carry C0 controls, ESC sequences, CR/LF, or DEL — enough to break a render
// line, move the cursor, restyle the terminal, or forge a fake prompt. Every interpolation
// site routes through `displaySafe`, which escapes exactly that hazard class to a VISIBLE
// `\xNN` form and passes all visible Unicode through untouched.

// C0 controls (0x00–0x1f, which includes ESC/CR/LF/TAB) + DEL (0x7f).
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** Escape C0/DEL/ESC to visible `\xNN`; preserve every printable Unicode character. */
export function displaySafe(value: string): string {
  return value.replace(CONTROL_CHARS, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** `displaySafe` + a rendered-width bound (T-220 R-V1): user-argv/server-derived values that
 *  ride an error message are capped AFTER escaping (escaping grows the string — the cap bounds
 *  what actually renders), truncated with a visible `…`. */
export function displayCapped(value: string, max: number): string {
  const safe = displaySafe(value);
  return safe.length <= max ? safe : `${safe.slice(0, max)}…`;
}
