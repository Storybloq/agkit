// T-228 req 4 — `server.json`, the MCP-registry descriptor, RENDERED (never hand-written).
//
// The registry publish step (`mcp-publisher publish`; see PUBLISHING.md) reads a `server.json`
// whose `name` must equal the published npm manifest's `mcpName` BYTE-FOR-BYTE: the registry
// fetches `registry.npmjs.org/<identifier>/<exact-version>` and refuses the record unless the
// tarball's own manifest claims the same server name. Two hand-maintained copies of ONE identity
// is exactly the drift class this module exists to delete — every value emitted below is DERIVED
// from the parsed manifest, the one committed artifact is produced by
// `pnpm --filter @storybloq/agkit regen:goldens` (this package's single regen entry point, T-225
// ruling R3), and `server-json-drift.test.ts` byte-locks the committed bytes to this renderer.
//
// PURE over a parsed manifest: this module reads no file and never touches `cwd`. The regen row
// owns the read; the drift test owns the comparison. It sits on NO tsup entry graph (precedent:
// `bundle-safety-walker.ts` at this same root), so it is typechecked and linted here but never
// reaches `dist` and never enters the published tarball.
//
// FAIL-CLOSED, ALWAYS. Every check below throws rather than emitting a descriptor the registry
// would reject at publish time (or, worse, accept while pointing at the wrong artifact). A
// renderer that "does its best" with a broken manifest is a renderer that publishes a lie.

/**
 * The schema revision the 2025-12-11 registry API accepts. An OLDER `$schema` value is a hard 422
 * at publish — the value is not decorative. The official bytes are vendored at
 * `src/__fixtures__/mcp-server-schema-2025-12-11.json` and the drift test validates the committed
 * descriptor against them (T-228 AMENDMENT II, CX-8: a hand-maintained key set shares fate with
 * its producer, so the producer alone may not be the only oracle).
 */
export const SERVER_JSON_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** npm's registry base URL. For `registryType: "npm"` the registry accepts exactly this, or absent. */
export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";

/** The registry's hard cap on `description` (vendored schema: `minLength: 1`, `maxLength: 100`). */
export const DESCRIPTION_MAX_LENGTH = 100;

/**
 * Server name in reverse-DNS form: exactly ONE forward slash separating namespace from name.
 * Copied from the vendored schema's own `ServerDetail.properties.name.pattern` — the drift test
 * validates against those bytes, so a divergence between this constant and the schema is caught
 * there rather than at the registry.
 */
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

/**
 * The canonical semver.org regex, anchored and without a leading `v`. EXACT versions only: the
 * registry rejects ranges (`^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.x`, `1.*`) and the dist-tag `latest`,
 * because the record must bind to one immutable tarball.
 */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The four manifest fields this renderer consumes. Everything else in `package.json` is ignored. */
export interface CliManifest {
  /** The npm package identifier, e.g. `@scope/name` — becomes `packages[0].identifier`. */
  readonly name: string;
  /** The exact published version — becomes BOTH `version` and `packages[0].version`. */
  readonly version: string;
  /** Human-readable, 1..100 chars — becomes `description`. */
  readonly description: string;
  /** The frozen MCP server name (reverse-DNS, one slash) — becomes `name`. */
  readonly mcpName: string;
}

/**
 * Read one field as an unknown. The declared `CliManifest` is a PROMISE, not a proof: the only
 * real caller hands us `JSON.parse(...)` output, which TypeScript cannot vouch for. Validating at
 * runtime is the whole point of a fail-closed renderer.
 */
function requireString(pkg: CliManifest, field: keyof CliManifest): string {
  const value: unknown = (pkg as unknown as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `server.json: package.json "${field}" must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Render the MCP-registry `server.json` for a parsed CLI manifest.
 *
 * Byte convention (shared with every other row of `scripts/regen-goldens.ts`): a 2-space indent
 * and exactly ONE trailing LF. Returns the TEXT, not the object — the artifact's identity is its
 * bytes, and the drift test compares bytes.
 *
 * NO `fileSha256`: the vendored schema marks it "required for MCPB packages and optional for other
 * package types", and an npm record's integrity already comes from the registry's own tarball
 * digest — emitting a hash we would then have to keep in sync with a tarball built elsewhere would
 * manufacture the drift this module deletes.
 *
 * NO `repository`: the source repo is private and the public mirror's org/name is still an open
 * owner decision (T-228 AMENDMENT II, CX-11). The field is OPTIONAL in the schema and additive, so
 * it lands here in the owner round once the mirror exists — never as a placeholder that lies today.
 *
 * @throws if `mcpName`, `description`, `version` or `name` is missing, empty, or malformed.
 */
export function renderServerJson(pkg: CliManifest): string {
  const mcpName = requireString(pkg, "mcpName");
  if (!SERVER_NAME_PATTERN.test(mcpName)) {
    throw new Error(
      `server.json: "mcpName" must be reverse-DNS with exactly one "/" (got ${JSON.stringify(mcpName)})`,
    );
  }

  const description = requireString(pkg, "description");
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `server.json: "description" is ${String(description.length)} chars; the registry caps it at ${String(DESCRIPTION_MAX_LENGTH)}`,
    );
  }

  const version = requireString(pkg, "version");
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(
      `server.json: "version" must be an exact semver — no ranges, no dist-tags (got ${JSON.stringify(version)})`,
    );
  }

  const identifier = requireString(pkg, "name");
  if (identifier.split("/").length !== 2 || identifier.split("/").some((part) => part.length === 0)) {
    throw new Error(
      `server.json: package "name" must be a scoped npm identifier with exactly one "/" (got ${JSON.stringify(identifier)})`,
    );
  }

  return `${JSON.stringify(
    {
      $schema: SERVER_JSON_SCHEMA_URL,
      name: mcpName,
      description,
      version,
      packages: [
        {
          registryType: "npm",
          registryBaseUrl: NPM_REGISTRY_BASE_URL,
          identifier,
          version,
          transport: { type: "stdio" },
        },
      ],
    },
    null,
    2,
  )}\n`;
}
