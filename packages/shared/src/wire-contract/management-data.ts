/**
 * Wire-contract MANAGEMENT **DATA** — the bundler-safe half of management/v1.2.0
 * (the served tag; v1.2.0 is an additive minor over the frozen v1.1.0 oracle).
 *
 * SPLIT OUT of ./management.ts (T-200 P6 incident): that module is api-ONLY by
 * design (CON-6) — it fs-reads the contract bundle via `import.meta.url` and
 * eagerly compiles ajv schemas. When the T-200 dashboard surfaces imported its
 * DATA exports (scope registry / token classes / canonical resources) through
 * management-core (scopes.ts, oauth-device.ts), Next bundled the fs loader into
 * the dashboard standalone, webpack inlined `import.meta.url` as the CI BUILD
 * path (/home/runner/…), and every /activate render 500'd at module load
 * (ENOENT) in prod. The fix: the pure DATA (everything sourced from
 * management.json meta — no ajv, no node:fs, no import.meta.url) lives HERE and
 * is loaded via a STATIC JSON import, which every runtime resolves correctly:
 *   - Next/webpack (dashboard, transpilePackages): inlines the JSON into the bundle;
 *   - node --conditions=agentkit-dist (api prod image): plain ESM JSON import
 *     (`with { type: "json" }` is required and supported on node 24); the bundle
 *     rides the image at packages/shared/contract (Dockerfile COPY) and the
 *     specifier resolves through this package's exports map;
 *   - tsx / vitest (dev/test): esbuild/vite JSON modules.
 * The import uses a PACKAGE SELF-REFERENCE (not a relative path) because the
 * contract dir sits OUTSIDE tsconfig rootDir=src — a relative JSON import would
 * fail the dist build (TS6059) and tsc would try to copy the bundle into dist,
 * violating the "the JSON bundle is the source of truth, never compiled in"
 * rule (api Dockerfile:64-66). The self-reference resolves via the
 * "./contract/management/v1.2.0/management.json" exports entry in package.json.
 *
 * ./management.ts re-exports everything here (api import paths unchanged) and
 * keeps the fs-loaded halves: management-errors.json, management-routes.json,
 * and the ajv schema validators — none of which the dashboard may ever import.
 * The dashboard-side regression guards: bundle-safety.guard.test.ts (static
 * import-graph walk) + activate-render.e2e.spec.ts (prod-build render).
 *
 * All validation semantics below are MOVED VERBATIM from management.ts — the
 * same fail-loud throw-at-module-load discipline (a missing/misshapen meta key
 * fails the importer's boot, never lazily at first request).
 */
import managementManifestJson from "@agentkit-cloud/shared/contract/management/v1.2.0/management.json" with { type: "json" };

/**
 * One (family,verb) row of the APX-C scope registry (management.json meta.scope_registry.entries).
 * AUTH-26/OD-A4: the OPEN scope vocabulary the authz layer loads from the bundle — NEVER a code
 * literal. `danger` is the max class over the route ops the scope gates; `prod_rebinding` = the
 * scope gates at least one PR-classed op; `mintable_on_ci` = false only for tokens:write/:destroy
 * (SEC-6 self-replication ban + its ladder closure).
 */
export interface ManagementScopeEntry {
  family: string;
  verb: "read" | "write" | "destroy";
  description: string;
  danger: "SR" | "M" | "D" | "PR";
  prod_rebinding: boolean;
  mintable_on_ci: boolean;
}
/**
 * One token-class row of the 4-class credential model (management.json meta.token_classes.classes).
 * AUTH-64: token-class meta rides management.json meta ONLY (never headers.json). body_len is the
 * 43-char base-62 random body; total_len = prefix.length + body_len (48 legacy / 51 others).
 * ttl_default/ttl_max are mint-time bound strings (null = non-expiring legacy, grandfathered only).
 */
