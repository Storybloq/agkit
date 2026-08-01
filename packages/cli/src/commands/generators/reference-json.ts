// Generator (c) — `reference --json`, the machine registry (T-204 deliverable
// 4c). This is the artifact L3 / MCP consume: commands, arg schemas (as JSON
// Schema), scopes, danger, output-schema `$id`s, plus each command's MCP
// projection. It includes EVERY command (reserved ones tagged `route_status:
// reserved`) so a consumer can filter — while `--help` and MCP `tools/list`
// exclude reserved (RN-5). Deleting a spec.ts fragment removes the command here
// too (acceptance), because this maps over the same registry array.
//
// Arg schemas are serialized with zod v4's built-in `z.toJSONSchema` (the resolved
// monorepo zod is v4.4.3 — verified against pnpm-lock; no `zod-to-json-schema`
// needed).
import { z } from "zod";
import type { AnyCommandSpec } from "../types";
import { registry } from "../registry";
import { mcpProjection } from "./mcp-metadata";

export interface ReferenceJsonCommand {
  command: string;
  noun: string;
  verb: string;
  aliases: string[];
  summary: string;
  scopes: string[];
  /** The CLI SHELL danger class. For a reserved contract-route command this is the
   *  PROJECTION (projectWireDanger) — the AUTHORITATIVE, exact danger/gating (incl. the
   *  compound "PR+D" and both kill-switch branches) is `reservedRoute` (T-210 §E). */
  danger: string;
  outputSchemaId: string;
  examples: string[];
  args: unknown;
  route_status: "implemented" | "reserved";
  confirm: AnyCommandSpec["confirm"] | null;
  prompts: AnyCommandSpec["prompts"];
  reserved: AnyCommandSpec["reserved"] | null;
  /** Where the command executes (T-210). */
  execution: AnyCommandSpec["execution"] | null;
  /** Capabilities the server must advertise (T-210 — reserved commands only). */
  requiredCapabilities: readonly string[] | null;
  /** EXACT byte-pinned contract tuple for a reserved contract-route command; `null`
   *  for visible commands AND for reserved NO-CONTRACT commands (§E.5). */
  reservedRoute: AnyCommandSpec["reservedRoute"] | null;
  mcp: ReturnType<typeof mcpProjection>;
}

export interface ReferenceJson {
  $schema: string;
  generator: string;
  count: number;
  commands: ReferenceJsonCommand[];
}

function argsToJsonSchema(spec: AnyCommandSpec): unknown {
  // z.toJSONSchema is the zod-v4 built-in export (settled design). If a schema
  // can't be represented, surface the reason rather than crash the whole catalog.
  try {
    return z.toJSONSchema(spec.args);
  } catch (err) {
    return { $comment: `unserializable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Build the machine registry object. `agkit reference --json` prints this. */
export function renderReferenceJson(specs: readonly AnyCommandSpec[] = registry): ReferenceJson {
  const commands: ReferenceJsonCommand[] = specs.map((spec) => ({
    command: `${spec.noun} ${spec.verb}`,
    noun: spec.noun,
    verb: spec.verb,
    aliases: spec.aliases ?? [],
    summary: spec.summary,
    scopes: [...spec.scopes],
    danger: spec.danger,
    outputSchemaId: spec.outputSchemaId,
    examples: [...spec.examples],
    args: argsToJsonSchema(spec),
    route_status: spec.reserved ? "reserved" : "implemented",
    confirm: spec.confirm ?? null,
    prompts: spec.prompts,
    reserved: spec.reserved ?? null,
    execution: spec.execution ?? null,
    requiredCapabilities: spec.requiredCapabilities ?? null,
    reservedRoute: spec.reservedRoute ?? null,
    mcp: mcpProjection(spec),
  }));
  return {
    $schema: "https://schemas.agkit.cloud/cli/v1/reference.json",
    generator: "agkit reference --json",
    count: commands.length,
    commands,
  };
}
