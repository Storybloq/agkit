// `whoami` noun (T-206; N-011 §APX-A A003 `whoami.get`). Like `version`, it is a
// singleton noun whose one visible command is the canonical read (`get`), so the
// yargs generator surfaces it as the BARE command `agkit whoami`.
//
// It is an AUTH-annotated row (N-011 §APX-A: `whoami`/`self` carry `scope —` and
// are EXCLUDED from the scope-completeness lock), so `scopes` is empty — but the
// shell still resolves the local credential for it (build-cli
// `commandConsumesCredential`) because it REPORTS the source. It maps to no
// management resource route, so it carries `mcpExclude` (cross-cutting, like
// `version`). T-211 landed the best-effort server identity enrichment (see get.ts).
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { whoamiGet, whoamiGetArgs } from "./get";

export const whoamiCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "whoami",
    verb: "get",
    summary: "Report the active agkit credential (local source, enriched with the server identity when reachable).",
    args: whoamiGetArgs,
    scopes: [], // auth-annotated (N-011 A003): bearer-any, scope —, excluded from the scope lock
    danger: "SR",
    outputSchemaId: outputSchemaId("whoami", "get"),
    examples: ["agkit whoami"],
    handler: whoamiGet,
    mcpExclude: "cross-cutting auth self-lookup (N-011 A003); not a management resource tool",
    execution: "local", // local-first (T-210): the LOCAL credential is the answer; T-211's identity enrichment is best-effort and never gates the command.
  }),
];
