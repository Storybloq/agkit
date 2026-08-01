// `issuer create` args + plan-change builder (N-011 A310 → T-212 S7 plan-first retrofit →
// S7 kind-discriminated realization, issuers:write, danger PR). The wire route is
// `plan_required` — plan→apply is the ONLY legal write path (the old direct handler was a
// latent live bug: its POST 403s). The change is the server CHANGE_TABLE's `issuer:create`
// shape: a `create` on the `issuer` resource under the project's trusted-issuers collection.
// The `pid` comes from the resolved project context (F0: `requireProject(ctx)` throws the
// teachable usage_error BEFORE any wire call — the operator sees "select a project", never a
// raw missing-param) and is substituted into the CONCRETE change path by the typed client's
// route renderer (A-16).
//
// The body is the frozen `issuer_create_request` $def realized EXACTLY (management-resources
// .schema.json: kind-discriminated, additionalProperties:false): the argument surface is a
// zod DISCRIMINATED UNION on `--kind`, each branch carrying precisely that kind's $def-required
// fields. This gives a TEACHABLE usage_error client-side (T-207 renderer) BEFORE any wire call
// — a missing `--kind`, or a flag that does not belong to the chosen kind (each branch is
// `.strict()`, mirroring the $def's additionalProperties:false) — rather than a server 422 on
// every invocation. The server's $def stays the FINAL validation authority at plan.create
// (bytes over claims — the CLI never re-derives realization).
//   apple             → reads ONLY `audience` (the Apple issuer is fixed server-side)
//   firebase          → reads ONLY `firebase_project_id`
//   custom_jwks       → `jwks_uri` + `issuer` + `audience`
//   custom_public_key → `public_key` + `issuer` + `audience` + optional `algorithm`
// `algorithm` (server-side single-alg SPKI import) is scoped to custom_public_key ONLY, and
// rides the body ONLY when provided (server defaults RS256 — never a client-forced default).
// Flag names are kebab-case (`--firebase-project-id`, `--jwks-uri`, `--public-key`); the wire
// $def uses snake_case, so the builder maps each verbatim.
//
// `--confirm` semantics (unchanged since the S7 retrofit): the value is the PLAN's
// `confirm_string` (the displayed authority, L-010) — the old `--confirm <project-name>` value
// fails the validate_confirm gate with a teachable re-plan hint.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

/** The plan's confirm string (required to apply a PR plan non-interactively; shown by the
 *  ceremony). Optional per branch — it rides plan.apply, never the change body. */
const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

/** issuer_create_request kinds — the frozen $def's `kind` enum, discriminating the arg surface. */
export const issuerCreateArgs = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("apple"),
      audience: z.string().min(1).describe("Expected audience (the `aud` claim) for Apple identity tokens."),
      confirm: confirmArg,
    })
    .strict(),
  z
    .object({
      kind: z.literal("firebase"),
      "firebase-project-id": z.string().min(1).describe("The Firebase project id whose tokens to trust."),
      confirm: confirmArg,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom_jwks"),
      "jwks-uri": z.string().min(1).describe("JWKS endpoint publishing the issuer's signing keys."),
      issuer: z.string().url().describe("Issuer URL (the `iss` claim to trust)."),
      audience: z.string().min(1).describe("Expected audience for tokens from this issuer."),
      confirm: confirmArg,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom_public_key"),
      "public-key": z.string().min(1).describe("PEM/SPKI public key for single-key token verification."),
      issuer: z.string().url().describe("Issuer URL (the `iss` claim to trust)."),
      audience: z.string().min(1).describe("Expected audience for tokens from this issuer."),
      algorithm: z
        .enum(["RS256", "ES256", "EdDSA"])
        .optional()
        .describe("Signing algorithm for the public key (server defaults RS256 when omitted)."),
      confirm: confirmArg,
    })
    .strict(),
]);
export type IssuerCreateInput = z.infer<typeof issuerCreateArgs>;

/**
 * The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call
 * order — then realizes the frozen `issuer_create_request` body for the chosen kind with ONLY
 * that kind's fields (no undefined keys, no extras — the $def is additionalProperties:false).
 * `kind` is always present; kebab flag names map to the wire's snake_case members.
 */
export function issuerCreateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = issuerCreateArgs.parse(input);
  let body: Record<string, unknown>;
  switch (parsed.kind) {
    case "apple":
      body = { kind: parsed.kind, audience: parsed.audience };
      break;
    case "firebase":
      body = { kind: parsed.kind, firebase_project_id: parsed["firebase-project-id"] };
      break;
    case "custom_jwks":
      body = {
        kind: parsed.kind,
        jwks_uri: parsed["jwks-uri"],
        issuer: parsed.issuer,
        audience: parsed.audience,
      };
      break;
    case "custom_public_key":
      body = {
        kind: parsed.kind,
        public_key: parsed["public-key"],
        issuer: parsed.issuer,
        audience: parsed.audience,
        ...(parsed.algorithm !== undefined ? { algorithm: parsed.algorithm } : {}),
      };
      break;
  }
  return [
    {
      action: "create",
      resource: "issuer",
      path: renderRoutePath("issuer.create", { pid: requireProject(ctx) }),
      body,
    },
  ];
}
