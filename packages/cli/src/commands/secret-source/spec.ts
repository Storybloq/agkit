// `secret-source` noun (T-227 S5b / D0-H v2) — the OPERATOR ALLOWLIST for indirect secret sources.
// A multi-verb LOCAL noun: `agkit secret-source <add|list|remove>` operates on the per-profile
// `secret_sources` list in the NON-secret `config.json`. It maps to no management route and touches
// no server, so `scopes` is empty and `execution` is "local" — the `config`/`profile` noun shape.
//
// DANGER CLASSES follow the `config set`/`config unset` precedent VERBATIM (config/spec.ts): `list`
// is a safe read (SR); `add`/`remove` are LOCAL mutations (M) and deliberately NOT D. There is no
// wire resource and no server to re-verify a typed confirm, and both directions are trivially
// reversible by re-running the other — so the D→typed-confirm ceremony would be wrong here exactly
// as it is for a config key. (The dangerous direction is guarded elsewhere and structurally: what a
// declaration authorizes is only ever READ, only of a source the operator named, and only through
// the inode-bound ladder in `core/config/secret-sources`.)
//
// EVERY VERB IS mcpExcluded, and that is the SECURITY property this noun exists to have — including
// `list`, which is otherwise a harmless read. An MCP host that could declare a source would expand
// its OWN read authority (the allowlist is the only thing standing between a `{source:"env",name}`
// reference and an arbitrary read of the operator's environment), and one that could enumerate the
// allowlist would learn exactly which names and paths are worth naming. The reason string is the
// constant exported beside the mechanism (`SECRET_SOURCE_MCP_EXCLUDE`), never a copy: the rationale
// travels with the code that depends on it.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { SECRET_SOURCE_MCP_EXCLUDE } from "../../core/config";
import { secretSourceAdd, secretSourceAddArgs } from "./add";
import { secretSourceList, secretSourceListArgs } from "./list";
import { secretSourceRemove, secretSourceRemoveArgs } from "./remove";

export const secretSourceCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "secret-source",
    verb: "list",
    summary: "List the declared indirect secret sources for the active profile (names and paths only; never values).",
    args: secretSourceListArgs,
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("secret-source", "list"),
    examples: ["agkit secret-source list"],
    handler: secretSourceList,
    mcpExclude: SECRET_SOURCE_MCP_EXCLUDE,
    execution: "local",
  }),
  defineCommand({
    noun: "secret-source",
    verb: "add",
    summary:
      "Declare an env var or a file as a secret source the MCP surface may reference (a declaration holds no secret material).",
    args: secretSourceAddArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("secret-source", "add"),
    examples: [
      "agkit secret-source add --env EXAMPLE_LLM_KEY",
      "agkit secret-source add --file /etc/agentkit/example-llm.key",
    ],
    handler: secretSourceAdd,
    mcpExclude: SECRET_SOURCE_MCP_EXCLUDE,
    execution: "local",
  }),
  defineCommand({
    noun: "secret-source",
    verb: "remove",
    summary: "Withdraw a declared secret source (indirect references to it stop being honored).",
    args: secretSourceRemoveArgs,
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("secret-source", "remove"),
    examples: [
      "agkit secret-source remove --env EXAMPLE_LLM_KEY",
      "agkit secret-source remove --file /etc/agentkit/example-llm.key",
    ],
    handler: secretSourceRemove,
    mcpExclude: SECRET_SOURCE_MCP_EXCLUDE,
    execution: "local",
  }),
];
