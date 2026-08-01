// Generator (a) — the thin yargs shell (T-204 deliverable 4a). It builds the
// ENTIRE command tree + `--help` from the ONE registry. There is deliberately NO
// hand-written `cli.command(...)` for any resource command (T-204 FORBIDDEN):
// every command is registered by mapping over `visibleCommands()`. Reserved
// commands are absent (RN-5).
//
// Arg parsing is single-sourced: yargs handles routing + help + unknown-command
// errors, but a command's INPUT is derived by tokenizing the original argv with
// the SAME `parseFlagTokens` the invariant test uses (vocab.ts), then validated
// by the command's zod `args`. So `.strictCommands()` (typo'd command -> error)
// guards command names, and zod `.strict()` schemas guard options — one authority
// each, no drift between the shell and the example checker.
import yargs, { type Argv } from "yargs";
import type { AnyCommandSpec, CliRuntime, Ctx, RuntimeIoSeams, ServiceCommandSeam } from "../commands/types";
import { resolveEffectiveContext } from "./wire-client";
import type { ResolvedContext } from "../core/config";
import { commandsByNoun, commandKey, CEREMONY_EXEMPT, registry } from "../commands/registry";
import {
  isReadVerb,
  parseFlagTokens,
  TOP_LEVEL_VERB_ALIASES,
  CLIENT_FLAGS,
  type FlagValue,
} from "../commands/vocab";
import { isSingletonReadGroup } from "../commands/generators/command-path";
import {
  commandConsumesCredential,
  commandNeedsRuntime,
  commandNeedsService,
  commandNeedsUrlGuard,
} from "./command-gates";
import { CliLocalError, classifyThrownError, EXIT } from "../core/errors";
import { markStdoutTakeoverComplete, writeDiagnostic } from "./process-lifecycle";
import { applyPositional } from "./positional";
import { displaySafe } from "../core/output/display";
import { runMutationCeremony, type CeremonyDeps } from "../core/plan/ceremony";
import { renderReferenceJson } from "../commands/generators/reference-json";
import { renderReferenceMarkdown } from "../commands/generators/reference-md";
import { renderCompletionScript, COMPLETION_SHELLS, type CompletionShell } from "../commands/generators/completion";
import { emitSuccess, renderTakeoverErrorDoc } from "../core/output";
import {
  CLIENT_FLAG_SET,
  CONTEXT_FLAGS,
  GLOBAL_OUTPUT_FLAGS,
  GLOBAL_OUTPUT_FLAG_SET,
  stripGlobalFlagInput,
} from "./flag-ownership";
import { ceremonyFlagVerdict } from "./ceremony-flags";
import { COMPLETION_SIDE_DOOR, REFERENCE_SIDE_DOOR, sideDoorUsage } from "./side-doors";
import {
  insecureStorageSurface,
  KeyringUnavailableError,
  NO_CREDENTIAL,
  type ResolvedCredential,
} from "../core/auth";
import { enforceApiUrlGuard, type GuardOutcome } from "../core/config";
import { enforceCapabilityGate, isCapabilityGated } from "../core/capability/preflight";
import {
  readCapabilityCache,
  writeCapabilityCache,
  credentialFingerprint,
  type CapabilityCacheKey,
} from "../core/capability/cache";
import { MANAGEMENT_CONTRACT_VERSION } from "../contract";

// The three flag-ownership tables + their strip rule live in ./flag-ownership (T-279) — a
// leaf module, so the README drift check normalizes an invocation through the SAME rule a
// dispatch does. Re-exported: the global `--profile`/`--project` registration is this file's.
export { CONTEXT_FLAGS } from "./flag-ownership";

// Global CLIENT-behavior selectors (T-211) — the typed HTTP client's retry budget +
// idempotency-key override, plus T-212's ceremony booleans `--yes` / `--plan-only`.
// Registered globally + stripped from command input like the context flags; their VALUES
// are re-read from raw argv (parseClientFlags) and validated, never trusted from yargs'
// coerced object (the json-shadowing regression, build-cli.test:1-8). Their TARGET (a
// mutating command) is validated at dispatch (runSpec). The set lives in ./flag-ownership.

/**
 * Shell-owned I/O seams the registry-driven command runner needs (T-206). Injected
 * so tests can drive the credential + banner behavior deterministically; run.ts
 * wires the production seams (a memoized real resolver + a stderr writer).
 */