export interface ManagementTokenClass {
  class: "legacy" | "ci" | "access" | "refresh";
  prefix: string;
  body_len: number;
  total_len: number;
  mintable_on_ci: boolean;
  ttl_default: string | null;
  ttl_max: string | null;
  note: string;
}

// ── T-199 (L1-H, D-E2) — canonical-resource SET + AS-metadata pins + error boundary ──
// The OAuth AS machine half (api) reads these through accessors over the vendored
// contract bytes — never a second hand-authored list (the provider_vocabulary
// discipline). management.json meta pins ONLY the SET + mutual-rejection rule + the
// AS-metadata assertion anchors (full 8414 body is the meta.as handler's, D-W1);
// the as_metadata values are PINS (some carry "(A005)"-style annotations and the
// "<dashboard-origin>" placeholder), not servable bytes. Validated at module INIT
// (fail-loud at import, never lazily): the SET must be non-empty unique absolute
// https URLs; code_challenge_methods_supported must be EXACTLY ["S256"] (S256-only
// is a security pin — a widened method list must fail the boot, not silently ship);
// the three error_boundary members must be non-empty prose.

/** The AS-metadata assertion pins (meta.canonical_resources.as_metadata). */
export interface ManagementAsMetadataPins {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  code_challenge_methods_supported: readonly string[];
  note: string;
}

/** The canonical-resource block (meta.canonical_resources) — PL-03's SET + rule. */
export interface ManagementCanonicalResources {
  set: readonly string[];
  mutual_rejection: string;
  as_metadata: Readonly<ManagementAsMetadataPins>;
}

/** The 9457-vs-6749 error-boundary prose (meta.error_boundary) — D-BOUNDARY's anchor. */
export interface ManagementErrorBoundary {
  resource_plane: string;
  oauth_plane: string;
  legacy_flip: string;
}

// The static import gives a giant inferred literal type; the double-cast keeps the
// EXACT typed shape management.ts always asserted (unknown → declared manifest type).
const managementManifest = managementManifestJson as unknown as {
  management_version: string;
  meta: {
    scope_registry: { verb_ladder: string[]; entries: ManagementScopeEntry[] };
    token_classes: { classes: ManagementTokenClass[] };
    // T-196 (D-5/✦R5-4, ✧R8-2): ADDITIVE meta the credential.create handler reads
    // through the accessors below. A missing/misshapen key throws at boot (below),
    // never lazily at first request.
    provider_vocabulary: { providers: string[] };
    credential_field_limits: { api_key_max_utf8_bytes: number; api_key_min_length: number };
    // T-197 (D5): ADDITIVE meta — the EXACT UTF-8 byte ceiling on a media_route `config`
    // pass-through blob, read through mediaRouteConfigMaxBytes() below. A missing/misshapen
    // key throws at boot (below), never lazily at first request.
    media_route_config_limits: { config_max_utf8_bytes: number };
    // T-199 (L1-H, D-E2): the OAuth AS pins the machine half reads through the
    // canonicalResources()/asMetadataPins()/errorBoundary() accessors below —
    // the canonical-resource SET (PL-03), the AS-metadata assertion pins, and
    // the 9457/6749 error-boundary prose. Validated + frozen at module load.
    canonical_resources: {
      set: string[];
      mutual_rejection: string;
      as_metadata: Record<string, unknown>;
    };
    error_boundary: { resource_plane: string; oauth_plane: string; legacy_flip: string };
  };
};

/** Semver of the management contract namespace (served tag: management/v1.2.0). */
export const MANAGEMENT_VERSION: string = managementManifest.management_version;

/**
 * Frozen APX-C scope registry — 48 (family,verb) entries across 20 families (C01-C20), read from
 * management.json meta.scope_registry at module load (T-192 req 6: loaded from the L0-A contract
 * bundle, never a code literal). A missing/misshapen meta key throws HERE at boot, never lazily.
 */
