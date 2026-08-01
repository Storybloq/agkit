// `api` noun (T-222 step 10c, L2-CLI-20) — the RAW WIRE DOOR surfaced as
// `agkit api <get|post|put|patch|delete> <path>`. An escape hatch for management endpoints the typed
// commands don't yet cover: it forwards an operator <method, path> through the SAME credential /
// guard / refresh / classification / version-fence / redaction pipeline as the typed client (the 10b
// `ctx.client.raw` door), confined by `validateRawPath` to `/v1/management` OUTSIDE the OAuth subtree.
//
//   • `get`                     (SR)  — a raw read; query rides inline in `<path>` (no --input/--field).
//   • `post`/`put`/`patch`/`delete` (M) — raw mutations, each an M-class `direct` ceremony (Seam-1):
//                                          the CLI cannot know a raw route's true danger, so its OWN
//                                          gate is honestly M (y/N when interactive, `--yes` fuse,
//                                          non-TTY halt); the SERVER owns real plan/apply/D-PR gating.
//
// SECRET CUSTODY: the request BODY is out-of-band ONLY (`--input <file|->`); `--field` sets
// allowlisted non-secret QUERY params; both are elided from any reconstructed invocation. All five
// are mcpExcluded — MCP agents get typed, scope-audited tools; a raw HTTP door would bypass
// tool-level labeling (SECURE-outranks; T-226 may revisit the read exclusion with the tool inventory).
//
// Uppercase verb aliases (`GET`/`POST`/…) let the HTTP method be typed in its familiar case. Every
// row declares `scopes: []` (the raw route's scope is server-enforced; the CLI cannot know it) yet
// consumes the credential via `commandConsumesCredential(noun === "api")` (build-cli).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { API_ELIDE_FLAGS } from "./shared";
import { apiGet, apiGetArgs } from "./get";
import { apiPost, apiPostPreview } from "./post";
import { apiPut, apiPutPreview } from "./put";
import { apiPatch, apiPatchPreview } from "./patch";
import { apiDelete, apiDeletePreview } from "./delete";
import { apiMutationArgs } from "./shared";

const READ_MCP_EXCLUDE =
  "raw wire escape hatch — MCP agents get typed, scope-audited tools; a raw HTTP door would bypass tool-level labeling";
const MUTATION_MCP_EXCLUDE =
  "raw wire escape hatch — returns no Plan; typed MCP tools own the agent surface";

export const apiCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "api",
    verb: "get",
    summary: "Send a raw GET to a management path (escape hatch; query rides inline in <path>).",
    args: apiGetArgs,
    positional: { key: "path", name: "path" },
    aliases: ["GET"],
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("api", "get"),
    examples: ["agkit api get /v1/management/audit?limit=50"],
    handler: apiGet,
    execution: "remote",
    mcpExclude: READ_MCP_EXCLUDE,
  }),
  defineCommand({
    noun: "api",
    verb: "post",
    summary: "Send a raw POST to a management path (body via --input; M-class confirm).",
    args: apiMutationArgs,
    positional: { key: "path", name: "path" },
    aliases: ["POST"],
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("api", "post"),
    examples: ["agkit api post /v1/management/projects --input ./body.json"],
    handler: apiPost,
    execution: "remote",
    mutation: { kind: "direct", preview: apiPostPreview },
    elideFlags: API_ELIDE_FLAGS,
    mcpExclude: MUTATION_MCP_EXCLUDE,
  }),
  defineCommand({
    noun: "api",
    verb: "put",
    summary: "Send a raw PUT to a management path (body via --input; M-class confirm).",
    args: apiMutationArgs,
    positional: { key: "path", name: "path" },
    aliases: ["PUT"],
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("api", "put"),
    examples: ["agkit api put /v1/management/projects/example-id --input ./body.json"],
    handler: apiPut,
    execution: "remote",
    mutation: { kind: "direct", preview: apiPutPreview },
    elideFlags: API_ELIDE_FLAGS,
    mcpExclude: MUTATION_MCP_EXCLUDE,
  }),
  defineCommand({
    noun: "api",
    verb: "patch",
    summary: "Send a raw PATCH to a management path (body via --input; M-class confirm).",
    args: apiMutationArgs,
    positional: { key: "path", name: "path" },
    aliases: ["PATCH"],
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("api", "patch"),
    examples: ["agkit api patch /v1/management/projects/example-id --input ./body.json"],
    handler: apiPatch,
    execution: "remote",
    mutation: { kind: "direct", preview: apiPatchPreview },
    elideFlags: API_ELIDE_FLAGS,
    mcpExclude: MUTATION_MCP_EXCLUDE,
  }),
  defineCommand({
    noun: "api",
    verb: "delete",
    summary: "Send a raw DELETE to a management path (M-class confirm).",
    args: apiMutationArgs,
    positional: { key: "path", name: "path" },
    aliases: ["DELETE"],
    scopes: [],
    danger: "M",
    outputSchemaId: outputSchemaId("api", "delete"),
    examples: ["agkit api delete /v1/management/projects/example-id"],
    handler: apiDelete,
    execution: "remote",
    mutation: { kind: "direct", preview: apiDeletePreview },
    elideFlags: API_ELIDE_FLAGS,
    mcpExclude: MUTATION_MCP_EXCLUDE,
  }),
];
