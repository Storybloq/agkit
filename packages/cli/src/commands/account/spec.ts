// `account` noun (T-215 L2-CLI-10, A-register account.get / account.usage). A MULTI-verb read-only
// noun surfaced as `agkit account <get|usage>` (NOT bare — it has more than one visible command,
// and neither `get`… wait: `get` IS a READ_VERB, but the noun is multi-verb so it never surfaces
// bare — the singleton-read rule requires a SINGLE visible command). Both verbs are SR remote
// passthrough reads: the shell resolves the credential from the scope and threads no {pid} (the
// account plane paths carry none — the token anchors the account server-side). No ceremony, no
// --yes.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { accountGet, accountGetArgs } from "./get";
import { accountUsage, accountUsageArgs } from "./usage";
import { accountSecurity, accountSecurityArgs } from "./security";

export const accountCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "account",
    verb: "get",
    summary: "Show the account profile.",
    args: accountGetArgs,
    scopes: ["account:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("account", "get"),
    examples: ["agkit account get"],
    handler: accountGet,
    execution: "remote",
  }),
  defineCommand({
    noun: "account",
    verb: "usage",
    summary: "Show account-level usage.",
    args: accountUsageArgs,
    scopes: ["usage:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("account", "usage"),
    examples: ["agkit account usage"],
    handler: accountUsage,
    execution: "remote",
  }),
  // T-223 (canonical L2-CLI-22) — the human door to the dashboard-session-only security ceremonies.
  // An SR read that emits (a) a LIVE-derived deep link to the dashboard's account-security page and
  // (b) the honest token facts of the calling credential. It is NOT a passthrough read: there is no
  // security route on the management wire (those ceremonies are excluded from the API by design).
  defineCommand({
    noun: "account",
    verb: "security",
    summary:
      "Print the dashboard account-security page link (TOTP, password) and report what this credential can actually do.",
    args: accountSecurityArgs,
    // The `whoami` precedent (auth-annotated): `whoami.get` requires NO scope, and deriving the
    // dashboard origin from the AS metadata needs none either — declaring one would be theater
    // (it would gate a command on a permission the wire never checks).
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("account", "security"),
    examples: ["agkit account security"],
    handler: accountSecurity,
    // D-EXEC: BOTH halves are server-derived (the AS-metadata origin + the whoami self-lookup), so
    // this is `remote` — an offline "success" printing `url: null` would be a silent no-op. Fail loud.
    execution: "remote",
    mcpExclude:
      "human browser deep-link + auth self-lookup (N-011 A003 class): prints a dashboard-session URL a token principal cannot use and principal facts the whoami self-lookup already owns",
  }),
];
