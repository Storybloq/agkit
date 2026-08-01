// The shell's per-command capability gates (T-223) — which commands need the runtime seam, the
// service seam, the API-URL exfiltration guard, or the local credential. Extracted from
// `build-cli.ts` to keep that file under the packages/cli max-lines cap; `build-cli.ts` re-exports
// every name below, so every consumer keeps importing from `./build-cli`. These are pure predicates
// over a CommandSpec — no I/O, no shell state — so `runSpec` reads as a flat sequence of gates.
import type { AnyCommandSpec } from "../commands/types";
import { commandKey } from "../commands/registry";

/**
 * Does this command CONSUME the local credential (so the shell must resolve it
 * before dispatch)? True when the command declares any scope (it will authenticate)
 * OR it is the auth self-lookup `whoami` (N-011 §APX-A A003: scope —, but it reports
 * the credential SOURCE). `version`/`reference` (local, no scope, not auth) resolve
 * NOTHING — so they never touch the keychain.
 *
 * TODO(L2-CLI registry): when a `credentialNeed` field lands on CommandSpec (or the
 * auth `status` aggregate arrives), replace the hard-coded cases below — `whoami`,
 * `selftest`, `api`, and `account security` — with that single canonical field
 * consumed by both the CLI and MCP shells.
 */
export function commandConsumesCredential(spec: AnyCommandSpec): boolean {
  // T-222: `selftest` declares no required scope (a diagnostic probes whatever the credential can
  // do, never fails-closed on scopes) but it MUST authenticate its whoami/read/write probes — so it
  // consumes the credential exactly like the scope-less `whoami` self-lookup.
  // T-223: `account security` is the same scope-less shape — its `whoami.get` enrichment requires
  // NO scope (N-011 §APX-A A003) and its deep-link derivation none at all, yet it REPORTS the
  // credential's source + server token facts, so the shell must resolve the credential for it.
  // Keyed by commandKey (not noun): `account get`/`account usage` already qualify via their scopes.
  // T-228: `mcp doctor` declares no scope (its ONE probe is an unauthenticated `discovery.get`) but
  // its whole second check REPORTS the credential's source — so the shell must resolve it. Keyed by
  // commandKey, never the `mcp` noun: `mcp serve` authenticates per-tool-call and must keep
  // resolving NOTHING at process start.
  return (
    spec.scopes.length > 0 ||
    spec.noun === "whoami" ||
    spec.noun === "selftest" ||
    spec.noun === "api" ||
    commandKey(spec) === "account security" ||
    commandKey(spec) === "mcp doctor"
  );
}

/**
 * Does this command need the local-config/context RUNTIME seam injected (T-208)? The
 * `config`/`profile`/`status` nouns read/write config + keychain + resolve context;
 * everything else does not. Noun-gated exactly like `commandConsumesCredential`.
 * TODO(L2-CLI registry): fold both into a single declarative `needs` field on
 * CommandSpec when the registry grows one.
 */