export interface ShellDeps {
  /** Resolve the local credential (may throw the loud keychain/insecure errors). */
  resolveCredential: () => Promise<ResolvedCredential>;
  /** Best-effort stderr diagnostics sink. MUST NOT throw. Never receives a token. */
  warn: (message: string) => void;
  /**
   * The local-config/context runtime (T-208), injected into a `config`/`profile`/
   * `status` command's `Ctx.runtime`. OPTIONAL so a help-only / local-command caller
   * (and existing T-206 tests) need not supply it — a benign default is used, whose
   * empty env resolves the DEFAULT api_url (so the exfiltration guard is a no-op).
   */
  runtime?: CliRuntime;
  /** Interactive y/N confirm for the API-URL guard (T-208). Defaults to "no". */
  confirm?: (question: string) => Promise<boolean>;
  /** T-212: typed-line reader for a D/PR confirm-string prompt (non-TTY → null). Defaults to null. */
  promptLine?: (question: string) => Promise<string | null>;
  /**
   * T-217 (R-D / RR-10): echo-off hidden-secret reader for `provider-key add|rotate` when
   * `--api-key-env` is absent on a TTY. Threaded onto the injected `CliRuntime.promptSecret` for
   * the `provider-key` noun (`commandNeedsRuntime`); absent everywhere else (the resolver then
   * treats a missing executor exactly like non-TTY — a hard static usage_error).
   */
  promptSecret?: (question: string) => Promise<string | null>;
  /**
   * B0 shared-core (sub-wave B): bounded single-fd text-file reader for the file-reading nouns
   * (agent `sync --file`, media `--config-json @path`, T-221 `init`). Threaded onto the injected
   * `CliRuntime.readTextFile` alongside `promptSecret` for the nouns `commandNeedsRuntime` covers;
   * absent everywhere else (a handler that reaches for it without the seam hits `requireRuntime`).
   */
  readTextFile?: (path: string, opts: { maxBytes: number }) => Promise<string>;
  /**
   * T-221: the fs OUTPUT channel for the scaffold-writing nouns (`init`). Threaded onto the
   * injected `CliRuntime.writeTextFile` alongside `readTextFile` for the nouns
   * `commandNeedsRuntime` covers; absent everywhere else (a handler that reaches for it without
   * the seam hits `requireWriteTextFile` and fails LOUD — never a silently-skipped write).
   */
  writeTextFile?: (path: string, text: string, opts?: { withinRoot?: string }) => void;
  /** T-221: the advisory directory-marker probe, threaded onto `CliRuntime.listDir` alongside it. */
  listDir?: (path: string) => string[];
  /**
   * T-224 (`setup`): the four SYMLINK-FOLLOWING leaf seams — the follow READ, the identity-bound
   * follow WRITE, its postcondition, and the apply-only root provisioner. Threaded onto the
   * matching `CliRuntime` members through their OWN exact-key gate, `FOLLOW_IO_CAPABLE` (today
   * `setup run` alone) — NOT the T-221 siblings' `RUNTIME_IO_CAPABLE`: they are two disjoint
   * capability groups, and `init` claims none of these. Absent everywhere else (a handler reaching
   * for them without the seam hits `requireFollowSeams` and fails LOUD).
   */
  readTextFileFollowing?: RuntimeIoSeams["readTextFileFollowing"];
  writeTextFileFollowing?: RuntimeIoSeams["writeTextFileFollowing"];
  verifyFollowedWrite?: RuntimeIoSeams["verifyFollowedWrite"];
  ensureRootForApply?: RuntimeIoSeams["ensureRootForApply"];
  /**
   * T-221: drop the shell's per-invocation credential memo. run.ts owns that memo and supplies
   * this; run.ts also threads it onto the auth seam (`AuthCommandSeam.invalidateCredential`),
   * which is where handlers reach it. Absent on hand-built test deps (they carry no memo).
   */
  invalidateCredential?: () => void;
  /** T-212 (F-F2): wall clock (ms) for the ceremony's expiry short-circuit. Defaults to Date.now. */
  now?: () => number;
  /**
   * MEMOIZED effective-profile snapshot (T-211): ONE `resolveContext` read serves the
   * credential resolver, the wire client, and the guard's pinned profile — two independent
   * config reads could straddle a concurrent config change and split the profile (TOCTOU).
   * Optional so hand-built test deps need not supply it; run.ts always does.
   */
  effectiveProfile?: () => string;
  /**
   * MEMOIZED effective-CONTEXT snapshot (F0) — the SAME `resolveContext` read `effectiveProfile`
   * projects from, exposing the resolved `project` (value + source) the shell threads onto
   * `ctx.project` for a remote command. Optional: when a hand-built test dep omits it, runSpec
   * builds ONE memoized per-dispatch read and feeds BOTH the guard's profile pin and
   * ctx.project from it — the single-snapshot (TOCTOU) guarantee holds for every caller.
   * run.ts always provides it so the snapshot is additionally shared with the credential chain.
   * INVARIANT: a caller that supplies `effectiveProfile` MUST supply the matching
   * `effectiveContext` (run.ts derives both from one snapshot) — supplying only the profile
   * pin deliberately splits the sources and is reserved for tests that exercise the pin.
   */
  effectiveContext?: () => ResolvedContext;
  /**
   * T-222 (S5): the service-plane I/O seam threaded onto `Ctx.service` for the service nouns
   * (`commandNeedsService`). run.ts builds the production seam (realInstallFs + process facts);
   * a hand-built test dep supplies its own. Absent ⇒ a service command's `requireService` throws
   * (a mis-wired shell — the `requireRuntime` precedent).
   */
  service?: ServiceCommandSeam;
}

/** A keyring port whose every op reports the backend as unavailable (default runtime). */
function unavailableKeyring(): CliRuntime["keyring"] {
  return {
    get: () => Promise.reject(new KeyringUnavailableError()),
    set: () => Promise.reject(new KeyringUnavailableError()),
    delete: () => Promise.reject(new KeyringUnavailableError()),
  };
}

/** The benign default runtime (empty env -> default api_url -> guard no-op). */
function defaultRuntime(): CliRuntime {
  return {
    env: {},
    homeDir: "",
    cwd: "",
    keyring: unavailableKeyring(),
    isTTY: false,
    stderr: () => {},
    flags: {},
  };
}

/** Default seams: no credential (local-only), stderr writer that never throws. */
function defaultShellDeps(): ShellDeps {
  return {
    resolveCredential: async () => NO_CREDENTIAL,
    warn: (message: string) => {
      try {
        process.stderr.write(message);
      } catch {
        /* best-effort: a broken stderr must never corrupt the single stdout doc */
      }
    },
    runtime: defaultRuntime(),
    confirm: async () => false,
  };
}

