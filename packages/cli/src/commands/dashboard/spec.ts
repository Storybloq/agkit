// The `dashboard` noun (T-222, canonical L2-CLI-20). One BARE command: `agkit dashboard [page]` —
// opens the management dashboard (optionally deep-linked to a page) in the user's browser. Danger SR
// (it opens a local browser; it sends no credential and mutates nothing on the wire) and
// `execution:"local"`. The dashboard ORIGIN is SERVER-OWNED and DERIVED live from AS-metadata
// (D-10) — never a hardcoded constant. `mcpExclude` keeps a human browser-launch off the agent tool
// surface. The exfiltration guard still runs (S6): opening a browser at an env-poisoned
// `AGKIT_API_URL`-derived origin is a phishing vector, so SECURE-outranks and the guard gates it.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { dashboardOpen, dashboardOpenArgs } from "./open";

export const dashboardCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "dashboard",
    verb: "open",
    bare: true, // `agkit dashboard` — the ONLY visible command for the noun (load-check enforced)
    summary: "Open the management dashboard (optionally a page) in your browser.",
    args: dashboardOpenArgs,
    // OPTIONAL positional (T-216 S3): a present token names the dashboard page; an absent one opens
    // the dashboard root. The closed page grammar is enforced in the handler (a bad page → a static
    // usage_error, BEFORE any network I/O).
    positional: { key: "page", name: "page", optional: true },
    scopes: [],
    danger: "SR",
    outputSchemaId: outputSchemaId("dashboard", "open"),
    examples: ["agkit dashboard", "agkit dashboard account/security"],
    handler: dashboardOpen,
    execution: "local", // no wire call — a browser launch off a derived origin
    mcpExclude: "opens a local browser — human surface",
  }),
];
