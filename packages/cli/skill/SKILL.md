---
name: agkit
description: >-
  Drive the AgentKit management plane from the `agkit` CLI (auth, projects,
  issuers, profiles, config) as a structured JSON API. Load when an agent needs to
  authenticate, inspect session/context, or perform management-plane operations via
  `agkit` (or shell out to it as an MCP fallback). Teaches JSON-envelope discipline,
  the mutation/confirmation safety policy, error self-correction, and the exit-code
  contract.
---

# agkit — the AgentKit management CLI (agent skill)

`agkit` is the management-plane CLI for AgentKit Cloud. **You are an agent: treat it
as a JSON API, not a text UI.** Add `--json` to every call, branch on the envelope
and the process exit code, and NEVER parse the human-mode tables (they are for
people and are not a contract). This file is a router — dispatch to the linked
support files on demand:

- **`json-recipes.md`** — the `{version,data|error}` envelope, `--json`/`--jq`/
  `--compact`, field projection, pagination. Read first.
- **`auth-bootstrap.md`** — the credential ladder (`AGKIT_TOKEN` → `login` →
  `login --device` → CI token) and auth error recovery.
- **`plan-apply.md`** — mutation policy, the `--yes`/`--confirm` prohibition, plan/
  apply, `confirmation_required`.
- **`init-flow.md`** — session start: `status` → `whoami` → resolve project context.
- **`reference.md`** — the FULL, generated command catalog (every noun/verb, danger
  class, scopes, examples, MCP tool). Authoritative for exact command surface.

## 1. Session start (see `init-flow.md`)

```
agkit status --json          # local snapshot; exit 0 even when unauthenticated
```

Branch on `data.authenticated` (bool). If `false` → run the auth ladder before any
authenticated call. If `true` → `agkit whoami --json` to confirm identity, then
resolve the effective project/profile from `data` (each value carries its
`*_source` = which precedence layer it came from): flag > env > repo > profile >
config > builtin.

## 2. Authentication (see `auth-bootstrap.md`)

Ladder, first match wins: `AGKIT_TOKEN` set → use it · interactive TTY + browser →
`agkit login` · headless interactive → `agkit login --device` · CI → a human mints
`agkit token create --scope <s> --expires-in <d>` out of band and exposes it as
`AGKIT_TOKEN`. `login`/`token` are the documented surface; discover what's available
now with `agkit --help`. Credentials NEVER live in `config.json`.

## 3. JSON discipline (see `json-recipes.md`)

- Always `--json`. Parse `data.<field>` / `error.code`. Never scrape human text.
- `--compact` in tight loops; `--json id,name` to project fields; `--jq '<expr>'`
  for transforms (a jq engine is built in — no system jq, no external pipe needed).
- Success envelope `{ "version": <int>, "data": <payload> }`; error envelope
  `{ "version": <int>, "error": { "code", "message", "title", "hint", "exit_code",
  ... } }`. Presence of `data` vs `error` is the branch.

## 4. Mutation policy (see `plan-apply.md`) — THE SAFETY RULE

Danger classes (from `reference.md`): `SR` safe-read · `M` mutating · `D`
destructive · `PR` prod-rebinding.

**An agent MUST NOT pass `--yes` on a D/PR-class command, or pass `--confirm` at
all, unless the user explicitly instructed that specific change.** Auto-confirming a
destroy or prod-rebind is forbidden. `confirmation_required` returned on a non-TTY is
the NORMAL, correct shape for an unconfirmed destructive command — not a failure to
route around. Report the pending change and wait for an explicit go-ahead; only then
re-run with `--confirm <resource-name>`.

## 5. Error self-correction (key on `error.code`, never on prose)

Read `error.code` from the `--json` envelope and apply the recovery. `error.hint` is
always an exact, runnable command; `error.exit_code` mirrors the process exit.

CLI-local codes (all terminal, exit 2):

| `error.code`                | meaning → recovery                                            |
|-----------------------------|---------------------------------------------------------------|
| `usage_error`               | bad args/flags → `agkit <cmd> --help`                         |
| `unknown_field`             | `--json <f>` names a missing field → read `error.available_fields` |
| `ambiguous_prefix`          | id prefix matched >1 → use a fuller id from `error.candidates` |
| `confirmation_required`     | D/PR needs confirm → NORMAL; confirm only if authorized (§4)   |
| `not_logged_in`             | no credential → set `AGKIT_TOKEN` / `agkit login`             |
| `keychain_unavailable`      | no OS keychain → prefer `AGKIT_TOKEN`                          |
| `insecure_storage_refused`  | CI plaintext → set `AGKIT_ALLOW_INSECURE_STORAGE=1` or use token |
| `insecure_file_permissions` | widened creds file → `chmod 600` (see `error.hint`)           |
| `version_skew`              | CLI < server → `npm install -g @shyegg/agkit@latest`          |

Wire (server) codes carry a `retry` class in `error.retry`. Retry with backoff ONLY
`retry_with_backoff` codes (`rate_limited`, `idempotency_in_flight`, `internal_error`,
`upstream_error`, `service_unavailable`); `refresh_auth` (`token_expired`) → refresh
the credential; `none` → terminal, do not auto-retry. Plan codes (`plan_stale`,
`plan_expired`, `plan_already_applied`, `confirm_required`) → see `plan-apply.md`.

## 6. Getting there: MCP tools vs. shelling out

Prefer native MCP tools when the agkit MCP server is present in your tool list (tool
names look like `agkit_project_read`, `agkit_project_plan`, `agkit_issuer_plan` —
the projection in `reference.md`). If no agkit MCP tools are available, **shell out**
to the CLI via Bash and read its `--json` stdout exactly as above:

```
agkit project list --json --jq '.data[].id'
```

Either path speaks the same registry and the same envelope — choose by availability,
not preference. When shelling out, always append `--json`.

## 7. Config schema (inline)

`config.json` holds NON-secret settings only, managed by `agkit config
get|set|unset|list`. The closed key set:

| key               | type                    | meaning                                  |
|-------------------|-------------------------|------------------------------------------|
| `api_url`         | absolute URL            | management API base (non-default host → exfil guard) |
| `default_profile` | string                  | profile when none selected               |
| `telemetry`       | boolean                 | opt-in analytics (metadata only)         |
| `color`           | `auto`\|`always`\|`never` | human-output color                      |

There is deliberately **no `token` key** — credentials are never stored in config.
An unknown key is a `usage_error` (exit 2) listing the valid keys.

## 8. Exit-code contract (branch on this first)

| exit | class     | agent action                                              |
|------|-----------|-----------------------------------------------------------|
| `0`  | success   | read `data`                                               |
| `1`  | retryable | transient (network/5xx/429-after-retries) → backoff+retry |
| `2`  | terminal  | validation/auth/scope/not-found/every CLI-local code → fix, don't retry |
| `3`  | partial   | batch/pagination partial success (`data` + `warnings[]`)  |
| `130`| SIGINT    | interrupted (Ctrl-C)                                       |

Exit code and `error.exit_code` are the same value (single source). A non-zero exit
is control flow, not a crash — handle it, don't abort.