// The per-command capability gates (`commandConsumesCredential` / `commandNeedsRuntime` /
// `commandNeedsService` / `commandNeedsUrlGuard`) live in ./command-gates (extracted to keep this
// file under the packages/cli max-lines cap). Re-exported here so every consumer keeps importing
// from ./build-cli; runSpec below consumes them through the top-of-file import.
export {
  commandConsumesCredential,
  commandNeedsRuntime,
  commandNeedsService,
  commandNeedsUrlGuard,
} from "./command-gates";
// The dispatch-side POSITIONAL grammar lives in ./positional (the same max-lines extraction).
// Re-exported here so every consumer keeps importing it from ./build-cli; runSpec/runTakeover
// consume it through the top-of-file import.
export { applyPositional } from "./positional";

/** Drop the global output + context flags from a command's tokenized input (they are
 * the serializer's / the shell's, not the command's — a command's zod schema is
 * `.strict()`, so a stray `--json`/`--profile` would otherwise be rejected).
 *
 * Delegates to ./flag-ownership so a dispatch and the README drift check normalize an
 * invocation through the SAME rule — a second implementation is the drift the check exists
 * to catch. This alias is kept so the call sites below read as they always have. */
function stripGlobalFlags(
  input: Record<string, FlagValue>,
): Record<string, FlagValue> {
  return stripGlobalFlagInput(input);
}

/**
 * Assemble the T-211 capability-gate seams for a gated command (A25/A32): the state-dir cache
 * keyed by (canonical API origin, profile, management major) + a credential fingerprint, and the
 * typed client for a pre-flight discovery.get. The origin + profile come from the GUARD-APPROVED
 * outcome — the SAME resolution `enforceApiUrlGuard` enforced in this invocation — never a second
 * `resolveContext` pass, which a between-reads config change could make diverge from the context
 * the client/credential actually operate under (A32 cache-scoping; the step-7 client wiring keys
 * off this same outcome). `Date.now()` here is the cache-freshness WALL CLOCK (shell code, not
 * the typed client's src — the cache functions take `now` as an injected seam); a fresh temp
 * state dir always cold-misses, so tests drive the pre-flight deterministically.
 */
function capabilityGateDeps(ctx: Ctx, runtime: CliRuntime, approved: GuardOutcome) {
  const dirDeps = { env: runtime.env, homeDir: runtime.homeDir };
  const key: CapabilityCacheKey = {
    origin: approved.apiUrl,
    profile: approved.profile,
    major: MANAGEMENT_CONTRACT_VERSION.split(".")[0] as string,
  };
  const credFp = credentialFingerprint(ctx.credential.token ?? "");
  const now = Date.now();
  return {
    client: ctx.client,
    readCache: () => readCapabilityCache(dirDeps, key, credFp, now),
    writeCache: (caps: readonly string[]) => writeCapabilityCache(dirDeps, key, credFp, caps, now),
  };
}

/**
 * Assemble the T-212 ceremony seams from ShellDeps + runtime. The confirm / promptLine seams
 * default to the fail-closed forms (never approve, never prompt) so a hand-built test dep that
 * omits them behaves non-interactively; `now` (F-F2) is the shell's injected wall clock (run.ts
 * threads RunOverrides.now), so a dispatch-level test can freeze the expiry boundary.
 */
function ceremonyDeps(deps: ShellDeps, runtime: CliRuntime): CeremonyDeps {
  return {
    confirm: deps.confirm ?? (async () => false),
    promptLine: deps.promptLine ?? (async () => null),
    isTTY: runtime.isTTY,
    now: deps.now ?? (() => Date.now()),
    warn: deps.warn,
  };
}

/** Extract the `--profile` / `--project` context selectors from raw argv (T-208). */
function extractContextFlags(rawArgv: string[]): CliRuntime["flags"] {
  const flags = parseFlagTokens(rawArgv);
  const out: { profile?: string; project?: string } = {};
  const profile = flags["profile"];
  if (typeof profile === "string" && profile.length > 0) out.profile = profile;
  const project = flags["project"];
  if (typeof project === "string" && project.length > 0) out.project = project;
  return out;
}

/** Register the global output flags on the yargs shell (help + value consumption).
 * The serializer resolves their VALUES from raw argv (ctx.output); these entries
 * exist so `--help` documents them and yargs does not treat their values as stray
 * positionals. Accepted for EVERY command. */
function registerGlobalOutputFlags(cli: Argv): Argv {
  return cli
    .option("json", { type: "string", global: true, describe: "Emit JSON; `--json a,b` selects data fields." })
    .option("jq", { type: "string", global: true, describe: "Filter output with a jq expression (bundled engine)." })
    .option("template", { type: "string", global: true, describe: "Render with a minimal {{.dot.path}} template." })
    .option("compact", { type: "boolean", global: true, describe: "Whitespace-stripped JSON." })
    .option("verbose", { type: "boolean", global: true, describe: "Emit a redacted diagnostic trace on stderr." })
    .option("color", { type: "boolean", global: true, describe: "ANSI color (use --no-color to disable; honors NO_COLOR)." })
    // T-208 global context selectors — the precedence resolver's top layer.
    .option("profile", { type: "string", global: true, describe: "Select the active profile (overrides AGKIT_PROFILE / config)." })
    .option("project", { type: "string", global: true, describe: "Select the active project (overrides AGKIT_PROJECT / repo / profile)." })
    // T-211 global client-behavior selectors — retry budget + idempotency-key override.
    .option("retries", { type: "string", global: true, describe: "Max automatic retries for a remote command (0–10; default 2, 0 disables)." })
    .option("idempotency-key", { type: "string", global: true, describe: "Override the auto-generated Idempotency-Key for a mutating request." })
    .option("paginate", { type: "boolean", global: true, describe: "Auto-fetch every page of a paginated list command." })
    // T-212 ceremony booleans — only meaningful on a mutating (plan/apply) command.
    .option("yes", { type: "boolean", global: true, describe: "Skip the plain y/N confirm for an M-class mutation (never satisfies a D/PR typed confirm)." })
    .option("plan-only", { type: "boolean", global: true, describe: "Create the plan and emit it as data, then stop (exit 0) — do not apply." });
}

