// T-221 — the PURE plan-change builders `agkit init` feeds to `plan.create`. No I/O, no `Ctx`
// beyond the project id, no vocabulary of its own.
//
// CATALOG CUSTODY (the single rule this file exists to keep): a `model_route.defaults` row's
// `route` member IS the frozen `model_route_create_request` body — the contract $ref's the create
// $def, so a client pipes it VERBATIM (`model_route_default.$comment`, route-defaults.ts:10-15).
// This builder therefore performs ZERO transformation on it: no member is read, renamed,
// defaulted, reordered or dropped. That is also why the CLI can build a realization-complete route
// while naming no provider/model/tier/execution-target itself — the bytes are the server's.
//
// Paths come from the typed client's route renderer (A-16), never hand-assembled.
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";

/** `project:create` — the account-plane change (body per the frozen `project_create_request`). */
export function projectCreateChange(name: string): PlanChange {
  return { action: "create", resource: "project", path: renderRoutePath("project.create", {}), body: { name } };
}

/**
 * `provider_credential:create` — the secret-bearing change. The frozen
 * `provider_credential_create_request` requires BOTH `{provider, api_key}`. The key exists ONLY as
 * this body member: it never rides argv, never a reconstructed invocation, never an error. The
 * server stores plan-change secrets sealed and renders `(secret)` in changes + diff, and the CLI's
 * redaction chokepoint masks `api_key` by field name — two independent custodies.
 */
export function credentialCreateChange(pid: string, provider: string, apiKey: string): PlanChange {
  return {
    action: "create",
    resource: "provider_credential",
    path: renderRoutePath("credential.create", { pid }),
    body: { provider, api_key: apiKey },
  };
}

/**
 * `provider_credential:update` — the ROTATE change (the CHANGE_TABLE row reuses the create $def,
 * so the body is the same required pair; provider-key/rotate.ts is the byte-verified precedent).
 * Only reachable on EXPLICIT rotation intent: init never rotates a live credential by default.
 */
export function credentialRotateChange(pid: string, provider: string, apiKey: string): PlanChange {
  return {
    action: "update",
    resource: "provider_credential",
    path: renderRoutePath("credential.rotate", { pid, provider }),
    body: { provider, api_key: apiKey },
  };
}

/**
 * `model_route:create` × N — one change per SELECTED catalog row, each body the row's `route`
 * piped VERBATIM. `routes` is already the absent-only, credential-satisfied selection
 * (defaults.ts); this function makes no selection decision of its own.
 */
export function modelRouteCreateChanges(pid: string, routes: readonly Readonly<Record<string, unknown>>[]): PlanChange[] {
  const path = renderRoutePath("model_route.create", { pid });
  return routes.map((route) => ({ action: "create", resource: "model_route", path, body: route }));
}
