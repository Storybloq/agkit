/**
 * Wire-contract MANAGEMENT **ROUTE REGISTRY DATA** — the bundler-safe half of the
 * management/v1.2.0 route table, purpose-built for the CLI's typed HTTP client (T-211).
 *
 * WHY A SECOND DATA MODULE (mirrors management-data.ts EXACTLY): ./management.ts is
 * api-ONLY by design (CON-6 / T-200 P6 incident) — it fs-reads the contract bundle via
 * `import.meta.url` and eagerly compiles ajv schemas. When a bundler (Next/webpack, or
 * the CLI's tsup `noExternal`) drags that fs loader into a client bundle, `import.meta.url`
 * inlines to the CI BUILD path and every render/boot 500's at module load (ENOENT). The
 * fix, proven by management-data.ts, is a PURE DATA module loaded via a STATIC JSON import
 * that every runtime resolves correctly:
 *   - Next/webpack + tsup/esbuild: inline the JSON into the bundle;
 *   - node --conditions=agentkit-dist (api prod image): plain ESM JSON import
 *     (`with { type: "json" }`, node 24) resolved through this package's exports map;
 *   - tsx / vitest (dev/test): esbuild/vite JSON modules.
 * The import uses a PACKAGE SELF-REFERENCE (not a relative path) because the contract dir
 * sits OUTSIDE tsconfig rootDir=src — a relative JSON import fails the dist build (TS6059)
 * and tsc would try to copy the bundle into dist, violating "the JSON bundle is the source
 * of truth, never compiled in". The self-reference resolves via the
 * "./contract/management/v1.2.0/management-routes.json" exports entry in package.json.
 *
 * The CLI imports THIS module — never ./management.ts (the ajv+fs api-only half). The
 * bundle-safety guard (packages/cli/src/bundle-safety.guard.test.ts) statically proves the
 * CLI bundle can never reach ./management.ts.
 *
 * All validation is fail-loud AT MODULE LOAD (a missing/misshapen route fails the importer's
 * boot, never lazily at first request) — the same discipline as management-data.ts.
 */
import routesManifestJson from "@agentkit-cloud/shared/contract/management/v1.2.0/management-routes.json" with { type: "json" };

// ── closed vocabularies (the frozen management/v1.2.0 route-registry column enums) ──

/** HTTP methods present in the registry. `GET+POST` is the single dual-verb row (oauth.authorize). */
export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "GET+POST";
const ROUTE_METHODS: readonly RouteMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE", "GET+POST"];

/** Idempotency-Key discipline: `required` routes carry a server-side replay guard (25/141). */
export type RouteIdempotency = "none" | "required";
const ROUTE_IDEMPOTENCIES: readonly RouteIdempotency[] = ["none", "required"];

/** route_status is the CLOSED 3-value enum (RN-5). */
export type RouteStatus = "implemented" | "reserved" | "deprecated_alias";
const ROUTE_STATUSES: readonly RouteStatus[] = ["implemented", "reserved", "deprecated_alias"];

/** Optimistic-concurrency precondition the route expects (If-Match / If-None-Match). */
export type RouteConcurrency = "none" | "if_match" | "if_none_match";
const ROUTE_CONCURRENCIES: readonly RouteConcurrency[] = ["none", "if_match", "if_none_match"];

/** Whether the route carries a secret in its request and/or response (custody metadata). */
export type RouteSecretBearing = "none" | "request" | "response";
const ROUTE_SECRET_BEARINGS: readonly RouteSecretBearing[] = ["none", "request", "response"];

/**
 * One row of the management route registry, normalized for the client. Only the fields the
 * typed HTTP client needs to build/route/retry a request are surfaced; the auth/scope/danger
 * columns stay in the contract bundle (the client never re-derives authorization — the server
 * owns it). `deprecated_alias` rows — and ONLY those — omit idempotency/paginated/concurrency/
 * secret_bearing in the source; they normalize to safe defaults ("none"/false) so predicates
 * work uniformly. A missing column on any implemented/reserved row is fail-closed corruption
 * (throws at validation), NOT a silently-applied default.
 */