// T-212 — dispatch-side ceremony-flag + positional validation (pure; no I/O). Kept module-level
// so runSpec stays thin and these rules are unit-visible.

/**
 * T-221's NAMED `--yes` carve-out moved to ./ceremony-flags with the decision that consumes it
 * (T-279); re-exported here so `init/spec.ts`'s reference and any consumer keep resolving.
 */
export { YES_CAPABLE_ORCHESTRATORS } from "./ceremony-flags";

/**
 * T-221 (codex k08): the commands whose runtime carries the fs OUTPUT + marker-probe + non-secret
 * prompt seams (`writeTextFile` / `listDir` / `promptLine` / `confirm`). `commandNeedsRuntime` is
 * a NOUN gate shared by seventeen commands, but the repo WRITER and the interactive prompt pair are
 * init-only capabilities — threading them through the shared gate would hand `upgrade` /
 * `dashboard` / `config` a repository writer their contracts never claim. Exact-key ALLOWLIST
 * (the YES_CAPABLE_ORCHESTRATORS discipline): membership is a reviewed, enumerable decision, and
 * the threading test pins that every other runtime command receives NONE of the four.
 *
 * LEAST PRIVILEGE — WHY THIS IS ONE OF TWO SETS, NOT ONE SET OF TWO MEMBERS (T-224 codex relay
 * payload 2). T-224 first added `setup run` HERE, so a single spread threaded BOTH capability
 * groups to both members: `init run` received four symlink-FOLLOWING writers it never claims, and
 * `setup run` received the plain writer/lister/prompt pair it never claims. Each member set now
 * receives ONLY the seams its own command consumes — `init` the plain quartet below, `setup` the
 * follow quartet in `FOLLOW_IO_CAPABLE`. Byte-checked against the handlers: `init`'s scaffold
 * reaches for `requireWriteTextFile` + `listDir` and its engine/run for `promptLine`/`confirm`
 * (and NOTHING follow-shaped); `setup`'s legs reach for `requireFollowSeams` alone.
 */
export const RUNTIME_IO_CAPABLE: ReadonlySet<string> = new Set(["init run"]);

/**
 * T-224: the commands whose runtime carries the four SYMLINK-FOLLOWING fs seams
 * (`readTextFileFollowing` / `writeTextFileFollowing` / `verifyFollowedWrite` /
 * `ensureRootForApply`). A SEPARATE exact-key allowlist from `RUNTIME_IO_CAPABLE` for the
 * least-privilege reason spelled out above: these seams write THROUGH a symlink (the dotfiles-
 * managed `AGENTS.md` / `~/.codex/config.toml` leaves) and `ensureRootForApply` CREATES a root
 * under `$HOME` — strictly more authority than the plain quartet, and authority `init` never asks
 * for. Same discipline as its sibling: membership is a reviewed, enumerable decision, and the
 * threading test pins BOTH directions (each command receives its own quartet and NONE of the
 * other's).
 */
export const FOLLOW_IO_CAPABLE: ReadonlySet<string> = new Set(["setup run"]);

/**
 * Validate the TARGET of --yes / --plan-only: they apply ONLY to a mutating command that runs
 * the plan/apply ceremony (a `mutation` binding whose key is NOT ceremony-exempt — F-C2: on an
 * exempt key no ceremony runs, so the flags would be silent theater). On a read / local /
 * ceremony-exempt command, or as a contradictory pair, they are a usage_error (the EXISTING
 * code — no new one minted). Returns the error to throw, or null.
 */
function ceremonyFlagUsageError(spec: AnyCommandSpec, clientFlags: Ctx["clientFlags"]): CliLocalError | null {
  // The DECISION lives in ./ceremony-flags so the README drift check asks the SAME question the
  // shell asks (T-279). This function only maps a verdict onto the error it has always thrown.
  const verdict = ceremonyFlagVerdict(commandKey(spec), Boolean(spec.mutation), {
    yes: clientFlags?.yes === true,
    planOnly: clientFlags?.planOnly === true,
  });
  if (verdict.ok) return null;
  if (verdict.reason === "not_ceremony_target") {
    return new CliLocalError("usage_error", {
      detail: `${verdict.flag} applies only to a mutating command that runs the plan/apply ceremony; '${spec.noun} ${spec.verb}' does not`,
      hint: `re-run without ${verdict.flag}`,
    });
  }
  return new CliLocalError("usage_error", {
    detail: "--yes and --plan-only are contradictory: --plan-only stops after the plan, --yes approves the apply",
    hint: "pass at most one of --yes / --plan-only",
  });
}