export function commandNeedsRuntime(spec: AnyCommandSpec): boolean {
  return (
    spec.noun === "config" ||
    spec.noun === "profile" ||
    spec.noun === "status" ||
    // T-213: login/logout read isTTY + env (SSH detection) + write via runtime seams; token
    // needs isTTY (the non-TTY `--expires-in` requirement) — all need the runtime injected.
    spec.noun === "login" ||
    spec.noun === "logout" ||
    spec.noun === "token" ||
    // T-217: provider-key add/rotate read env (secret-env indirection) + isTTY + the echo-off
    // promptSecret executor — all need the runtime seam injected.
    spec.noun === "provider-key" ||
    // T-227 S5b: the `secret-source` declaration surface reads/writes the profile's config.json and
    // resolves the active profile from env + cwd + the `--profile` flag — all runtime seams.
    spec.noun === "secret-source" ||
    // T-218: `agent sync` reads a local file through the injected `readTextFile` seam (§3.6).
    spec.noun === "agent" ||
    // T-219: `revenuecat set` reads env (secret-env indirection) + isTTY + the echo-off
    // promptSecret executor — the same S-B channels as provider-key.
    spec.noun === "revenuecat" ||
    // T-220: `media-route set --config-json` reads a local file through the injected
    // `readTextFile` seam (§2-S1).
    spec.noun === "media-route" ||
    // T-220 r2c-1: `voice-identity set` reads env (secret-env indirection) + isTTY + the
    // echo-off promptSecret executor — the same S-B channels as provider-key/revenuecat.
    spec.noun === "voice-identity" ||
    // T-222 (step 5/6): the version/selftest diagnostics read `runtime.nodeVersion` (and
    // selftest reads keyring/env/isTTY for its probes).
    spec.noun === "version" ||
    spec.noun === "selftest" ||
    // T-222 (step 7): `upgrade` writes the install child's redacted output + the reminder to
    // `runtime.stderr`.
    spec.noun === "upgrade" ||
    // T-222 (step 8): `dashboard` reads `runtime.isTTY` to decide launch-vs-print.
    spec.noun === "dashboard" ||
    // T-221: `init` is the runtime seam's heaviest consumer — cwd (repo discovery + the scaffold
    // root), isTTY (interactive gather vs the pure `--yes` frontend), flags (the `--project`
    // selector), stderr (the consent/diff render), AND the fs seams (`writeTextFile` for the
    // scaffold, `listDir` for the project-type markers).
    spec.noun === "init" ||
    // T-224: `setup` is the other heavy consumer — homeDir (`~/.claude/skills`, `~/.claude.json`,
    // `~/.codex`), cwd (the project's AGENTS.md), env (`CODEX_HOME`, `PATH`/`PATHEXT` for the bin
    // ladder), stderr, AND the four symlink-FOLLOWING fs seams (`readTextFileFollowing` /
    // `writeTextFileFollowing` / `verifyFollowedWrite` / `ensureRootForApply`), which the
    // exact-key `FOLLOW_IO_CAPABLE` gate threads on top of this noun gate — its OWN allowlist,
    // disjoint from `init`'s `RUNTIME_IO_CAPABLE` (least privilege: neither receives the other's
    // writers).
    spec.noun === "setup" ||
    // T-228: `mcp doctor` reads homeDir/cwd/env (the MCP client-config candidate paths) AND the
    // bounded, symlink-FOLLOWING `readTextFile` seam — the one that keeps a dotfiles-managed
    // `~/.claude.json` from reading as "not registered". It joins NEITHER `RUNTIME_IO_CAPABLE` nor
    // `FOLLOW_IO_CAPABLE`: a read-only diagnostic has no write authority to exercise, and that
    // absence is machine-checked at dispatch rather than assumed. EXACT-key, never the `mcp` noun —
    // `mcp serve` is a stdout-takeover dispatch that runs BEFORE any seam injection and claims none
    // of this (least privilege, the `account security` precedent).
    commandKey(spec) === "mcp doctor" ||
    // T-228: `mcp print-config` reads `env` (the PATH the absolute-launcher ladder walks) and
    // `homeDir` (the `~/.codex/config.toml` target it REPORTS). Nothing else — it is on NEITHER
    // `RUNTIME_IO_CAPABLE` nor `FOLLOW_IO_CAPABLE`, so it holds no writer and no prompt channel,
    // and that absence is machine-checked at dispatch. EXACT-key, never the `mcp` noun.
    commandKey(spec) === "mcp print-config"
  );
}

/**
 * Does this command need the service-plane I/O seam (T-222, S5) injected onto `Ctx.service`?
 * `selftest` reads `installFs` + `platform`/`now`/`randomUUID` for its probes; the later service
 * nouns (`upgrade`/`dashboard`/`api`) join as their steps land. Noun-gated like the peers above.
 *
 * T-224: `setup` joins for four members it cannot get anywhere else — `installFs` + `now` + the
 * `skillSourceDir`/`pid` install facts (it calls `installSkill` itself, D2), `platform` + `argv1`
 * for the absolute-shim resolution ladder, and `runChild` to drive the `claude` CLI (we never
 * hand-edit `~/.claude.json`; Claude owns that schema). It is not a "service noun" in the
 * step-11 surface sense — that fixture locks the five nouns it names, and `setup` is none of them.
 */
export function commandNeedsService(spec: AnyCommandSpec): boolean {
  // T-228: `mcp doctor` joins for exactly two members — `installFs` (the NOFOLLOW fallback reader
  // behind its registration check) and `platform` (which client-config candidates exist on this
  // OS). It is not a "service noun" in the step-11 surface sense; EXACT-key, never the `mcp` noun,
  // so `mcp serve` keeps receiving nothing.
  //
  // `mcp print-config` joins for THREE — `argv1` + `installFs` + `platform`, which is exactly the
  // input tuple of `resolveAgkitBin` (`argv1` names the shim we were invoked through, `installFs`
  // is the ladder's lstat-only PATH probe, `platform` picks the shell-quoting dialect). Same
  // exact-key discipline, same reason.
  return (
    spec.noun === "selftest" ||
    spec.noun === "upgrade" ||
    spec.noun === "dashboard" ||
    spec.noun === "api" ||
    spec.noun === "setup" ||
    commandKey(spec) === "mcp doctor" ||
    commandKey(spec) === "mcp print-config"
  );
}

/**
 * Does this command need the API-URL exfiltration guard to run before dispatch (T-222 S6)? Every
 * credential-consuming command does (it must not target an unconfirmed host with a bearer). PLUS
 * `dashboard`: it sends NO credential, but it opens a browser at an origin DERIVED from
 * `AGKIT_API_URL` — a poisoned env is a phishing vector, so SECURE-outranks and the same guard
 * gates it, and its approved outcome is threaded onto the service seam (`approvedApiUrl`).
 */
export function commandNeedsUrlGuard(spec: AnyCommandSpec): boolean {
  return commandConsumesCredential(spec) || spec.noun === "dashboard";
}