/**
 * T-212 S6 — the frozen pagination bounds of a paginated route, the CLI-consumed subset of the
 * manifest's `pagination` block (sort/cursor/index columns are server-side concerns). Consumers
 * bind per-spec `--limit` ceilings from THIS metadata, never a hardcoded literal. OPTIONAL even
 * on a paginated row: one frozen row (invitation.list) omits the block — bytes over invention.
 */
export interface RoutePagination {
  readonly default_limit: number;
  readonly max_limit: number;
}

export interface RouteEntry {
  readonly operation_id: string;
  readonly method: RouteMethod;
  readonly path: string;
  readonly idempotency: RouteIdempotency;
  readonly paginated: boolean;
  readonly pagination?: RoutePagination;
  readonly concurrency: RouteConcurrency;
  readonly secret_bearing: RouteSecretBearing;
  readonly route_status: RouteStatus;
}

/**
 * The full management/v1.2.0 registry entry count. COUNT-PIN — re-ratify on any management
 * contract MINOR bump (the count is a freeze fact of the immutable management/v1.2.0 tag; a
 * new tag adding routes updates this number deliberately, together with the idempotency-required
 * count pinned in the module's test).
 */
export const EXPECTED_ROUTE_COUNT = 141;

/**
 * The idempotency-`required` route count. COUNT-PIN — the server mounts its replay-guard
 * middleware on exactly these 25 routes; enforced INSIDE validateRouteTable so a fixture
 * that flips one required→none (keeping all 141 rows) reddens. Re-ratify on a MINOR bump.
 * RE-RATIFIED at v1.2.0: still exactly 25 — the added `model_route.defaults` row is a GET
 * with idempotency "none", so the required census does not move.
 */
export const EXPECTED_IDEMPOTENCY_REQUIRED_COUNT = 25;

/**
 * The management minor this module is pinned to — it is the version segment of this file's
 * OWN static JSON import path (`.../management/v1.2.0/management-routes.json`). A manifest
 * whose `management_version` disagrees with the path it was loaded from is CORRUPTION, so
 * validateRouteTable throws on any value other than this exact string.
 */
export const PINNED_MANAGEMENT_VERSION = "1.2.0";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// ── fail-loud validation (throws at module load / when fed a mutated fixture) ──

function fail(message: string): never {
  throw new Error(`wire-contract management-routes: ${message}`);
}

function requireEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string,
  fallback?: T,
): T {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    fail(`${label} must be one of [${allowed.join(", ")}] (got ${JSON.stringify(raw)})`);
  }
  return raw as T;
}

/** A validated manifest: the pinned version + the frozen, runtime-immutable route table. */
export interface ValidatedRouteTable {
  readonly version: string;
  readonly table: ReadonlyMap<string, Readonly<RouteEntry>>;
}

/**
 * Wrap a built Map in a TRUE read-only FACADE (A4). The Map is captured in this closure and
 * NEVER handed out; the returned object implements EXACTLY the ReadonlyMap surface
 * (get/has/size/keys/values/entries/forEach/[Symbol.iterator]) by delegating to it. Because the
 * facade carries NO Map internal slots, a reflection bypass — `Map.prototype.set.call(facade, …)`
 * — throws a TypeError ("incompatible receiver") BY CONSTRUCTION: there is no mutator surface to
 * reach and no shadowed own-method that borrowing `Map.prototype.*` could route around. `forEach`
 * re-binds its 3rd callback arg to the FACADE (never the private inner Map) so the sealed handle
 * never leaks through a callback.
 */
function readonlyMapFacade<K, V>(m: Map<K, V>): ReadonlyMap<K, V> {
  const facade: ReadonlyMap<K, V> = {
    get: (k) => m.get(k),
    has: (k) => m.has(k),
    get size() {
      return m.size;
    },
    keys: () => m.keys(),
    values: () => m.values(),
    entries: () => m.entries(),
    forEach: (cb, thisArg) => {
      m.forEach((v, k) => cb.call(thisArg, v, k, facade));
    },
    [Symbol.iterator]: () => m[Symbol.iterator](),
  };
  // Freeze the facade itself: without this its get/has/iteration methods could be overwritten
  // or deleted through a cast, corrupting the exported singleton even with the inner Map safe.
  // freeze() also pins the prototype, so Object.setPrototypeOf(facade, …) throws too.
  return Object.freeze(facade);
}