export const MANAGEMENT_SCOPE_REGISTRY: readonly Readonly<ManagementScopeEntry>[] = Object.freeze(
  managementManifest.meta.scope_registry.entries.map((e) => Object.freeze({ ...e })),
);
/**
 * Frozen 4-class token metadata (legacy/ci/access/refresh), read from management.json
 * meta.token_classes at module load (AUTH-64 — never headers.json).
 */
export const MANAGEMENT_TOKEN_CLASSES: readonly Readonly<ManagementTokenClass>[] = Object.freeze(
  managementManifest.meta.token_classes.classes.map((c) => Object.freeze({ ...c })),
);

// ── T-196 provider_vocabulary + credential_field_limits accessors (D-5/✦R5-4/✧R8-2) ──
// The credential.create handler enforces the CLOSED provider set and the secret
// byte-limit from these ACCESSORS over the vendored contract bytes — never a second
// hand-authored code list (✦R5-4: management.json meta IS the single source; the
// accessor IS the "code registry"). Read + frozen ONCE at module load, exactly like
// the scope/token-class registries above, so a missing/misshapen meta key throws HERE
// at boot (fail-loud) rather than lazily at first request. The three-way parity
// (contract meta ⇔ this accessor ⇔ handler acceptance) is pinned by the handler test.
// E11 (codex) — validate the meta at module INIT (fail-loud at import, never lazily
// at first request): provider_vocabulary must be a non-empty array of UNIQUE,
// non-empty strings; api_key_max_utf8_bytes must be a positive integer ≤ 1 MiB;
// api_key_min_length (rev-4 secret-disclosure fix) must be a positive integer in
// [9, 4096] — a code-point minimum that keeps an 8-char masked prefix from equaling
// a whole accepted secret (9 is the smallest value that hides the 9th+ char).
function validateProviderVocabulary(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("wire-contract management: meta.provider_vocabulary.providers must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("wire-contract management: meta.provider_vocabulary.providers must contain only non-empty strings");
    }
    if (seen.has(p)) {
      throw new Error(`wire-contract management: meta.provider_vocabulary.providers has a duplicate entry "${p}"`);
    }
    seen.add(p);
  }
  return Object.freeze([...(raw as string[])]);
}

function validateApiKeyMaxBytes(raw: unknown): number {
  const ONE_MIB = 1024 * 1024;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > ONE_MIB) {
    throw new Error(
      `wire-contract management: meta.credential_field_limits.api_key_max_utf8_bytes must be a positive integer ≤ ${ONE_MIB} (got ${String(raw)})`,
    );
  }
  return raw;
}

// rev-4 (secret-disclosure fix) — the api_key_min_length floor. The 9 lower bound is
// the smallest value that keeps the fixed 8-char display prefix from equaling a WHOLE
// accepted secret (a 9-char secret's 8-char prefix hides the 9th char). 4096 upper
// bound mirrors the max byte ceiling so the min can never exceed a storable secret.
function validateApiKeyMinLength(raw: unknown): number {
  const FLOOR = 9;
  const CEIL = 4096;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < FLOOR || raw > CEIL) {
    throw new Error(
      `wire-contract management: meta.credential_field_limits.api_key_min_length must be a positive integer in [${FLOOR}, ${CEIL}] (got ${String(raw)})`,
    );
  }
  return raw;
}

// T-197 (D5) — the media_route `config` pass-through UTF-8 byte ceiling. Same fail-loud
// discipline as the credential limits above: validated at module INIT (throws at import,
// never lazily), a positive integer in [1024, 1_048_576] (1 KiB floor keeps the ceiling
// meaningful; 1 MiB roof mirrors the credential max-byte bound). The config guard
// (validateMediaRouteConfig, management-core) measures the canonical JSON.stringify UTF-8
// length against this via the accessor below.
function validateConfigMaxBytes(raw: unknown): number {
  const FLOOR = 1024;
  const ONE_MIB = 1024 * 1024;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < FLOOR || raw > ONE_MIB) {
    throw new Error(
      `wire-contract management: meta.media_route_config_limits.config_max_utf8_bytes must be a positive integer in [${FLOOR}, ${ONE_MIB}] (got ${String(raw)})`,
    );
  }
  return raw;
}

