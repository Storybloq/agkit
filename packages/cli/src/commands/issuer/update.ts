// `issuer update <id> [config flags]` args + plan-change builder (T-216 R10; issuers:write,
// danger PR). Plan-kind over the executable `issuer:update` CHANGE_TABLE entry (the wire route is
// plan_required — the only legal write path). The arg surface is `.strict()` with EXACTLY the six
// `issuer_update_request` properties (kebab flags → snake body, the F0 mapping style) — there is
// deliberately NO `kind` key (R50 / FORBIDDEN 2: issuer kind is IMMUTABLE; `--kind anything`
// fails the strict zod parse in runSpec → CLI-local usage_error through the existing serializer
// chokepoint, ZERO wire calls, ZERO new error-rendering code). The $def's `minProperties:1` is
// mirrored client-side (at least one config flag). PEM: `--public-key` is an INLINE string (the
// F0 issuer-create precedent — no file seam). Per-kind requiredness stays SERVER-validated
// against the stored kind (the $def's own $comment); the CLI never re-derives it.
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

/** The six issuer_update_request config members, as kebab CLI flags. */
const CONFIG_KEYS = ["issuer", "jwks-uri", "audience", "firebase-project-id", "public-key", "algorithm"] as const;

export const issuerUpdateArgs = z
  .object({
    id: z.string().min(1).describe("Trusted-issuer id to update."),
    issuer: z.string().min(1).optional().describe("Issuer URL (the `iss` claim to trust)."),
    "jwks-uri": z.string().optional().describe("JWKS endpoint publishing the issuer's signing keys."),
    audience: z.string().optional().describe("Expected audience for tokens from this issuer."),
    "firebase-project-id": z.string().min(1).optional().describe("The Firebase project id whose tokens to trust."),
    "public-key": z.string().min(1).optional().describe("PEM/SPKI public key for single-key token verification."),
    algorithm: z
      .enum(["RS256", "ES256", "EdDSA"])
      .optional()
      .describe("Signing algorithm for the public key."),
    confirm: z
      .string()
      .min(1)
      .optional()
      .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony)."),
  })
  .strict()
  .superRefine((val, refCtx) => {
    // Mirror the $def's minProperties:1 — an empty update is refused client-side, teachably.
    const record = val as Record<string, unknown>;
    if (CONFIG_KEYS.every((k) => record[k] === undefined)) {
      refCtx.addIssue({
        code: "custom",
        message:
          "nothing to update — pass at least one config flag (--issuer, --jwks-uri, --audience, --firebase-project-id, --public-key, --algorithm)",
      });
    }
  });
export type IssuerUpdateInput = z.infer<typeof issuerUpdateArgs>;

/** kebab flag → snake wire member (the F0 mapping style, explicit — never a generic transform). */
const WIRE_MEMBER: Readonly<Record<(typeof CONFIG_KEYS)[number], string>> = {
  issuer: "issuer",
  "jwks-uri": "jwks_uri",
  audience: "audience",
  "firebase-project-id": "firebase_project_id",
  "public-key": "public_key",
  algorithm: "algorithm",
};

/** The PURE change builder (`PlanMutation.changes`). Re-parses defensively — never trusts call order. */
export function issuerUpdateChanges(input: unknown, ctx: Ctx): PlanChange[] {
  const parsed = issuerUpdateArgs.parse(input);
  const record = parsed as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = record[key];
    if (value !== undefined) body[WIRE_MEMBER[key]] = value;
  }
  return [
    {
      action: "update",
      resource: "issuer",
      path: renderRoutePath("issuer.update", { pid: requireProject(ctx), id: parsed.id }),
      body,
    },
  ];
}