/**
 * Validate + normalize the raw routes manifest into `{ version, table }`. The table is a
 * frozen operation_id → RouteEntry map (deep-frozen entries + sealed mutators). Exported
 * (unlike management-data's private validators) SO the negative fixtures can feed a mutated
 * copy through it and prove the fail-loud path — a guard only counts once an injected break
 * turns it red (RULES). Fail-closed: version, per-field presence (gated on route_status),
 * and the idempotency-required count are ALL enforced here.
 */
export function validateRouteTable(raw: unknown): ValidatedRouteTable {
  if (raw === null || typeof raw !== "object") {
    fail("manifest must be an object");
  }
  const manifest = raw as { routes?: unknown; management_version?: unknown };

  // ── management_version: strict semver AND equality to PINNED_MANAGEMENT_VERSION (path/content parity) ──
  const version = manifest.management_version;
  if (typeof version !== "string") {
    fail(`manifest.management_version must be a string (got ${JSON.stringify(version)})`);
  }
  if (!SEMVER_RE.test(version)) {
    fail(`manifest.management_version must be strict semver \`major.minor.patch\` (got ${JSON.stringify(version)})`);
  }
  if (version !== PINNED_MANAGEMENT_VERSION) {
    fail(`manifest.management_version ${JSON.stringify(version)} != pinned ${JSON.stringify(PINNED_MANAGEMENT_VERSION)} (this module loads the v${PINNED_MANAGEMENT_VERSION} bundle — a mismatch is corruption)`);
  }

  if (!Array.isArray(manifest.routes)) {
    fail("manifest.routes must be an array");
  }
  const routes = manifest.routes;
  if (routes.length !== EXPECTED_ROUTE_COUNT) {
    fail(`expected exactly ${EXPECTED_ROUTE_COUNT} route entries (got ${routes.length})`);
  }

  const table = new Map<string, Readonly<RouteEntry>>();
  let idempotencyRequired = 0;
  for (const row of routes) {
    if (row === null || typeof row !== "object") {
      fail("every route entry must be an object");
    }
    const r = row as Record<string, unknown>;

    const operation_id = r["operation_id"];
    if (typeof operation_id !== "string" || operation_id.length === 0) {
      fail("route.operation_id must be a non-empty string");
    }
    if (table.has(operation_id)) {
      fail(`duplicate operation_id "${operation_id}"`);
    }

    const path = r["path"];
    // Non-empty string only: the single dashboard-origin row (oauth.authorize) is a browser
    // redirect whose path is a "<dashboard-origin>/…" placeholder, not an api-absolute path.
    if (typeof path !== "string" || path.length === 0) {
      fail(`route "${operation_id}".path must be a non-empty string (got ${JSON.stringify(path)})`);
    }

    // route_status FIRST: the idempotency/paginated/concurrency/secret_bearing columns are
    // omitted in the frozen source ONLY on deprecated_alias rows; every implemented/reserved
    // row carries all four (ground-truth verified: 99 implemented + 39 reserved, all present;
    // only the 3 aliases omit them). So the safe defaults are permitted ONLY on an alias row —
    // a missing field on any other row is fail-closed corruption, not a silent default.
    const route_status = requireEnum(r["route_status"], ROUTE_STATUSES, `route "${operation_id}".route_status`);
    const aliasFallback = <T>(v: T): T | undefined => (route_status === "deprecated_alias" ? v : undefined);

    const idempotency = requireEnum(
      r["idempotency"],
      ROUTE_IDEMPOTENCIES,
      `route "${operation_id}".idempotency`,
      aliasFallback<RouteIdempotency>("none"),
    );
    if (idempotency === "required") idempotencyRequired += 1;

    // T-212 S6: a PRESENT pagination block must carry positive-integer bounds with
    // default_limit <= max_limit (fail-loud corruption check); an absent block stays absent
    // (one frozen paginated row omits it — the frozen bytes win over invented requirements).
    let pagination: RoutePagination | undefined;
    const rawPagination = r["pagination"];
    if (rawPagination !== undefined) {
      if (rawPagination === null || typeof rawPagination !== "object") {
        fail(`route "${operation_id}".pagination must be an object when present`);
      }
      const p = rawPagination as Record<string, unknown>;
      const default_limit = p["default_limit"];
      const max_limit = p["max_limit"];
      if (
        typeof default_limit !== "number" ||
        !Number.isInteger(default_limit) ||
        default_limit <= 0 ||
        typeof max_limit !== "number" ||
        !Number.isInteger(max_limit) ||
        max_limit <= 0 ||
        default_limit > max_limit
      ) {
        fail(
          `route "${operation_id}".pagination bounds must be positive integers with default_limit <= max_limit`,
        );
      }
      pagination = Object.freeze({ default_limit, max_limit });
    }

    const entry: RouteEntry = {
      operation_id,
      method: requireEnum(r["method"], ROUTE_METHODS, `route "${operation_id}".method`),
      path,
      idempotency,
      ...(pagination !== undefined ? { pagination } : {}),
      paginated:
        route_status === "deprecated_alias" && r["paginated"] === undefined
          ? false
          : requireBoolean(r["paginated"], `route "${operation_id}".paginated`),
      concurrency: requireEnum(
        r["concurrency"],
        ROUTE_CONCURRENCIES,
        `route "${operation_id}".concurrency`,
        aliasFallback<RouteConcurrency>("none"),
      ),
      secret_bearing: requireEnum(
        r["secret_bearing"],
        ROUTE_SECRET_BEARINGS,
        `route "${operation_id}".secret_bearing`,
        aliasFallback<RouteSecretBearing>("none"),
      ),
      route_status,
    };
    table.set(operation_id, Object.freeze(entry));
  }

  if (idempotencyRequired !== EXPECTED_IDEMPOTENCY_REQUIRED_COUNT) {
    fail(
      `expected exactly ${EXPECTED_IDEMPOTENCY_REQUIRED_COUNT} idempotency-required routes ` +
        `(got ${idempotencyRequired})`,
    );
  }

  return { version, table: readonlyMapFacade(table) };
}