const MANAGEMENT_PROVIDER_VOCABULARY: readonly string[] = validateProviderVocabulary(
  managementManifest.meta.provider_vocabulary?.providers,
);
const CREDENTIAL_API_KEY_MAX_UTF8_BYTES: number = validateApiKeyMaxBytes(
  managementManifest.meta.credential_field_limits?.api_key_max_utf8_bytes,
);
const CREDENTIAL_API_KEY_MIN_LENGTH: number = validateApiKeyMinLength(
  managementManifest.meta.credential_field_limits?.api_key_min_length,
);
const MEDIA_ROUTE_CONFIG_MAX_UTF8_BYTES: number = validateConfigMaxBytes(
  managementManifest.meta.media_route_config_limits?.config_max_utf8_bytes,
);

/**
 * The CLOSED set of provider slugs a project may store a credential for
 * (provider_credential.create), read from management.json meta.provider_vocabulary.
 * Frozen; mirrors the code-side CREDENTIAL_PROVIDERS union at bytes (parity-pinned).
 */
export function providerVocabulary(): readonly string[] {
  return MANAGEMENT_PROVIDER_VOCABULARY;
}

/**
 * The EXACT UTF-8 BYTE limit on a provider credential's secret field
 * (meta.credential_field_limits.api_key_max_utf8_bytes) — a byte count, never a JS
 * string length. The handler enforces it before encoding-variant generation.
 */
export function credentialApiKeyMaxBytes(): number {
  return CREDENTIAL_API_KEY_MAX_UTF8_BYTES;
}

/**
 * The MINIMUM code-point length of a provider credential's secret field
 * (meta.credential_field_limits.api_key_min_length) — a JS-string CODE-POINT count
 * (not bytes), set to 2× the fixed 8-char display prefix + 1 so a masked prefix always
 * reveals strictly less than half of the secret. The extractor enforces it before custody
 * registration; a shorter secret → 422 validation_failed naming the bound.
 */
export function credentialApiKeyMinLength(): number {
  return CREDENTIAL_API_KEY_MIN_LENGTH;
}

/**
 * The EXACT UTF-8 BYTE ceiling on a media_route's `config` pass-through blob
 * (meta.media_route_config_limits.config_max_utf8_bytes) — a byte count, never a JS
 * string length. The config guard (validateMediaRouteConfig, management-core) measures
 * the canonical JSON.stringify UTF-8 length against it AFTER the forbidden-key/depth/shape
 * custody walk passes (T-197 D5); oversized -> 422 validation_failed naming the bound
 * (received values never echoed).
 */
export function mediaRouteConfigMaxBytes(): number {
  return MEDIA_ROUTE_CONFIG_MAX_UTF8_BYTES;
}

function requireNonEmptyString(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`wire-contract management: ${label} must be a non-empty string`);
  }
  return raw;
}

