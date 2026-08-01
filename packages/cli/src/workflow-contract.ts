// The WORKFLOW CONTRACT (T-227 R13b, re-carried by T-300 R6) — the five-line micro-skill that
// tells an agent how to drive `agkit` before it has learned anything from the roster: which tool
// to call first, which calls are free, the plan→show→apply shape of every mutation, where the
// human-approval line sits, and that a confirm value is READ, never guessed.
//
// WHY IT LIVES IN ITS OWN LEAF. The lines have TWO carriers and must have ONE author:
//   1. `src/mcp.ts` joins them into `SERVER_INSTRUCTIONS` — the SDK's `instructions` member, which
//      rides the legacy `InitializeResult` AND the modern `DiscoverResult` from one field.
//   2. `src/core/config/status.ts` puts the array itself in the status document as `workflow`, so
//      both surfaces that read status (`agkit status --json` and the `agkit_status` tool) carry it.
// A second authoring site would let the two carriers drift; every consumer imports from here.
//
// WHY THE SECOND CARRIER EXISTS (T-300 R6). On the modern (2026-07-28) era the opening exchange is
// `server/discover`, and a client MAY skip it — nothing in the protocol compels the call, so
// `instructions` is no longer guaranteed to reach an agent before its first tool call. This module
// does not restore that guarantee and nothing here should claim it does. What the `workflow` field
// restores is the weaker, honest one: a client that follows LINE 1 ("Call agkit_status first")
// receives the contract in its first `agkit_status` result, whichever era it speaks and whether or
// not it read the opening exchange. A client that calls neither is served by neither — we
// recommend, we do not coerce.
//
// EVERY LINE MUST STAY BACKED BY AN ENFORCED BEHAVIOR (§B-2). These are not aspirations: the auth
// gate, the withheld-challenge descriptor and the apply ceremony in `src/mcp/tools.ts` are what
// make each line true. An instruction the tool table does not enforce is a false affordance and
// must be deleted here rather than left to describe a server that does not behave that way.
// The interop smoke pins these exact bytes (via import) in the opening exchange, so a deliberate
// edit moves the pin and an accidental drop breaks it.
export const WORKFLOW_CONTRACT: readonly string[] = [
  "Call agkit_status first: it reports auth, project, server reachability and version skew, and it answers in every session state.",
  "Reads are free: agkit_status and every agkit_*_read tool never mutate anything — call them whenever they help.",
  "Mutate in three steps: create a plan (agkit_*_plan), read its diff (agkit_plan_read, verb 'show'), then agkit_apply it by id.",
  "Plans classed D or PR require human approval: stop and get the operator's explicit go-ahead before applying one.",
  "Never guess a confirm value: read the plan (agkit_plan_read, verb 'show') to see its confirm string, then pass it to agkit_apply.",
];
