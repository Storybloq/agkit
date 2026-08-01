# `@storybloq/agkit` — AgentKit management CLI + MCP

`agkit` is the first-party command-line interface and MCP server for the AgentKit
management plane. One binary, three surfaces that share a single bundled core: the
`agkit` CLI, an MCP server (`agkit mcp serve`), and a typed library.

Because the three surfaces are generated from one command registry, they cannot drift
apart: the same paths, the same flags, the same required scopes, the same plan/apply
confirmation ceremony, whether a human types it, an agent calls it as an MCP tool, or
your own code imports it.

## Install

```sh
npm install -g @storybloq/agkit
```

Requires Node 22 or newer.

First-touch bootstrap without a global install:

```sh
npx @storybloq/agkit init
```

`npx` is supported for first-touch only (OD-24); the primary, supported path is the
global install.

## 60-second quickstart

Install → log in → set up a project → bind a tier to a model. The last step is a
production rebinding, so it goes through a plan and a typed confirmation.

**1. Install.**

```sh
npm install -g @storybloq/agkit
```

**2. Log in.**

```sh
agkit login
```

The credential lands in your OS keychain. Confirm it took:

```sh
agkit whoami
```

**3. Set up the project end to end.**

```sh
agkit init
```

`init` asks for what it needs (a project, a label for the publishable key, optionally a
provider to store an API key for), prints the whole plan of action before it does any of
it, and then runs it: it creates the project, mints a publishable key, stores the
provider credential you named, seeds recommended default routes, and writes the SDK
config artifact into the repository. Two of those legs are server-authored plans you see
and approve as they come up.

It also drops `.agentkit/project.json` in the repo, which pins the active project. That
is why nothing below needs a `--project` flag.

Non-interactively — CI, an agent, a script — there is no channel to ask on, so `--yes` is
required, and it has to carry the answers it can no longer prompt for: a project selector
(`--project <id>` for an existing one, `--project-name <name>` for a new one) and a key
label.

```sh
agkit init --yes --project-name <name> --key-name <label>
```

Be exact about what `--yes` buys, because the difference is your traffic. It answers the
plain `y/N` prompts, and it never satisfies a typed confirm. `init`'s second leg — the
provider credential plus the default model routes — is prod-rebinding, so under `--yes`
that plan is **created and left OPEN, never applied**: the run reports the credential and
the routes as `pending`, prints the plan id with a runnable `agkit plan show <plan-id>`
and `agkit plan apply <plan-id>` pair, and exits **3** — a partial, not a success. The
project, the publishable key and the config artifact are real; **your routes are not bound
until you apply that plan** with its typed confirm string, exactly the way step 5 does it.

**4. Bind a tier to a model — as a plan, not an edit.**

```sh
agkit route create --tier premium --model claude-opus-4-1 --provider anthropic --execution-target cloud_relay --attestation off --plan-only
```

Creating a model route is **PR** — prod-rebinding. It re-points live traffic, so the
server authors a plan instead of mutating anything. `--plan-only` stops right there and
emits that plan as data (exit 0); nothing has been applied yet. The plan carries its own
id and, because it is PR-class, the exact confirm string you have to repeat back.

**5. Apply it.** Take the id and the confirm string from the plan step 4 just emitted:

```sh
agkit apply plan_UKiJIG6eQXCCi-K6cyYxsA --confirm "apply PR plan: model_route.create"
```

Before it applies anything, the ceremony renders the plan on stderr so you are
confirming what the server actually intends to do, not what you meant to ask for:

```text
Plan plan_UKiJIG6eQXCCi-K6cyYxsA - danger PR (prod-rebinding)
  expires in 15m 0s
  !! PROD-REBINDING: this plan re-binds LIVE traffic - model_route.create
  changes:
    create model_route /v1/management/projects/00000000-0000-4000-b000-00000000900d/model-routes
      (absent) -> {"tier":"premium","model":"claude-opus-4-1","provider":"anthropic","execution_target":"cloud_relay","fallback_execution_target":null,"attestation":"off","enabled":true,"default":false}
  to proceed, type this confirm string exactly:
    apply PR plan: model_route.create
```

On a terminal you can leave `--confirm` off and type the string when prompted. Plans
expire, so a stale one is refused rather than silently re-created. `--yes` is not a
substitute here: destructive and prod-rebinding plans always require the typed string.

Safer classes are cheaper. A read costs no ceremony at all, and an ordinary mutation
takes a plain `y/N` that `--yes` answers — the typed confirm string appears only for the
two classes that can break a live app.

## The full command reference

The catalog is generated from the shipped registry, so it is never hand-maintained and
never stale:

```sh
agkit reference
agkit reference --json
```

`agkit reference` prints the human Markdown catalog. `agkit reference --json` prints the
machine registry — every command's path, flags, required scopes, danger class, and output
schema id — which is what you want when you are scripting against the CLI or checking a
flag spelling.

The same catalog ships inside this package as `skill/reference.md`, byte-identical to
what the command prints, so an agent can read it without executing anything. The source
repository is private, so there is no public docs URL to follow: the command is the link.

