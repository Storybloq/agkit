// `agent sync` file model (T-218 §3.3 / D-4 / D-5). Two pure concerns, no I/O:
//   1. `parseSyncFile(text)` — JSON.parse + a STRICT zod mirror of the server's SyncProfile/SyncTool
//      wire shape, PLUS local sanity caps + duplicate detection + per-tool parameter_schema checks.
//      Every failure is a value-free `usage_error` (exit 2) naming a STRUCTURAL LOCATION + a violation
//      CLASS, NEVER a file-derived value (A-1/A-7): not the unknown key, not a slug/tool_name, not a
//      prompt or schema body. This runs entirely BEFORE any wire call (R1: unknown field ⇒ zero ops).
//   2. `computeSyncDiff(fileProfiles, serverProfiles)` — a PURE per-profile classification (create /
//      profile fields updated / profile fields unchanged) over the FIVE sync-mutable profile fields
//      only (display_name, static_system_prompt as a char-count, allowed_tiers, the two token caps —
//      exactly the columns `syncAgentProfiles` upserts). Tools are NOT live-diffed (A-9: unbounded
//      cost); the caller shows each profile's DECLARED tool names FROM THE FILE and always labels
//      tool-bearing profiles "N declaration(s) will be upserted (live tool diff unavailable)" (A-13,
//      never a bare "unchanged"). `retainedProfiles` names server profiles ABSENT from the file — the
//      D-4 honesty rail: sync is UPSERT-ONLY (agents.ts:738/:761), it NEVER deletes, so there is no
//      "delete" block; retained profiles are kept and surfaced so the operator is not misled.
//
// D-5 (stricter-than-server, one-directional BY DESIGN): the server's `validateProfileSyncInput` is a
// POSITIVE-types-only gate that SILENTLY IGNORES unknown members; the CLI mirror is `.strict()` at
// every level so an unknown field is rejected client-side (CLI-accepted ⊆ server-accepted, pinned by
// a cross-package parity test). Token counts additionally require a SAFE integer (the server's
// Number.isSafeInteger, agents.ts:651) so the subset relation holds universally, not just on tested
// inputs.
import { z } from "zod";
import { CliLocalError } from "../../core/errors";
import { validateToolParameterSchema, TOOL_SCHEMA_VIOLATION_PHRASE } from "./tool-schema";

/** Total file byte ceiling — a local sanity bound (the server stays authoritative). Bounds the whole
 *  payload and typically binds first for a large tool set. */
export const SYNC_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** Client-only profile-count ceiling (A-14) — comfortably above realistic project sizes; bounds the
 *  diff + preview to a reviewable length independent of bytes. A legitimate larger sync splits the
 *  file (acceptable friction for an unusual case). The server stays authoritative. */
export const MAX_SYNC_PROFILES = 500;
/** Client-only per-profile tool-count ceiling (A-14). */
export const MAX_TOOLS_PER_PROFILE = 100;

// --- the strict wire mirror (SyncProfile / SyncTool, agents.ts:548-562) -------------------------
const safeIntToken = z
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n));