function requireBoolean(raw: unknown, label: string): boolean {
  if (typeof raw !== "boolean") {
    fail(`${label} must be a boolean (got ${JSON.stringify(raw)})`);
  }
  return raw;
}

// ── frozen exports (validated ONCE at module load) ──

const VALIDATED: ValidatedRouteTable = validateRouteTable(routesManifestJson);

/**
 * Semver of the management route contract (served tag: management/v1.2.0). Comes from the
 * VALIDATED manifest value (strict semver AND equality to `PINNED_MANAGEMENT_VERSION`), never
 * a bare cast — so a corrupted or mis-versioned bundle fails the importer's boot instead of
 * silently mislabeling the wire.
 */
export const MANAGEMENT_ROUTES_VERSION: string = VALIDATED.version;

/**
 * The frozen management route registry keyed by operation_id — the SINGLE runtime source the
 * typed client resolves a `{ operationId }` request through (method + path + idempotency +
 * pagination). Validated at import; a missing/misshapen row (or a bad version / wrong
 * idempotency-required count) throws HERE at boot. IMMUTABILITY GUARANTEE: each entry is
 * `Object.freeze`n AND the table is a read-only FACADE with NO mutator surface at all — it holds
 * no Map internal slots, so even a reflection bypass (`Map.prototype.set.call(table, …)`) throws
 * an incompatible-receiver TypeError. The `ReadonlyMap` type is enforced by construction, not
 * merely by the compiler.
 */
export const MANAGEMENT_ROUTE_TABLE: ReadonlyMap<string, Readonly<RouteEntry>> = VALIDATED.table;

/** Resolve an operation_id to its route entry, or `undefined` for an unknown operation. */
export function routeFor(operationId: string): Readonly<RouteEntry> | undefined {
  return MANAGEMENT_ROUTE_TABLE.get(operationId);
}

/**
 * Whether the route carries a server-side idempotency-replay guard (25/141 routes). Fails
 * CLOSED (false) for an unknown operation — the client never invents replay protection.
 */
export function isIdempotencyRequired(operationId: string): boolean {
  return MANAGEMENT_ROUTE_TABLE.get(operationId)?.idempotency === "required";
}

/** Whether the route is keyset-paginated (drives `--paginate`). Fails closed (false) if unknown. */
export function isPaginated(operationId: string): boolean {
  return MANAGEMENT_ROUTE_TABLE.get(operationId)?.paginated === true;
}