## Authentication

### Two login shapes, chosen for you

```sh
agkit login
```

When a browser is reachable, this runs the OAuth **authorization-code flow with PKCE**
against a loopback redirect on your own machine — nothing but the browser ever sees the
authorization code. On an SSH session, in a container, or anywhere a browser cannot be
opened, it runs the OAuth **device flow** instead: the CLI prints a URL and a user code
you enter from any other device. Force that path explicitly with:

```sh
agkit login --device
```

Which flow was chosen is announced on stderr before anything starts, so a headless
machine never silently does something other than what you expected.

### Tokens for CI and agents

Humans log in; robots get a minted, scoped, expiring token:

```sh
agkit token create --name ci-bot --scope routes:read --expires-in 30d
```

Both flags are structural, not decoration. `--scope` (repeat it once per scope) makes
least privilege the only way to mint — a token cannot be born with more authority than
you named. `--expires-in` is required in a non-interactive shell and capped, and there is
no opt-out flag: every minted token has an end date.

The secret is displayed exactly once, at mint time, and is never retrievable again. Hand
it to the consumer through the environment:

```sh
export AGKIT_TOKEN=REDACTED_SHOWN_ONCE
```

### Scopes

A scope names a resource family and a verb, and the verbs form a ladder:
`read` < `write` < `destroy`. Holding a higher verb satisfies the lower ones **within the
same family**, and never across families — a deploy token with write on routes still
cannot delete an issuer.

Those `family:verb` strings are the whole vocabulary `--scopes` (on login) and `--scope`
(on a token mint) accept. Both are validated locally against the contract registry before
anything is sent, so a scope the contract cannot name is a usage error on your machine,
never a request the server has to judge.

Three named profiles group that ladder on the **consent screen**. They are labels the
authorization server renders for a grant; they are not values `--scopes` accepts.

- **`read-only`** — every read verb, nothing else.
- **`default`** — every read verb plus write on the configuration families. This is what
  `agkit login` requests when you pass no `--scopes`, and it is sized to cover
  `agkit init` end to end. It deliberately excludes destroy, billing, token minting, and
  the kill switch. The mechanism is subtraction, not a spelling: with no `--scopes` the
  CLI omits the scope parameter entirely, so consent applies its own default.
- **`full`** — everything mintable.

The scope registry itself is not duplicated here, because a hand-copied catalog is a
catalog that rots. Every command's required scopes are carried in the generated
reference — the `scopes` field of each entry in `agkit reference --json`.

### Where credentials come from

One chain, used identically by the CLI and by the local MCP server, in this order:

1. **`AGKIT_TOKEN`** — when set and non-empty it short-circuits the entire chain; no
   keychain access is attempted at all. This is the CI and agent path.
2. **OS keychain**, via `@napi-rs/keyring` — service `agkit-cli`, account = the active
   profile.
3. **Credential helper** — a configured executable whose stdout is one bare token.
4. **A loud, structured failure (exit 2).** There is no silent fallback to a plaintext
   file and no anonymous request: if no credential is available, the command stops and
   tells you which remedy applies.

On SSH and headless boxes the OS keychain is often missing or locked, and step 4 is what
you will hit. Two honest ways through it: run `agkit login --device` on that machine, or
mint a token elsewhere and export `AGKIT_TOKEN` for the session.

## MCP client setup (local stdio)

An MCP client spawns the server itself — you register the command once and never run it
by hand:

```sh
agkit mcp serve
```

Its stdout carries MCP protocol frames and nothing else; every diagnostic goes to stderr.

### Claude Code

```sh
claude mcp add agkit -s user -- agkit mcp serve
```

`-s user` is deliberate: a project-scope registration would follow one repository, while
this one provisions your machine.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agkit]
command = "agkit"
args = ["mcp", "serve"]
```

### Regenerating these snippets

The two blocks above show the generic `agkit` form, which pastes on any machine. To emit
them with the **absolute** path of the binary on *this* machine — what a client should
actually register, so an nvm/fnm `PATH` change cannot break it — run:

```sh
agkit mcp print-config
```

The command writes nothing; `agkit setup` is what edits client configs. Machine-readable:
`agkit mcp print-config --json`.

The server implements MCP protocol revision **2025-11-25** and negotiates down to any
earlier revision a client requests.

### Identity, credentials, and environment

MCP registry identity, in the first-party namespace: `cloud.agkit/agkit`.

The local MCP server **reuses the CLI credential chain** described above — the same
single seeded client (`agkit-cli`), the same precedence order, the same keychain entry.
Whatever `agkit login` stored is what the server presents. Two consequences follow, both
intentional:

- There is **no separate stdio OAuth client** for MCP. Nothing to register, nothing to
  keep in sync, no second credential to leak.
- There is **no `agkit_login` MCP tool**. Logging in is a CLI-only action, so an MCP
  host can spend your authority but can never mint, move, or widen it.

The four environment variables an MCP host may set for the server: `AGKIT_TOKEN`,
`AGKIT_PROJECT`, `AGKIT_API_URL`, `AGKIT_PROFILE`.
