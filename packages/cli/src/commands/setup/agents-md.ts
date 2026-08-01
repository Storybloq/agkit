// T-224 D5 / D5v2 / D-markers-v2 — the AGENTS.md splice. PURE: string in, string out. No fs, no
// cwd, no symlink resolution — the guarded follow-write (and the containment check that decides
// WHERE these bytes land) belongs to the command layer; this module only decides WHAT they are.
//
// ONE PARSER DRIVES BOTH LEGS. `--check` renders `spliceAgentsMd(current, agentsSnippet())` and
// diffs it against the current bytes; apply writes that same string. There is no second "would it
// change?" implementation to drift, so a dry run can never disagree with the write it predicts.
//
// THE GRAMMAR IS STRICT, AND DELIBERATELY SO (D-markers-v2). A marker pair is a claim of custody
// over a region of somebody's file. Exactly one `<!-- agkit:begin -->`, exactly one
// `<!-- agkit:end -->`, begin before end — that is the only shape we will edit. A lone marker, a
// reversed pair, a duplicate or a nested pair means the file's history is not what we think it is,
// so we refuse (`AgentsMarkerError`) and emit NOTHING rather than pick an interpretation and eat
// the user's prose. Absence of both markers is not a malformed shape: it is a fresh append.
//
// RE-RUN IS BYTE-IDENTICAL (the ticket's acceptance): everything outside the markers is copied
// through verbatim, and the block between them is regenerated from the same snippet, so
// `splice(splice(x, s), s) === splice(x, s)`.

/** The opening fence. HTML comment syntax: invisible in every Markdown renderer. */
export const AGENTS_BEGIN = "<!-- agkit:begin -->";
/** The closing fence. */
export const AGENTS_END = "<!-- agkit:end -->";

/** Why a splice refused. The command layer maps these to an honest `refused` leg detail. */
export type AgentsMarkerRefusal =
  /** A begin marker with no end marker. */
  | "lone_begin"
  /** An end marker with no begin marker. */
  | "lone_end"
  /** Both present, but the end marker comes first. */
  | "reversed_markers"
  /** More than one begin marker (a nested pair lands here). */
  | "duplicate_begin"
  /** More than one end marker (a nested pair lands here). */
  | "duplicate_end";

/** A refused splice. Thrown, never returned: a half-spliced document has no honest form. */
export class AgentsMarkerError extends Error {
  override name = "AgentsMarkerError";
  constructor(
    readonly reason: AgentsMarkerRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The block agkit owns inside AGENTS.md. Every line an agent reads about this CLI is here, and it
 * is MIRRORED from `skill/SKILL.md` — the same entry point, the same auth ladder, the same `--json`
 * discipline, the same `--yes` prohibition. No claim is invented here that the skill does not
 * already make; when the skill changes, this changes with it.
 *
 * Kept short on purpose (the ticket caps it): AGENTS.md is shared with every other tool in the
 * repo, so this is a router to `agkit reference`, not a manual.
 */
export function agentsSnippet(): string {
  return [
    "## agkit — the AgentKit management CLI",
    "",
    "`agkit` is the management-plane CLI for AgentKit Cloud (projects, keys, issuers, routes,",
    "profiles). You are an agent: treat it as a JSON API, not a text UI.",
    "",
    "- Start here: `agkit status --json` — a local snapshot that exits 0 even when",
    "  unauthenticated. Branch on `data.authenticated`.",
    "- Auth ladder, first match wins: `AGKIT_TOKEN` in the environment → `agkit login`",
    "  (interactive TTY + browser) → `agkit login --device` (headless) → a human mints",
    "  `agkit token create` out of band and exports it as `AGKIT_TOKEN`.",
    "- Always pass `--json`; parse `data.<field>` and `error.code`. Never scrape the human",
    "  tables — they are for people and are not a contract.",
    "- Exit codes are control flow, not crashes: 0 success · 1 retryable · 2 terminal ·",
    "  3 partial · 130 interrupted.",
    "- You MUST NOT pass `--yes` on a destructive (`D`) or prod-rebinding (`PR`) command, or",
    "  pass `--confirm` at all, unless the user explicitly asked for that exact change.",
    "  `confirmation_required` on a non-TTY is the NORMAL shape — report it and wait.",
    "- The full catalog (every command, its danger class, scopes and examples): `agkit reference`.",
  ].join("\n");
}

/** The snippet wrapped in its fences — the exact bytes the splice owns. */
export function agentsFencedBlock(snippet: string): string {
  return [AGENTS_BEGIN, snippet.replace(/\n+$/, ""), AGENTS_END].join("\n");
}

/** Every start index of `needle` in `text` (the markers cannot overlap themselves). */
function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * Splice the agkit block into an AGENTS.md.
 *
 * - `existing === null` (file absent) → the fenced block alone, one trailing LF.
 * - markers present exactly once, in order → the bytes BETWEEN them are replaced; everything
 *   outside is copied through verbatim (including the file's trailing-newline habit).
 * - markers absent → the block is appended after the existing content, separated by exactly one
 *   blank line (the existing trailing newlines are normalized to produce it — the only bytes an
 *   append ever rewrites).
 * - any other marker shape → `AgentsMarkerError`, no output.
 */
export function spliceAgentsMd(existing: string | null, snippet: string): string {
  const block = agentsFencedBlock(snippet);
  if (existing === null) return `${block}\n`;

  const begins = occurrences(existing, AGENTS_BEGIN);
  const ends = occurrences(existing, AGENTS_END);
  if (begins.length > 1) {
    throw new AgentsMarkerError("duplicate_begin", `AGENTS.md carries ${begins.length} agkit begin markers`);
  }
  if (ends.length > 1) {
    throw new AgentsMarkerError("duplicate_end", `AGENTS.md carries ${ends.length} agkit end markers`);
  }
  const begin = begins[0];
  const end = ends[0];
  if (begin !== undefined && end === undefined) {
    throw new AgentsMarkerError("lone_begin", "AGENTS.md carries an agkit begin marker with no end marker");
  }
  if (begin === undefined && end !== undefined) {
    throw new AgentsMarkerError("lone_end", "AGENTS.md carries an agkit end marker with no begin marker");
  }
  if (begin !== undefined && end !== undefined) {
    if (end < begin) {
      throw new AgentsMarkerError("reversed_markers", "AGENTS.md carries the agkit end marker before the begin marker");
    }
    return existing.slice(0, begin) + block + existing.slice(end + AGENTS_END.length);
  }

  // The ONE normalization an append performs: collapse whatever trailing newlines the file ends
  // with (LF or CRLF) so the separator below is exactly one blank line. Every other byte survives.
  const head = existing.replace(/(\r?\n)+$/, "");
  return head === "" ? `${block}\n` : `${head}\n\n${block}\n`;
}