function validateCanonicalResources(raw: unknown): Readonly<ManagementCanonicalResources> {
  if (raw === null || typeof raw !== "object") {
    throw new Error("wire-contract management: meta.canonical_resources must be an object");
  }
  const block = raw as { set?: unknown; mutual_rejection?: unknown; as_metadata?: unknown };
  if (!Array.isArray(block.set) || block.set.length === 0) {
    throw new Error("wire-contract management: meta.canonical_resources.set must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const entry of block.set) {
    if (typeof entry !== "string" || !entry.startsWith("https://")) {
      throw new Error("wire-contract management: meta.canonical_resources.set entries must be absolute https URLs");
    }
    if (seen.has(entry)) {
      throw new Error(`wire-contract management: meta.canonical_resources.set has a duplicate entry "${entry}"`);
    }
    seen.add(entry);
  }
  const asMetaRaw = block.as_metadata;
  if (asMetaRaw === null || typeof asMetaRaw !== "object") {
    throw new Error("wire-contract management: meta.canonical_resources.as_metadata must be an object");
  }
  const asMeta = asMetaRaw as Record<string, unknown>;
  const methods = asMeta["code_challenge_methods_supported"];
  if (!Array.isArray(methods) || methods.length !== 1 || methods[0] !== "S256") {
    // S256-only is load-bearing (D-P2 has no other branch) — a widened or
    // missing method list is a contract/code split that must fail the boot.
    throw new Error(
      'wire-contract management: meta.canonical_resources.as_metadata.code_challenge_methods_supported must be exactly ["S256"]',
    );
  }
  return Object.freeze({
    set: Object.freeze([...(block.set as string[])]),
    mutual_rejection: requireNonEmptyString(block.mutual_rejection, "meta.canonical_resources.mutual_rejection"),
    as_metadata: Object.freeze({
      issuer: requireNonEmptyString(asMeta["issuer"], "as_metadata.issuer"),
      authorization_endpoint: requireNonEmptyString(asMeta["authorization_endpoint"], "as_metadata.authorization_endpoint"),
      token_endpoint: requireNonEmptyString(asMeta["token_endpoint"], "as_metadata.token_endpoint"),
      device_authorization_endpoint: requireNonEmptyString(
        asMeta["device_authorization_endpoint"],
        "as_metadata.device_authorization_endpoint",
      ),
      revocation_endpoint: requireNonEmptyString(asMeta["revocation_endpoint"], "as_metadata.revocation_endpoint"),
      code_challenge_methods_supported: Object.freeze(["S256"] as const),
      note: requireNonEmptyString(asMeta["note"], "as_metadata.note"),
    }),
  });
}

function validateErrorBoundary(raw: unknown): Readonly<ManagementErrorBoundary> {
  if (raw === null || typeof raw !== "object") {
    throw new Error("wire-contract management: meta.error_boundary must be an object");
  }
  const block = raw as Record<string, unknown>;
  return Object.freeze({
    resource_plane: requireNonEmptyString(block["resource_plane"], "meta.error_boundary.resource_plane"),
    oauth_plane: requireNonEmptyString(block["oauth_plane"], "meta.error_boundary.oauth_plane"),
    legacy_flip: requireNonEmptyString(block["legacy_flip"], "meta.error_boundary.legacy_flip"),
  });
}

const MANAGEMENT_CANONICAL_RESOURCES: Readonly<ManagementCanonicalResources> = validateCanonicalResources(
  managementManifest.meta.canonical_resources,
);
const MANAGEMENT_ERROR_BOUNDARY: Readonly<ManagementErrorBoundary> = validateErrorBoundary(
  managementManifest.meta.error_boundary,
);

/**
 * The canonical-resource block (PL-03): the RFC 8707 SET a request `resource`
 * must be a member of (else invalid_target), + the mutual-rejection rule prose.
 * Frozen at import; the SET is EXTENSIBLE by contract minor only — never by code.
 */
export function canonicalResources(): Readonly<ManagementCanonicalResources> {
  return MANAGEMENT_CANONICAL_RESOURCES;
}

/**
 * The AS-metadata ASSERTION PINS (issuer / four endpoint anchors / S256-only).
 * These are drift anchors for the D-W1 8414 body and A009's dashboard-origin
 * carve-out — pins, not servable bytes (the real body builds from typed boot
 * config, D-CFG).
 */
export function asMetadataPins(): Readonly<ManagementAsMetadataPins> {
  return MANAGEMENT_CANONICAL_RESOURCES.as_metadata;
}

/**
 * The frozen error-boundary prose (meta.error_boundary): resource plane = RFC
 * 9457, OAuth plane (A004-A008) = RFC 6749 `{error,...}` — the contract anchor
 * the D-BOUNDARY guard and the byte-goldens cite.
 */
export function errorBoundary(): Readonly<ManagementErrorBoundary> {
  return MANAGEMENT_ERROR_BOUNDARY;
}
