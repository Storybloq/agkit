// Client-side tool `parameter_schema` validator (T-218 §3.4, R3). Mirrors the server's
// `validateStoredToolSchema` (packages/management-core/src/tool-schema-validate.ts) BY CONTRACT —
// same size cap (65536 serialized bytes), same depth cap (100), same shape rules (plain-object root
// with `type:"object"` + a plain `properties` object), same ORDER (size → shape → depth), and the
// same ITERATIVE explicit-stack depth walk (a recursive walk would inherit the very stack overflow
// the cap is meant to prevent — the server's own rationale). No vendoring: this is pure TS, the
// server code is never imported at runtime; a cross-package boundary-parity TEST (tool-schema.parity)
// pins CLI-verdict ≡ server-verdict over the full boundary matrix (65536 pass / 65537 fail; depth 100
// pass / 101 fail; array root; missing properties; type:"array"; non-object root; non-serializable),
// so a future server re-freeze that drifts either cap reddens the suite.
//
// This exists so `agent-tool create` / `agent-tool update` and `agent sync` REJECT an over-cap /
// mis-shaped schema CLIENT-SIDE (a teachable usage_error, exit 2, ZERO wire calls) rather than
// paying a server 422/400 on every invocation. The server stays the FINAL authority (bytes over
// claims); the CLI only front-runs the identical rules.
//
// Value confinement (A-1): the verdict is a CLOSED violation CLASS, never the schema contents. The
// caller renders `<location>: parameter_schema <class>` — the location (a structural path like
// `profiles[2].tools[0]` or a tool name the operator typed) + the class, never a schema value.
import { CliLocalError } from "../../core/errors";

/** Mirrors the server's MAX_SCHEMA_SIZE (dashboard tool-validation byte cap). A schema AT the cap passes. */
const MAX_SCHEMA_SIZE = 65536;
/** Mirrors the server's MAX_SCHEMA_DEPTH (tool-schema-export bound). Root sits at depth 1; a value
 *  reached PAST this depth is the first over-limit node. */
const MAX_SCHEMA_DEPTH = 100;

/** The closed set of violation classes — value-free, stable, and mapped 1:1 to the server's reasons. */
export type ToolSchemaViolation =
  | "not-serializable"
  | "size-limit"
  | "not-object"
  | "root-type"
  | "no-properties"
  | "depth-limit";

export type ToolSchemaVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: ToolSchemaViolation };

/** A human, value-free phrase for each violation class (rendered after a `<location>: parameter_schema ` prefix). */
export const TOOL_SCHEMA_VIOLATION_PHRASE: Readonly<Record<ToolSchemaViolation, string>> = {
  "not-serializable": "is not serializable JSON",
  "size-limit": `exceeds the ${MAX_SCHEMA_SIZE}-byte size limit`,
  "not-object": 'must be a JSON object',
  "root-type": 'root type must be "object"',
  "no-properties": 'must have a "properties" object',
  "depth-limit": `exceeds the ${MAX_SCHEMA_DEPTH}-level nesting depth limit`,
};

/**
 * Validate a tool `parameter_schema` against the server's stored-schema caps, BY CONTRACT. Returns
 * `{ ok: true }` when within size/shape/depth bounds, else `{ ok: false, reason }` naming the FIRST
 * violation class (never the schema contents). Never throws — a pathological input is a verdict, not
 * a crash (the depth walk is iterative over objects AND arrays).
 */
export function validateToolParameterSchema(schema: unknown): ToolSchemaVerdict {
  // (a) Serialized size — matches the server's byte cap on the JSON text.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return { ok: false, reason: "not-serializable" };
  }
  // JSON.stringify returns undefined for a top-level undefined/function; the shape check below
  // rejects those anyway, but treat an unserializable root as size-0 rather than reading `.length`
  // off undefined (exactly the server's guard).
  if (serialized !== undefined && serialized.length > MAX_SCHEMA_SIZE) {
    return { ok: false, reason: "size-limit" };
  }

  // (c) Shape — plain-object root with type:"object" and a plain `properties` object. Checked
  // before the depth walk so a wrong-shaped root fails with a precise class (server order).
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, reason: "not-object" };
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== "object") {
    return { ok: false, reason: "root-type" };
  }
  const props = root.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return { ok: false, reason: "no-properties" };
  }

  // (b) Depth — ITERATIVE explicit-stack walk over objects AND arrays. Root at depth 1; a value
  // reached PAST MAX_SCHEMA_DEPTH is rejected (a container reached at depth 101 is the first
  // over-limit node — exactly the server's `depth > MAX_SCHEMA_DEPTH` check).
  const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (Array.isArray(value)) {
      if (depth > MAX_SCHEMA_DEPTH) return { ok: false, reason: "depth-limit" };
      for (const item of value) {
        if (item !== null && typeof item === "object") stack.push({ value: item, depth: depth + 1 });
      }
    } else if (value !== null && typeof value === "object") {
      if (depth > MAX_SCHEMA_DEPTH) return { ok: false, reason: "depth-limit" };
      for (const child of Object.values(value as Record<string, unknown>)) {
        if (child !== null && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
    // Primitives / null: leaves.
  }

  return { ok: true };
}

/**
 * Validate a tool `parameter_schema`, throwing a value-free `usage_error` on any violation. The
 * message is `<location>: parameter_schema <class>` — the caller-supplied structural LOCATION (e.g.
 * `--parameter-schema` for a single command, or `profiles[2].tools[0]` for a sync entry) + the
 * closed violation class, NEVER the schema contents (A-1). Used by the tool create/update builders
 * and the sync prepare's per-tool step; the pure `validateToolParameterSchema` above is what the
 * cross-package parity test pins against the server verdict.
 */
export function assertToolParameterSchema(schema: unknown, location: string): void {
  const verdict = validateToolParameterSchema(schema);
  if (!verdict.ok) {
    throw new CliLocalError("usage_error", {
      detail: `${location}: parameter_schema ${TOOL_SCHEMA_VIOLATION_PHRASE[verdict.reason]}`,
    });
  }
}