/**
 * The yargs command string for a `head` token (a verb, or a noun for a bare command). A
 * positional-bearing spec appends a VARIADIC positional (`<head> [<name>..]`) so yargs ACCEPTS
 * the token(s) — `.strictCommands()` would otherwise reject a positional as an unknown
 * subcommand — and defers the exactly-one enforcement to runSpec (applyPositional). Aliases
 * follow as bare tokens.
 */
function commandNames(head: string, spec: AnyCommandSpec): string | string[] {
  const primary = spec.positional ? `${head} [${spec.positional.name}..]` : head;
  const aliases = spec.aliases ?? [];
  return aliases.length > 0 ? [primary, ...aliases] : primary;
}

/** Read-only shape accessor for a zod object schema — best-effort, for help only. */
function schemaKeys(spec: AnyCommandSpec): Array<{ key: string; describe: string }> {
  try {
    const shape = (spec.args as { shape?: Record<string, { description?: string }> }).shape;
    if (!shape) return [];
    return Object.entries(shape).map(([key, field]) => ({ key, describe: field?.description ?? "" }));
  } catch {
    return [];
  }
}

/** Add a command's options to the builder — purely so `--help` lists them. */
export function describeOptions(y: Argv, spec: AnyCommandSpec): Argv {
  let out = y;
  for (const { key, describe } of schemaKeys(spec)) {
    // R21 (RR-4d): the positional key is surfaced as a POSITIONAL (`commandNames` appends
    // `[<name>..]` to the command string), NOT as a `--flag` — so SKIP it here. Help-only change:
    // the tokenizer + zod shape are untouched, so a raw `--id` still PARSES (back-compat, R17),
    // governed by R20's dual-source guard when it is combined with a positional token.
    if (spec.positional && key === spec.positional.key) continue;
    out = out.option(key, { describe, type: "string" });
  }
  for (const example of spec.examples) out = out.example(example, "");
  return out;
}

/** Run a spec's handler with input tokenized from the original argv, then route
 * the result through the serializer chokepoint (redaction -> format -> stdout).
 * A projection/jq/template failure throws here (nothing is written) and the
 * shell's error path (run.ts) renders it as the single error document.
 *
 * T-206: a command that consumes a credential has it resolved HERE (may throw the
 * loud keychain/insecure errors, which propagate to run.ts's error path). The
 * persistent insecure-storage banner is written to stderr ONCE, right after
 * resolution and BEFORE the handler/output — so it shows even if the handler later
 * fails, and stdout still carries exactly one document. */
/**
 * T-222 S1: the stdout-takeover dispatch (`mcp serve`). The handler owns stdout end-to-end
 * (protocol frames only) — the shell writes NOTHING to stdout on ANY path: success emits no
 * envelope, and EVERY failure (parse or handler) renders exactly ONE JSON error document to
 * STDERR. Runs FIRST in runSpec — before the ceremony-flag check — so no pre-takeover throw
 * can ever reach the stdout serializer through run()'s generic catch.
 */
async function runTakeover(spec: AnyCommandSpec, ctx: Ctx, rawArgv: string[]): Promise<void> {
  try {
    // A12: global OUTPUT/CEREMONY/CLIENT flags are meaningless on a takeover command —
    // there is no stdout envelope to shape, no mutation ceremony, no typed client call.
    // Honor-or-reject (§B-9): they are REJECTED, never silently ignored. CONTEXT flags
    // (--profile/--project) stay accepted — the MCP server consumes context per tool
    // call (T-226). Checked on the RAW tokens, before stripGlobalFlags would eat them.
    const rawTokens = parseFlagTokens(rawArgv);
    const unsupported = Object.keys(rawTokens).filter(
      (k) => GLOBAL_OUTPUT_FLAG_SET.has(k) || CLIENT_FLAG_SET.has(k),
    );
    if (unsupported.length > 0) {
      throw new CliLocalError("usage_error", {
        detail: `${spec.noun} ${spec.verb} owns stdout for protocol frames and supports no output/ceremony/client flags (got: ${unsupported.map((k) => displaySafe(`--${k}`)).join(", ")})`,
      });
    }
    const tokenized = stripGlobalFlags(rawTokens);
    if (spec.positional) applyPositional(tokenized, spec, spec.positional, rawArgv);
    const input = spec.args.parse(tokenized);
    await spec.handler(ctx, input);
    process.exitCode = EXIT.SUCCESS;
  } catch (err) {
    // A6: the error document rides the serializer's SINGLE redaction pass (never a raw
    // stringify — a handler failure could embed a secret), rendered compact to STDERR.
    const { envelope, exitCode } = classifyThrownError(err, { commandPath: [spec.noun, spec.verb] });
    const rendered = await renderTakeoverErrorDoc(envelope, exitCode);
    // T-227 S6 (req 1, "stderr write errors never crash"): guarded, because this write happens
    // INSIDE the catch — a throwing stderr would otherwise escape runTakeover into run()'s generic
    // error path, the one path a takeover may never take (it renders to stdout). A broken stderr is
    // a lost diagnostic; the exit code still carries the failure.
    writeDiagnostic(rendered.stdout);
    process.exitCode = rendered.exitCode;
  } finally {
    // T-227 S6 (req 1): raise the shell's takeover latch on BOTH paths — cli.ts acts on it after
    // run() settles (bounded flush, then an explicit exit), so a stray pending timer can never
    // leave a client-less `mcp serve` alive. The exit is NOT taken here: this dispatch also runs
    // in-process under vitest, and ending a process is the shell's job, never the dispatch's.
    markStdoutTakeoverComplete();
  }
}