const toolEntry = z
  .object({
    name: z.string(),
    description: z.string(),
    // A plain JSON object (record) here; the DEEP size/depth/shape validation is a separate per-tool
    // step (validateToolParameterSchema) so its violation class is reported precisely.
    parameter_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

const profileEntry = z
  .object({
    slug: z.string(),
    display_name: z.string(),
    static_system_prompt: z.string(),
    allowed_tiers: z.array(z.string()),
    max_input_tokens: safeIntToken,
    max_output_tokens: safeIntToken,
    tools: z.array(toolEntry),
  })
  .strict();

export const agentSyncFileSchema = z.object({ profiles: z.array(profileEntry) }).strict();

/** The validated file shape (mirrors ProfileSyncInput / SyncProfile). */
export interface SyncFileTool {
  readonly name: string;
  readonly description: string;
  readonly parameter_schema: Record<string, unknown>;
}
export interface SyncFileProfile {
  readonly slug: string;
  readonly display_name: string;
  readonly static_system_prompt: string;
  readonly allowed_tiers: readonly string[];
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly tools: readonly SyncFileTool[];
}
export interface ParsedSyncFile {
  readonly profiles: readonly SyncFileProfile[];
}

/** Format a zod issue path as `profiles[2].tools[0].max_input_tokens` — indices + KNOWN member names
 *  only (contract constants, never file content). A symbol key (never produced by these schemas) is
 *  coerced defensively to a bracketed segment. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (typeof seg === "string") out += out.length === 0 ? seg : `.${seg}`;
    else out += `[${String(seg)}]`;
  }
  return out;
}

/** Is the value at `path` ABSENT from `root`? A PURE existence walk — reads structure (which keys /
 *  indices exist), NEVER a value, so it stays value-free (A-1). Used to tell a MISSING required field
 *  from a wrong-typed one, a distinction zod v4's `invalid_type` issue does not itself carry (it omits
 *  `input` for both). A vanished parent counts as absent. */
function valueIsAbsent(root: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let cur: unknown = root;
  for (let i = 0; i < path.length; i += 1) {
    const seg = path[i]!;
    if (cur === null || typeof cur !== "object") return true; // parent missing ⇒ absent
    if (i === path.length - 1) {
      if (Array.isArray(cur)) return typeof seg !== "number" || seg < 0 || seg >= cur.length;
      return !Object.prototype.hasOwnProperty.call(cur, seg);
    }
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return false;
}

/** A VALUE-FREE class for a zod issue (A-1): derived from the code + type names ONLY — never the
 *  issue message (which zod embeds values/keys into), never `issue.keys`, never the received value.
 *  `expected` is a TYPE name (string/number/array/object). A MISSING required field is told from a
 *  wrong-typed one by a pure existence check on the parsed input (`root`), since zod v4's
 *  `invalid_type` issue omits `input` for both. */
function issueClass(issue: z.core.$ZodIssue, root: unknown): string {
  switch (issue.code) {
    case "unrecognized_keys":
      return "unknown field"; // DROP issue.keys (the offending key string is file-derived)
    case "invalid_type":
      return valueIsAbsent(root, issue.path) ? "missing required field" : `expected ${String(issue.expected)}`;
    case "too_small":
    case "too_big":
      return "value out of range";
    default:
      // The safe-integer refine (custom) and any other check → a value-free generic.
      return "invalid value";
  }
}

/** Throw the first zod issue as a value-free `usage_error` (location + class only). `root` is the
 *  parsed input, consulted ONLY for a value-free existence check (missing vs wrong-typed). */
function throwZod(error: z.ZodError, root: unknown): never {
  const issue = error.issues[0]!;
  const loc = formatPath(issue.path);
  const cls = issueClass(issue, root);
  throw new CliLocalError("usage_error", {
    detail: loc.length > 0 ? `${loc}: ${cls}` : cls,
  });
}

/**
 * Parse + validate a sync file's JSON text into a strongly-typed `ParsedSyncFile`, or throw a
 * value-free `usage_error`. Order (all BEFORE any wire call): JSON.parse → strict schema → local caps
 * → duplicate slugs/tool-names → per-tool parameter_schema. `text` is already length-bounded by the
 * reader (SYNC_FILE_MAX_BYTES); the caps here bound the DECLARED counts.
 */
export function parseSyncFile(text: string): ParsedSyncFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Position-free: JSON.parse messages embed a byte offset / snippet — never surfaced.
    throw new CliLocalError("usage_error", { detail: "the sync file is not valid JSON" });
  }

  const parsed = agentSyncFileSchema.safeParse(json);
  if (!parsed.success) throwZod(parsed.error, json);
  const { profiles } = parsed.data;

  // Local caps (A-14) — value-free, location-named.
  if (profiles.length > MAX_SYNC_PROFILES) {
    throw new CliLocalError("usage_error", {
      detail: `the sync file declares more than ${MAX_SYNC_PROFILES} profiles`,
      hint: "split the file, or raise the ceiling",
    });
  }
  profiles.forEach((p, i) => {
    if (p.tools.length > MAX_TOOLS_PER_PROFILE) {
      throw new CliLocalError("usage_error", {
        detail: `profiles[${i}] declares more than ${MAX_TOOLS_PER_PROFILE} tools`,
      });
    }
  });

  // Duplicate detection (R11 / D-5 honor-or-reject; the server upserts last-wins silently) —
  // location only, never the duplicated value.
  const seenSlug = new Set<string>();
  profiles.forEach((p, i) => {
    if (seenSlug.has(p.slug)) {
      throw new CliLocalError("usage_error", { detail: `profiles[${i}]: duplicate slug` });
    }
    seenSlug.add(p.slug);
    const seenTool = new Set<string>();
    p.tools.forEach((t, j) => {
      if (seenTool.has(t.name)) {
        throw new CliLocalError("usage_error", { detail: `profiles[${i}].tools[${j}]: duplicate tool name` });
      }
      seenTool.add(t.name);
    });
  });

  // Per-tool parameter_schema deep validation (R3 / Deliverable 2) — value-free, structural location.
  profiles.forEach((p, i) => {
    p.tools.forEach((t, j) => {
      const verdict = validateToolParameterSchema(t.parameter_schema);
      if (!verdict.ok) {
        throw new CliLocalError("usage_error", {
          detail: `profiles[${i}].tools[${j}]: parameter_schema ${TOOL_SCHEMA_VIOLATION_PHRASE[verdict.reason]}`,
        });
      }
    });
  });

  return { profiles };
}

// --- the pure per-profile diff (A-9 / A-13 / D-4) ----------------------------------------------
export type ProfileDiffKind = "create" | "updated" | "unchanged";

export interface ProfileDiffEntry {
  readonly slug: string;
  readonly kind: ProfileDiffKind;
  /** For `updated`: which of the five sync-mutable fields differ (KNOWN member names, never values). */
  readonly changedFields: readonly string[];
  /** The tool NAMES declared in the file for this profile (shown in the preview; the operator's own
   *  identifiers, rendered through the displaySafe chokepoint). */
  readonly toolNames: readonly string[];
  /** For `static_system_prompt` changes: the char counts (never the body). null when not applicable. */
  readonly promptCharDelta: { readonly from: number; readonly to: number } | null;
}

export interface SyncDiff {
  readonly entries: readonly ProfileDiffEntry[];
  /** Server profile slugs ABSENT from the file (kept — sync never deletes). */
  readonly retainedProfiles: readonly string[];
}

/** The five sync-mutable server fields, read defensively off a raw profile.list row. */
interface ServerProfileFields {
  readonly display_name: string | undefined;
  readonly static_system_prompt: string | undefined;
  readonly allowed_tiers: readonly string[] | undefined;
  readonly max_input_tokens: number | undefined;
  readonly max_output_tokens: number | undefined;
}

function readServerProfile(raw: unknown): { slug: string; fields: ServerProfileFields } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : undefined;
  if (slug === undefined) return null;
  return {
    slug,
    fields: {
      display_name: typeof r.display_name === "string" ? r.display_name : undefined,
      static_system_prompt: typeof r.static_system_prompt === "string" ? r.static_system_prompt : undefined,
      allowed_tiers: Array.isArray(r.allowed_tiers) ? (r.allowed_tiers as string[]) : undefined,
      max_input_tokens: typeof r.max_input_tokens === "number" ? r.max_input_tokens : undefined,
      max_output_tokens: typeof r.max_output_tokens === "number" ? r.max_output_tokens : undefined,
    },
  };
}

