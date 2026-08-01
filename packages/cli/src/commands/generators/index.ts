// The four generators, all fed by the ONE registry (T-204 deliverable 4). The
// yargs shell (4a) lives in src/cli/ (it needs the runtime Ctx); the three pure
// artifact generators (4b/4c/4d) are re-exported here for the `agkit reference`
// command, build scripts, and downstream consumers (T-CLI-19, L3-M1).
export { renderReferenceMarkdown } from "./reference-md";
export { renderReferenceJson, type ReferenceJson, type ReferenceJsonCommand } from "./reference-json";
export {
  mcpProjection,
  mcpToolList,
  type McpProjection,
  type McpTool,
  type McpNounDiscriminator,
} from "./mcp-metadata";