function runSpec(spec: AnyCommandSpec, ctx: Ctx, rawArgv: string[], deps: ShellDeps): () => Promise<void> {
  return async () => {
    // T-222 S1: stdout-takeover dispatch — FIRST, before every other check, so no failure
    // of a takeover command can reach the stdout serializer.
    if (spec.stdoutTakeover) {
      await runTakeover(spec, ctx, rawArgv);
      return;
    }

    // T-212: ceremony-flag TARGET validation (pure, no I/O — fails fast). --yes/--plan-only
    // apply only to a mutating ceremony command; on a read/local/ceremony-exempt command or as
    // a contradictory pair they are a usage_error.
    const flagErr = ceremonyFlagUsageError(spec, ctx.clientFlags);
    if (flagErr) throw flagErr;

    // T-212: positional plumbing — map the single leftover non-flag token onto the declared
    // positional key BEFORE the zod parse (the tokenizer is otherwise flag-only).
    const tokenized = stripGlobalFlags(parseFlagTokens(rawArgv));
    if (spec.positional) applyPositional(tokenized, spec, spec.positional, rawArgv);
    const input = spec.args.parse(tokenized);
    const flags = extractContextFlags(rawArgv);
    const runtime = deps.runtime ?? defaultRuntime();
    let runCtx = ctx;

    // T-208: inject the runtime seam (with the resolved --profile/--project) for the
    // commands that read/write local config + keychain + context. T-217: thread the echo-off
    // secret prompt executor onto the runtime for the provider-key noun (undefined for the
    // others — the resolver treats an absent executor exactly like non-TTY).
    if (commandNeedsRuntime(spec)) {
      // T-221 (codex k08): the fs OUTPUT + marker-probe + non-secret prompt seams gate on the
      // EXACT command key, never the shared noun gate — `upgrade`/`dashboard`/`config` must not
      // receive a repository writer or an interactive channel their contracts never claim. The
      // members are threaded from the SAME ShellDeps members `ceremonyDeps` reads — one shell
      // seam each, two consumers, no second readline.
      const key = commandKey(spec);
      const io = RUNTIME_IO_CAPABLE.has(key)
        ? {
            writeTextFile: deps.writeTextFile,
            listDir: deps.listDir,
            promptLine: deps.promptLine,
            confirm: deps.confirm,
          }
        : {};
      // T-224 (least privilege, codex relay payload 2): the symlink-FOLLOWING quartet rides its
      // OWN exact-key gate, composed as a SECOND spread. One gate threading both groups would hand
      // each member the other's capabilities — `init` a writer that follows links into `$HOME`,
      // `setup` a repo writer + interactive channel — neither of which those contracts claim.
      const followIo = FOLLOW_IO_CAPABLE.has(key)
        ? {
            readTextFileFollowing: deps.readTextFileFollowing,
            writeTextFileFollowing: deps.writeTextFileFollowing,
            verifyFollowedWrite: deps.verifyFollowedWrite,
            ensureRootForApply: deps.ensureRootForApply,
          }
        : {};
      runCtx = {
        ...runCtx,
        runtime: {
          ...runtime,
          flags,
          promptSecret: deps.promptSecret,
          readTextFile: deps.readTextFile,
          ...io,
          ...followIo,
        },
      };
    }

    // T-222 S5: inject the service-plane I/O seam for the service nouns (today `selftest`;
    // `upgrade`/`dashboard`/`api` extend it in place). Threaded from the shell's production seam
    // (deps.service); a hand-built test dep omits it and `requireService` fails loudly if a
    // service handler runs without it. NO-OP for every non-service command.
    if (commandNeedsService(spec) && deps.service) {
      runCtx = { ...runCtx, service: deps.service };
    }

    // F0: ONE effective-context accessor per dispatch. run.ts always supplies the shared
    // memoized snapshot (deps.effectiveContext); a hand-built test dep that omits it gets a
    // SINGLE memoized fresh read instead — so the guard's pinned profile and ctx.project below
    // always come from the SAME resolveContext result, for every caller (an independent second
    // read could straddle a concurrent config change and split them — TOCTOU).
    let contextCell: ResolvedContext | null = null;
    const effectiveContext = (): ResolvedContext =>
      deps.effectiveContext?.() ?? (contextCell ??= resolveEffectiveContext(runtime, rawArgv));

    const guardDeps = () => ({
      env: runtime.env,
      homeDir: runtime.homeDir,
      cwd: runtime.cwd,
      // T-211: the profile is PINNED to the shell's shared invocation snapshot — this
      // dispatch-path guard (and the capability-cache key derived from its outcome) must
      // resolve the SAME profile as the credential chain + wire client + ctx.project. A
      // caller-supplied effectiveProfile pin wins (run.ts derives it from the same snapshot);
      // otherwise the unified accessor above supplies it.
      flags: { ...flags, profile: deps.effectiveProfile ? deps.effectiveProfile() : effectiveContext().profile.value },
      isTTY: runtime.isTTY,
      warn: deps.warn,
      confirm: deps.confirm ?? (async () => false),
    });
    let approved: GuardOutcome | null = null;

    // T-208 exfiltration guard (deliverable 4) + T-222 S6: BEFORE we read/use the credential OR
    // derive a browser origin from AGKIT_API_URL, refuse to target a non-default API host that this
    // profile has not confirmed. Non-TTY unconfirmed -> usage_error (exit 2); TTY -> a one-time y/N
    // confirm. Runs for every credential-consuming command AND for `dashboard` (which sends no
    // credential but opens a browser at the derived origin — a phishing vector otherwise).
    if (commandNeedsUrlGuard(spec)) {
      approved = await enforceApiUrlGuard(guardDeps());
    }
    if (commandConsumesCredential(spec)) {
      const credential = await deps.resolveCredential();
      // F0: thread the resolved project (value + source) onto ctx.project, EXACTLY as we
      // overwrite the credential — through the SAME unified accessor the guard's pinned
      // profile read above, so profile and project can never come from split snapshots.
      // A local command never reaches here, so version/reference stay project-null +
      // config-read-free.
      const project = effectiveContext().project;
      runCtx = { ...runCtx, credential, project };
      if (credential.insecure) deps.warn(insecureStorageSurface().banner);
    }
    // T-222 S6: thread the guard-approved apiUrl onto `dashboard`'s service seam — the handler
    // derives the dashboard origin from THIS confirmed URL (never a fresh unconfirmed read). Only
    // `dashboard` carries `approvedApiUrl`; every other service command leaves it undefined.
    if (spec.noun === "dashboard" && runCtx.service && approved) {
      runCtx = { ...runCtx, service: { ...runCtx.service, approvedApiUrl: approved.apiUrl } };
    }

    // T-211 capability gate (A25/A33): a reserved capability-gated command must confirm the
    // server advertises its tree BEFORE dispatch — a fresh state-dir cache hit, else ONE
    // pre-flight discovery.get. A NO-OP for every shipped command (isCapabilityGated is false ⇒
    // zero cost, zero extra I/O). A discovery skew/transient failure PROPAGATES (exit 2 / 1); an
    // unadvertised capability throws version_skew — the gated op is never dispatched (A33). Placed
    // AFTER arg-parse + credential resolution so a parse refusal (e.g. the mode:'tool' false
    // affordance) still preempts it. The cache key derives from the GUARD-APPROVED context (one
    // resolution per invocation — A32); a gated command that somehow skipped the credential
    // branch runs the guard here, so no gated pre-flight ever escapes the exfiltration guard.
    if (isCapabilityGated(spec)) {
      approved ??= await enforceApiUrlGuard(guardDeps());
      await enforceCapabilityGate(spec, capabilityGateDeps(runCtx, runtime, approved));
    }

    // T-212 mutation ceremony (S5b): for a mutating spec that is NOT ceremony-exempt, resolve the
    // plan/apply ceremony HERE — it owns plan.create/get/discard, the redacted stderr render, the
    // y/N + typed prompts, and the non-TTY halts — then thread the resolved pass onto ctx.ceremony.
    // The handler stays a pure client call reading ctx.ceremony (it applies the plan, or emits it
    // for --plan-only). Placed AFTER the URL guard + credential + capability gate so every one of
    // those preempts any plan.create; a NON-mutating command skips this entirely (ctx.ceremony
    // stays undefined). `plan discard` is the one exempt key (S7 retrofitted the rest).
    if (spec.mutation && !CEREMONY_EXEMPT.has(commandKey(spec))) {
      const pass = await runMutationCeremony(spec, runCtx, input, ceremonyDeps(deps, runtime));
      runCtx = { ...runCtx, ceremony: pass };
    }

    const result = await spec.handler(runCtx, input);
    // T-212 S8 (PL-15): when the invocation's FINAL response was a stored idempotent replay
    // (`Idempotency-Replayed: true` — the ≤24h same-key resend of an already-applied plan),
    // surface it as `meta.replayed: true` — the honest "the server did NOT re-execute this"
    // signal at exit 0. Additive metadata; the data document is untouched.
    const replayed = runCtx.replay?.current === true;
    await emitSuccess(
      ctx.output,
      replayed ? { ...result, meta: { ...(result.meta ?? {}), replayed: true } } : result,
    );
  };
}

