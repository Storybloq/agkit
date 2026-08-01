# agkit — session-start / project context resolution

Run this once at the start of a session before doing management work, so you act with
a known identity and against the intended project.

## Step 1 — snapshot the local session

```
agkit status --json
```

`status` is a **local** aggregate (exit 0 even when unauthenticated — an
unauthenticated session is DATA, not an error). Read from `data`:

- `authenticated` (bool), `credential_source` (`env`/`keychain`/`insecure_file`/`none`)
- `profile` + `profile_source`, `project` + `project_source`,
  `api_url` + `api_url_source` — each effective value WITH the precedence layer it
  came from
- `api_url_guard` — whether the exfiltration guard is satisfied for a non-default host
- `config_path`, `config_present`, `cli_version`, `update_available`
- server-dependent fields (`server_reachable`, `management_version`, `principal`,
  `scopes`, `pending_plans`) are `null` until the typed client is wired — do not
  treat `null` as "false".

## Step 2 — branch on `authenticated`

- `data.authenticated === false` → run the **auth ladder** (`auth-bootstrap.md`)
  before any authenticated command. Do not attempt server calls first.
- `data.authenticated === true` → confirm *who* you are:

```
agkit whoami --json
```

Read the credential identity from `data`. (Server-verified identity/scope fields land
with the typed client; until then `whoami` reports the local credential source.)

## Step 3 — resolve project context (the precedence chain)

The effective `profile` / `project` / `api_url` are resolved by a fixed precedence,
highest wins:

1. **flag** — `--profile <p>` / `--project <p>` on the command
2. **env** — `AGKIT_PROFILE` / `AGKIT_PROJECT` (and `AGKIT_TOKEN` for the credential)
3. **repo** — a project pinned by the current git repo (auto-discovered from `cwd`)
4. **profile** — the active profile's stored defaults
5. **config** — top-level `config.json` defaults
6. **builtin** — the shipped default (e.g. `api_url` = `https://api.agkit.cloud`)

`status` already tells you which layer each value came from via `*_source` — use that
instead of guessing. To target a specific project deterministically, pass
`--project <id>` (flag wins over everything) rather than relying on ambient state.

## Step 4 — pick / manage a profile (optional)

- `agkit profile list --json` — known profiles, active one marked in `data`.
- `agkit profile show --json` — the active profile's defaults + credential presence.
- `agkit profile use --name <p>` — make a profile the active default (mutating).

## Project init

For an EXISTING project, nothing here is needed: select it via the precedence chain
above (usually `--project`, an env var, or the repo pin).

For a NEW project there is `agkit init` — an interactive onboarding **orchestrator**
that creates the project, mints a publishable key (shown once), optionally stores a
provider credential, creates the missing recommended default model routes, and writes
`.agentkit/project.json` (plus `agentkit.config.json` in a JS/TS repo) into the repo.
It runs its own plan ceremonies internally, so it is not a `plan-apply.md` flow.

**An agent MUST NOT run it.** It prompts, writes files into the user's repo, and
discloses a shown-once secret; it is excluded from the MCP surface for exactly those
reasons, and the `--yes` prohibition in `SKILL.md` applies to it in full (`init --yes`
is a human/CI affordance, never an agent one). Ask the user to run `agkit init`
themselves, then continue from the project id it reports.

To create a project WITHOUT the onboarding orchestration, `agkit project create --name
<name>` is still the primitive (mutating; plan/apply + confirmation policy in
`plan-apply.md`). Confirm the resulting id from the `data` envelope, then pin it
(`--project <id>` or `AGKIT_PROJECT`) for the rest of the session.

Re-running `agkit init` in an already-initialized repo is safe: it verifies the pinned
project against live state first and reports `complete` / `incomplete` / `drift_only`
without mutating anything it did not need to create.
