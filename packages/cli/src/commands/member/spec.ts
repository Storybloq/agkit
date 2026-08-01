// `member` noun (T-215 L2-CLI-10, Deliverable 3). The ONE visible command is the `list` READ verb,
// so the noun surfaces BARE as `agkit member` (the C-6 singleton-read rule — shared command-path
// logic, no drift). In a SHIP_RESERVED build the reserved `member update` / `member remove`
// (T-210's teams tree) join the noun and the bare surface automatically collapses to
// `agkit member list` — existing command-path behavior, asserted in the plane fixture (step 9).
// Member WRITE verbs live ONLY in the reserved tree (compiled out of shipped binaries); T-215 adds
// none. No aliases are added anywhere in T-215.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { memberList, memberListArgs } from "./list";

export const memberCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "member",
    verb: "list",
    summary: "List the account's team members.",
    args: memberListArgs,
    scopes: ["account:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("member", "list"),
    // Bare surface (singleton read group): the canonical invocation is `agkit member`.
    examples: ["agkit member"],
    handler: memberList,
    execution: "remote",
  }),
];