/** Register the `reference` meta command (the generators' self-reflection surface).
 * `reference --json` = the machine registry; bare = the Markdown catalog. NOTE: it
 * does NOT redeclare a local `--json` option — the GLOBAL `--json` (registered as a
 * string for field selection) would shadow a local boolean and coerce a bare
 * `--json` to `""` (falsy), silently reverting to Markdown. So intent is read from
 * the RAW argv (the same tokenizer the rest of the shell uses), immune to that
 * coercion. `reference` writes its artifact directly (it is not a CommandResult
 * routed through the serializer envelope). Name + summary come from `./side-doors`
 * (T-279): a spec-less door still needs ONE description, and the README drift check
 * parses documented invocations against that SAME descriptor. */
function registerReference(cli: Argv, rawArgv: string[]): Argv {
  return cli.command(
    REFERENCE_SIDE_DOOR.name,
    REFERENCE_SIDE_DOOR.summary,
    (y) => y,
    () => {
      const wantsJson = Object.prototype.hasOwnProperty.call(parseFlagTokens(rawArgv), "json");
      if (wantsJson) {
        // The machine registry — JSON.stringify has no trailing newline, so add one.
        process.stdout.write(JSON.stringify(renderReferenceJson(), null, 2) + "\n");
        return;
      }
      // The Markdown catalog is ALREADY pinned to exactly one trailing LF by the
      // generator (T-209 drift-lock invariant) — write it verbatim so `agkit reference`
      // emits the SAME bytes committed to skill/reference.md (never a doubled newline).
      process.stdout.write(renderReferenceMarkdown());
    },
  );
}

