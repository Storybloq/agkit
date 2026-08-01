// `billing` noun (T-215 L2-CLI-10). A MULTI-verb noun surfaced as
// `agkit billing <info|plans|checkout|portal>`:
//   • `info`  (billing.get, billing:read, SR)   — the current billing state, DB truth verbatim.
//   • `plans` (billing.plans, billing:read, SR)  — the available-plan catalog = DB truth; the CLI
//                                                  ships NO catalog / prices / CRUD (FORBIDDEN-4).
//   • `checkout` / `portal` (billing:write, M)   — the money-path Stripe ceremonies (step 5): each
//                                                  is an M-class `direct` mutation (Seam-1) that
//                                                  runs the M confirm and returns a Stripe-hosted
//                                                  URL for a HUMAN to open (never a Plan → mcpExclude).
//
// OD-M (documented, NOT built): `billing:write` has NO wire step-up / sudo re-auth. No route row or
// managementAuth chain carries a step-up marker; insufficient scope surfaces as the generic
// `scope_insufficient` (403, `WWW-Authenticate: Bearer error="insufficient_scope"`). The CLI adds
// NO synthetic re-auth step — inventing one would be theater the server does not enforce.
//
// Account-plane: none of these carry a {pid}; the token anchors the account server-side, so no
// requireProject runs for any billing command.
import { defineCommand, type AnyCommandSpec } from "../types";
import { outputSchemaId } from "../vocab";
import { billingInfo, billingInfoArgs } from "./info";
import { billingPlans, billingPlansArgs } from "./plans";
import { billingCheckout, billingCheckoutArgs, billingCheckoutPreview } from "./checkout";
import { billingPortal, billingPortalArgs, billingPortalPreview } from "./portal";

export const billingCommands: AnyCommandSpec[] = [
  defineCommand({
    noun: "billing",
    verb: "info",
    summary: "Show the current billing state.",
    args: billingInfoArgs,
    scopes: ["billing:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("billing", "info"),
    examples: ["agkit billing info"],
    handler: billingInfo,
    execution: "remote",
  }),
  defineCommand({
    noun: "billing",
    verb: "plans",
    summary: "List the available billing plans (server truth; no local catalog).",
    args: billingPlansArgs,
    scopes: ["billing:read"],
    danger: "SR",
    outputSchemaId: outputSchemaId("billing", "plans"),
    examples: ["agkit billing plans"],
    handler: billingPlans,
    execution: "remote",
  }),
  defineCommand({
    noun: "billing",
    verb: "checkout",
    summary: "Start a Stripe checkout session for a plan (returns a URL to open in a browser).",
    args: billingCheckoutArgs,
    scopes: ["billing:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("billing", "checkout"),
    // `--plan` is an uninterpreted string; the example omits `--yes` (a global ceremony flag,
    // absent from the strict args schema — every example is parsed against `args` at registry load).
    examples: ["agkit billing checkout --plan pro"],
    handler: billingCheckout,
    execution: "remote",
    // Seam-1: the M-class direct ceremony (no plan, no typed challenge) — runs the M y/N confirm.
    mutation: { kind: "direct", preview: billingCheckoutPreview },
    // D-6 / R-E: excluded from MCP as a REASON STRING (never `true`) — it returns a browser URL for
    // a human Stripe ceremony, never a Plan, so an `agkit_billing_plan` tool would be a
    // label-by-reality lie.
    mcpExclude:
      "human browser ceremony — returns a Stripe checkout URL for a human to open; never a Plan",
  }),
  defineCommand({
    noun: "billing",
    verb: "portal",
    summary: "Open the Stripe billing portal (returns a URL to open in a browser).",
    args: billingPortalArgs,
    scopes: ["billing:write"],
    danger: "M",
    outputSchemaId: outputSchemaId("billing", "portal"),
    examples: ["agkit billing portal"],
    handler: billingPortal,
    execution: "remote",
    mutation: { kind: "direct", preview: billingPortalPreview },
    mcpExclude:
      "human browser ceremony — returns a Stripe billing-portal URL for a human to open; never a Plan",
  }),
];
