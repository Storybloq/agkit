// T-221 — the SDK handoff copy `agkit init` PRINTS: the Swift wiring snippet + the next steps.
//
// R63 BOUNDARY (the one that keeps this file honest): a PRINTED snippet is NOT a WRITTEN artifact.
// The R63 sweep forbids the ARTIFACTS init writes to disk from carrying a realization (a provider,
// a model, a tier, an execution target) — because a written file is a binding the dashboard no
// longer owns. A snippet is documentation the developer edits before it compiles; the `tier:`
// LABEL in it is §B-1 INTENT (the app expresses a tier; the dashboard binds tier→model), which is
// exactly the thing the SDK's own signature asks for. Over-applying R63 here would delete the
// call's required argument and ship a snippet that does not compile.
//
// What R63 DOES still forbid here, and the literal-guard enforces on this root: naming a real
// tier / provider / model / execution target. Every realization slot below is a `<placeholder>`
// the developer fills — the CLI names none of them.
//
// The module-import token is ONE constant (`SDK_MODULE_IMPORT`) and the single `import` line is
// DERIVED from it, so a module rename is one edit and the snippet can never grow a second,
// stale import line (snippet.test.ts pins both facts).

/** The Swift module a consuming app imports. The SDK's shipped library product (Package.swift). */
export const SDK_MODULE_IMPORT = "AgentKit";

/** The relay's agent-stream path, appended to the project's API base to form `endpoint:`. */
const AGENT_STREAM_PATH = "/v1/agent/stream";

/** The npm spec `agkit` installs from — quoted in the next-steps copy. */
export const CLI_PACKAGE_SPEC = "@storybloq/agkit";

/** Placeholders for the values init cannot know. Named once so the snippet and its test agree. */
const PLACEHOLDER = {
  agentId: "<your-agent-id>",
  tier: "<your-tier>",
  publishableKey: "<your-publishable-key>",
} as const;

/**
 * The end-user-JWT sentence. States PLAINLY that the publishable key alone does not authorize a
 * dispatch: the relay also requires a JWT your OWN auth mints for the signed-in end user. This is
 * the sentence the honesty rule exists for — the CLI must never imply the two artifacts it just
 * produced are enough to run an app.
 */
export const END_USER_JWT_SENTENCE =
  "userToken must be a JWT your own auth issues for the signed-in end user — the relay will not dispatch a request without one, so wire your sign-in before you ship.";

export interface SwiftSnippetInput {
  /** The project's API base (the guard-approved management origin), no trailing slash. */
  readonly apiUrl: string;
  /** The freshly-minted publishable key, or null when none was minted this run. */
  readonly publishableKey: string | null;
}

/**
 * Build the Swift wiring snippet. EXACTLY one `import` line, derived from `SDK_MODULE_IMPORT`.
 * The call is the SDK's `AgentProviderSpec.backendRouterCloud(endpoint:agentId:tier:
 * maxOutputTokens:publishableKey:userToken:)` — `AgentProviderSpec` is the ENCLOSING type (the
 * SDK declares the factory in `extension AgentProviderSpec`, Sources/AgentProviders/
 * ProviderSpecs.swift), not the file name.
 */
export function buildSwiftSnippet(input: SwiftSnippetInput): string {
  const endpoint = `${input.apiUrl.replace(/\/+$/, "")}${AGENT_STREAM_PATH}`;
  const key = input.publishableKey ?? PLACEHOLDER.publishableKey;
  return [
    `import ${SDK_MODULE_IMPORT}`,
    "",
    `// ${END_USER_JWT_SENTENCE}`,
    "let provider = AgentProviderSpec.backendRouterCloud(",
    `    endpoint: URL(string: "${endpoint}")!,`,
    `    agentId: "${PLACEHOLDER.agentId}",`,
    `    tier: "${PLACEHOLDER.tier}",`,
    "    maxOutputTokens: 1024,",
    `    publishableKey: "${key}",`,
    "    userToken: endUserJWT",
    ")",
  ].join("\n");
}

export interface NextStepsInput {
  /** True when a provider credential is still missing (or only PENDING inside an open plan). */
  readonly credentialOutstanding: boolean;
  /** True when the default routes are still missing (or only PENDING inside an open plan). */
  readonly routesOutstanding: boolean;
}

/**
 * The ordered next steps. Every line is a real, runnable command — never a "you're all set", and
 * never a FABRICATED URL. The JWT sentence leads because it is the ONE prerequisite a developer
 * most often discovers only at the first 401.
 *
 * The dashboard is reached through `agkit dashboard`, NOT through an interpolated link: the
 * dashboard origin is derived LIVE from the API's AS metadata (core/service/dashboard-url.ts) and
 * `init` holds no service seam to fetch it — printing a guessed origin would be exactly the
 * fabricated URL D-10/§B-9 forbid. `agkit dashboard <page>` derives it honestly.
 */
export function nextStepsText(input: NextStepsInput): string[] {
  const steps: string[] = [END_USER_JWT_SENTENCE];
  steps.push("Register the issuer that mints those end-user JWTs: `agkit issuer create`");
  if (input.credentialOutstanding) {
    steps.push(
      "Store the provider credential the routes need: `agkit provider-key add --provider <slug> --api-key-env <VAR>`",
    );
  }
  if (input.routesOutstanding) {
    steps.push("Bind the tiers the app will ask for: `agkit route create` (or apply the pending plan above)");
  }
  steps.push("Set the project's spend + usage caps BEFORE any traffic: `agkit quota set`");
  // Codex k06: every `agkit` line here must name a command that EXISTS (snippet.test.ts parses
  // each one against the registry). `agkit setup` does not exist yet — `agkit login` is the real
  // first command on a fresh machine.
  steps.push(`Install the CLI wherever you build: \`npm install -g ${CLI_PACKAGE_SPEC}\`, then \`agkit login\``);
  steps.push("Open the dashboard (origin derived live, never guessed): `agkit dashboard`");
  return steps;
}