/**
 * Classify each FILE profile against live server state (create / updated / unchanged over the five
 * sync-mutable fields ONLY), and list the server profiles the file omits (retained — never deleted).
 * PURE: no network, no tool.list (A-9). Tool declarations are carried for the preview but not diffed.
 */
export function computeSyncDiff(
  fileProfiles: readonly SyncFileProfile[],
  serverProfiles: readonly unknown[],
): SyncDiff {
  const serverBySlug = new Map<string, ServerProfileFields>();
  for (const raw of serverProfiles) {
    const parsed = readServerProfile(raw);
    if (parsed !== null) serverBySlug.set(parsed.slug, parsed.fields);
  }

  const entries: ProfileDiffEntry[] = [];
  const fileSlugs = new Set<string>();
  for (const p of fileProfiles) {
    fileSlugs.add(p.slug);
    const toolNames = p.tools.map((t) => t.name);
    const server = serverBySlug.get(p.slug);
    if (server === undefined) {
      entries.push({ slug: p.slug, kind: "create", changedFields: [], toolNames, promptCharDelta: null });
      continue;
    }
    const changedFields: string[] = [];
    if (server.display_name !== p.display_name) changedFields.push("display_name");
    let promptCharDelta: { from: number; to: number } | null = null;
    if (server.static_system_prompt !== p.static_system_prompt) {
      changedFields.push("static_system_prompt");
      promptCharDelta = { from: (server.static_system_prompt ?? "").length, to: p.static_system_prompt.length };
    }
    if (JSON.stringify(server.allowed_tiers ?? null) !== JSON.stringify(p.allowed_tiers)) changedFields.push("allowed_tiers");
    if (server.max_input_tokens !== p.max_input_tokens) changedFields.push("max_input_tokens");
    if (server.max_output_tokens !== p.max_output_tokens) changedFields.push("max_output_tokens");
    entries.push({
      slug: p.slug,
      kind: changedFields.length > 0 ? "updated" : "unchanged",
      changedFields,
      toolNames,
      promptCharDelta,
    });
  }

  const retainedProfiles: string[] = [];
  for (const slug of serverBySlug.keys()) {
    if (!fileSlugs.has(slug)) retainedProfiles.push(slug);
  }

  return { entries, retainedProfiles };
}