/**
 * T-222 step 9: the `completion <shell>` meta-command side-door (reference precedent). It emits a
 * registry-DERIVED completion script (bash | zsh | fish) — never yargs' bash/zsh-only generator, and
 * no `--get-yargs-completions` false affordance. An unknown shell is a teachable `usage_error` that
 * NAMES the three (honor-or-reject) — validated in the handler (not yargs `choices`) so we own the
 * message. On success it writes the script verbatim (already one-trailing-LF pinned by the generator).
 * Usage line, summary and positional metadata come from `./side-doors` (T-279) — the same descriptor
 * the README drift check parses against, so the shipped grammar and the documented one are ONE object.
 */
function registerCompletion(cli: Argv, _rawArgv: string[]): Argv {
  return cli.command(
    sideDoorUsage(COMPLETION_SIDE_DOOR),
    COMPLETION_SIDE_DOOR.summary,
    (y) => y.positional(COMPLETION_SIDE_DOOR.positional.key, { type: "string", describe: COMPLETION_SIDE_DOOR.positional.describe }),
    (argv) => {
      const shell = String((argv as { shell?: unknown }).shell ?? "");
      if (!(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
        throw new CliLocalError("usage_error", {
          detail: `unknown shell '${displaySafe(shell)}' — supported: ${COMPLETION_SHELLS.join(", ")}`,
          hint: "agkit completion bash",
        });
      }
      process.stdout.write(renderCompletionScript(shell as CompletionShell));
    },
  );
}

/**
 * Build the yargs CLI from the registry. `rawArgv` is the original argv slice —
 * both the yargs instance AND the per-command tokenizer read from it. `deps` wires
 * the credential resolver + stderr banner seam (T-206); it defaults to local-only
 * (no credential) so callers that only build help (e.g. tests) need not supply it.
 */
export function buildCli(
  rawArgv: string[],
  ctx: Ctx,
  deps: ShellDeps = defaultShellDeps(),
  specs: readonly AnyCommandSpec[] = registry,
): Argv {
  let cli = registerGlobalOutputFlags(
    yargs(rawArgv)
      .scriptName("agkit")
      .strictCommands()
      .version(false) // our `version` command owns version output (single source)
      .help()
      .wrap(null),
  );

  // T-210: the shell renders whatever the FLAG-GATED registry contains. A default build
  // has no reserved commands (byte-absent); a SHIP_RESERVED build's `--help` surfaces
  // them. `specs` is injectable so tests can drive a flag-on shell without a rebuild.
  const byNoun = commandsByNoun(specs);
  for (const [noun, group] of byNoun) {
    // command `agkit <noun>` (this is exactly how `agkit version` works). The bare-vs-verb
    // decision is the SHARED `isSingletonReadGroup` helper (C-6) — the reference/help
    // generators consume the same decision, so the surface and its docs cannot drift. The
    // helper also honors a `bare: true` spec (T-213 decision k: login/logout surface bare
    // even though `create`/`clear` are not read verbs — the registry load-check guaranteed
    // such a spec is the sole visible command for its noun).
    // T-216 (S1): noun aliases (`pk` for `publishable-key`) — every spec of the noun declares the
    // IDENTICAL set (registry load-check), so read it off the group head and register the whole noun
    // group under `[noun, ...nounAliases]` (the same array-alias mechanism yargs uses for verb
    // aliases). MCP/dedup/drift see only the primary noun.
    const nounAliases = group[0]?.nounAliases ?? [];

    if (isSingletonReadGroup(group)) {
      const only = group[0]!;
      const base = commandNames(noun, only);
      const names =
        nounAliases.length > 0 ? [...(Array.isArray(base) ? base : [base]), ...nounAliases] : base;
      cli = cli.command(
        names,
        only.summary,
        (y) => describeOptions(y, only),
        runSpec(only, ctx, rawArgv, deps),
      );
      continue;
    }

    // Multi-verb noun -> `agkit <noun> <verb>` with a subcommand per verb.
    cli = cli.command(
      nounAliases.length > 0 ? [noun, ...nounAliases] : noun,
      `${noun} commands`,
      (sub) => {
        let s = sub;
        for (const spec of group) {
          const names = commandNames(spec.verb, spec);
          s = s.command(
            names,
            spec.summary,
            (y) => describeOptions(y, spec),
            runSpec(spec, ctx, rawArgv, deps),
          );
        }
        return s.demandCommand(1, `Specify a ${noun} subcommand (see \`agkit ${noun} --help\`).`);
      },
      () => {
        /* parent with no subcommand falls through to demandCommand help */
      },
    );
  }

  // T-212 S6 (Design d / RC-5): the top-level VERB ALIASES — a second yargs command routed to
  // the SAME registry citizen's runSpec (full guard/ceremony/serializer path, never a
  // `reference`-style side door). `agkit apply <plan-id>` is the ticket's canonical hint line;
  // extractPositional already treats the single alias token as the command path.
  for (const [alias, target] of Object.entries(TOP_LEVEL_VERB_ALIASES)) {
    const spec = specs.find((s) => s.noun === target.noun && s.verb === target.verb);
    if (!spec) continue; // the target ships with the registry; absent only in narrowed test harnesses
    cli = cli.command(
      commandNames(alias, spec),
      `Alias of \`agkit ${spec.noun} ${spec.verb}\`.`,
      (y) => describeOptions(y, spec),
      runSpec(spec, ctx, rawArgv, deps),
    );
  }

  return registerCompletion(registerReference(cli, rawArgv), rawArgv).demandCommand(
    1,
    "Specify a command (see `agkit --help`).",
  );
}
