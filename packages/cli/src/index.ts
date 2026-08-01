// Library surface. The typed management client + handlers re-export here (T-211);
// the scaffold exposes the version/runtime primitives so consumers and the
// drift/conformance suite (T-225) have a stable anchor.
export { VERSION, IS_DEV } from "./version";
export { assertNodeVersion, isSupportedNode } from "./runtime-gate";
export { createMcpServer } from "./mcp";

// CommandSpec registry + generators (T-204). The registry is the single source
// of truth; downstream tickets consume its projections: T-CLI-19 the Markdown
// catalog, L3-M1 the MCP tool metadata, and the drift-lock the machine registry.
export type {
  CommandSpec,
  CommandResult,
  CommandHandler,
  Ctx,
  ManagementClient,
  Scope,
  Danger,
  PromptSpec,
  TypedConfirm,
  BuildFlag,
} from "./commands/types";
export { registry, visibleCommands, reservedCommands, assembleRegistry } from "./commands/registry";
export { VERB_VOCABULARY, SCOPE_FAMILIES } from "./commands/vocab";
export {
  renderReferenceMarkdown,
  renderReferenceJson,
  mcpProjection,
  mcpToolList,
} from "./commands/generators/index";
