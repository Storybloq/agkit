# agkit command reference

_Generated from the CommandSpec registry (`src/commands/registry.ts`). Do not hand-edit._

## version

### agkit version

Print the agkit CLI version.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/version.get.output.json`
- MCP: excluded (cross-cutting local command; not a management resource tool)

Examples:

```
agkit version
```

## whoami

### agkit whoami

Report the active agkit credential (local source, enriched with the server identity when reachable).

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/whoami.get.output.json`
- MCP: excluded (cross-cutting auth self-lookup (N-011 A003); not a management resource tool)

Examples:

```
agkit whoami
```

## status

### agkit status

Report the local session: auth, effective context + sources, config, update notice.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/status.get.output.json`
- MCP: excluded (cross-cutting local session aggregate (server fields land in T-211); not a management resource tool)

Examples:

```
agkit status
```

## config

### agkit config list

List the registered config keys with their current values.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/config.list.output.json`
- MCP: excluded (cross-cutting local config command; not a management resource tool)

Examples:

```
agkit config list
```

### agkit config get

Read one config key.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/config.get.output.json`
- MCP: excluded (cross-cutting local config command; not a management resource tool)

Examples:

```
agkit config get --key api_url
```

### agkit config set

Set one config key (validated per its type).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/config.set.output.json`
- MCP: excluded (cross-cutting local config command; not a management resource tool)

Examples:

```
agkit config set --key color --value never
```

### agkit config unset

Remove one config key (revert to its built-in default).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/config.unset.output.json`
- MCP: excluded (cross-cutting local config command; not a management resource tool)

Examples:

```
agkit config unset --key api_url
```

## profile

### agkit profile list

List known profiles (with the active one marked).

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/profile.list.output.json`
- MCP: excluded (cross-cutting local profile command; not a management resource tool)

Examples:

```
agkit profile list
```

### agkit profile show

Show one profile's defaults + credential presence.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/profile.show.output.json`
- MCP: excluded (cross-cutting local profile command; not a management resource tool)

Examples:

```
agkit profile show
agkit profile show --name staging
```

### agkit profile use

Make a profile the active default.

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/profile.use.output.json`
- MCP: excluded (cross-cutting local profile command; not a management resource tool)

Examples:

```
agkit profile use --name staging
```

### agkit profile rename

Rename a profile (migrates its config + credential).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/profile.rename.output.json`
- MCP: excluded (cross-cutting local profile command; not a management resource tool)

Examples:

```
agkit profile rename --old dev --new staging
```

### agkit profile delete

Delete a profile (removes its keychain entry + config).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/profile.delete.output.json`
- MCP: excluded (cross-cutting local profile command; not a management resource tool)

Examples:

```
agkit profile delete --name staging
```

## project

### agkit project list (aliases: ls)

List projects.

- danger: `SR`
- scopes: `projects:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.list.output.json`
- MCP: `agkit_project_read`

Examples:

```
agkit project list
agkit project list --limit 50
```

### agkit project get

Show a project (defaults to the effective project).

- danger: `SR`
- scopes: `projects:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.get.output.json`
- MCP: `agkit_project_read`

Examples:

```
agkit project get proj_123
agkit project get
```

### agkit project summary

Show a project's resource summary (defaults to the effective project).

- danger: `SR`
- scopes: `projects:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.summary.output.json`
- MCP: `agkit_project_read`

Examples:

```
agkit project summary
agkit project summary proj_123
```

### agkit project create

Create a project.

- danger: `M`
- scopes: `projects:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.create.output.json`
- MCP: `agkit_project_plan`{create}
- prompts: name (--name)

Examples:

```
agkit project create --name Acme
```

### agkit project rename

Rename a project.

- danger: `M`
- scopes: `projects:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.rename.output.json`
- MCP: `agkit_project_plan`{rename}

Examples:

```
agkit project rename proj_123 --name NewName
```

### agkit project archive

Archive a project (bricks its apps — destructive).

- danger: `D`
- scopes: `projects:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/project.archive.output.json`
- MCP: `agkit_project_plan`{archive}
- typed-confirm: type the confirm-string

Examples:

```
agkit project archive proj_123
```

## issuer

### agkit issuer list

List the project's trusted issuers.

- danger: `SR`
- scopes: `issuers:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/issuer.list.output.json`
- MCP: `agkit_issuer_read`

Examples:

```
agkit issuer list
```

### agkit issuer get

Show a trusted issuer.

- danger: `SR`
- scopes: `issuers:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/issuer.get.output.json`
- MCP: `agkit_issuer_read`

Examples:

```
agkit issuer get iss_123
```

### agkit issuer create

Add a trusted issuer (prod-rebinding).

- danger: `PR`
- scopes: `issuers:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/issuer.create.output.json`
- MCP: `agkit_issuer_plan`{create}
- typed-confirm: type the confirm-string

Examples:

```
agkit issuer create --kind apple --audience api.agkit.cloud
agkit issuer create --kind firebase --firebase-project-id acme-prod
agkit issuer create --kind custom_jwks --issuer https://id.acme.com --audience api.agkit.cloud --jwks-uri https://id.acme.com/.well-known/jwks.json
```

### agkit issuer update

Update a trusted issuer's config (kind is immutable; prod-rebinding).

- danger: `PR`
- scopes: `issuers:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/issuer.update.output.json`
- MCP: `agkit_issuer_plan`{update}
- typed-confirm: type the confirm-string

Examples:

```
agkit issuer update iss_123 --audience api.agkit.cloud
```

### agkit issuer delete

Delete a trusted issuer (locks out its end-users — destructive, prod-rebinding).

- danger: `PR`
- scopes: `issuers:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/issuer.delete.output.json`
- MCP: `agkit_issuer_plan`{delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit issuer delete iss_123
```

## plan

### agkit plan list

List plans (most recent first).

- danger: `SR`
- scopes: `plans:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/plan.list.output.json`
- MCP: `agkit_plan_read`

Examples:

```
agkit plan list
agkit plan list --limit 50
```

### agkit plan show

Show a plan (its diff, danger, confirm string, and expiry).

- danger: `SR`
- scopes: `plans:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/plan.show.output.json`
- MCP: `agkit_plan_read`

Examples:

```
agkit plan show plan_123
```

### agkit plan discard

Discard an open plan (zero side effects on managed state).

- danger: `M`
- scopes: `plans:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/plan.discard.output.json`
- MCP: excluded (fixed MCP tool agkit_plan_discard is contributed by L3-M1 (APX-D: not a verb-folded resource tool))

Examples:

```
agkit plan discard plan_123
```

### agkit plan apply

Apply an open plan (the gated executor; the server enforces the contained changes' write scopes at apply time).

- danger: `PR`
- scopes: `plans:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/plan.apply.output.json`
- MCP: excluded (the single gated MCP executor agkit_apply is contributed by L3-M1 (APX-D: not a verb-folded resource tool))
- typed-confirm: type the confirm-string

Examples:

```
agkit plan apply plan_123
agkit apply plan_123
```

## login

### agkit login

Log in and store a management credential (browser or device flow, auto-detected).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/login.create.output.json`
- MCP: excluded (interactive auth lifecycle (N-011 APX-E.4); never a management-resource MCP tool)

Examples:

```
agkit login
agkit login --device
agkit login --scopes projects:read,routes:write
```

## logout

### agkit logout

Log out: best-effort server revocation + clear the stored management credential.

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/logout.clear.output.json`
- MCP: excluded (interactive auth lifecycle (N-011 APX-E.4); never a management-resource MCP tool)

Examples:

```
agkit logout
agkit logout --all-profiles
```

## token

### agkit token list

List management tokens for the current project (masked display forms only).

- danger: `SR`
- scopes: `tokens:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/token.list.output.json`
- MCP: `agkit_token_read`

Examples:

```
agkit token list
agkit token list --limit 50
```

### agkit token get

Show one management token by id or unambiguous id/display prefix (revoked: full id only).

- danger: `SR`
- scopes: `tokens:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/token.get.output.json`
- MCP: `agkit_token_read`

Examples:

```
agkit token get --id 1a2b3c4d
agkit token get --id 1a2b3c4d-0000-4000-a000-000000000001
```

### agkit token create

Mint a project-scoped management token (secret shown once). Re-run mints a NEW token; use --idempotency-key to safe-retry.

- danger: `M`
- scopes: `tokens:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/token.create.output.json`
- MCP: excluded (secret-bearing shown-once mint (human ceremony); not exposed as an MCP tool)

Examples:

```
agkit token create --name ci-bot --scope tokens:read --expires-in 30d
agkit token create --name deploy --scope routes:read --scope routes:write --expires-in 90d
```

### agkit token revoke

Revoke a management token by id or unambiguous id/display prefix (destructive; confirm by name).

- danger: `D`
- scopes: `tokens:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/token.revoke.output.json`
- MCP: excluded (destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool)
- typed-confirm: type the token-name

Examples:

```
agkit token revoke --id 1a2b3c4d-0000-4000-a000-000000000001 --confirm ci-bot
```

## grant

### agkit grant list

List OAuth grants on the account.

- danger: `SR`
- scopes: `tokens:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/grant.list.output.json`
- MCP: `agkit_grant_read`

Examples:

```
agkit grant list
agkit grant list --limit 200
```

### agkit grant show

Show an OAuth grant, including child-token metadata and live-token counts.

- danger: `SR`
- scopes: `tokens:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/grant.show.output.json`
- MCP: `agkit_grant_read`

Examples:

```
agkit grant show 3a1f2b3c-0000-0000-0000-000000000000
```

### agkit grant revoke

Revoke an OAuth grant and cascade-revoke its tokens.

- danger: `D`
- scopes: `tokens:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/grant.revoke.output.json`
- MCP: excluded (destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool)
- typed-confirm: type the resource-name

Examples:

```
agkit grant revoke 3a1f2b3c-0000-0000-0000-000000000000 --confirm "agkit CLI"
```

## usage

### agkit usage series

Show the usage time-series for the project.

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/usage.series.output.json`
- MCP: `agkit_usage_read`

Examples:

```
agkit usage series
agkit usage series --days 30 --dimension execution_target
```

### agkit usage requests

List the request log for the project (paginated).

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/usage.requests.output.json`
- MCP: `agkit_usage_read`

Examples:

```
agkit usage requests
agkit usage requests --limit 50
```

### agkit usage top-users

Show the top-N end-users by usage for the project.

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/usage.top-users.output.json`
- MCP: `agkit_usage_read`

Examples:

```
agkit usage top-users
agkit usage top-users --limit 10
```

## end-user

### agkit end-user list

List the project's end-users (paginated).

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/end-user.list.output.json`
- MCP: `agkit_end_user_read`

Examples:

```
agkit end-user list
agkit end-user list --limit 50
```

### agkit end-user get

Show one end-user's usage detail (embeds a models[] breakdown — project it with --jq .models).

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/end-user.get.output.json`
- MCP: `agkit_end_user_read`

Examples:

```
agkit end-user get --user-hash 0000000000000000000000000000000000000000000000000000000000000000
```

## media-usage

### agkit media-usage summary

Show the media-usage summary for the project.

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-usage.summary.output.json`
- MCP: `agkit_media_usage_read`

Examples:

```
agkit media-usage summary
agkit media-usage summary --days 7
```

### agkit media-usage costs

Show media-usage costs for the project.

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-usage.costs.output.json`
- MCP: `agkit_media_usage_read`

Examples:

```
agkit media-usage costs
agkit media-usage costs --days 7
```

### agkit media-usage requests

List the media request log for the project (paginated).

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-usage.requests.output.json`
- MCP: `agkit_media_usage_read`

Examples:

```
agkit media-usage requests
agkit media-usage requests --limit 50
```

## media-job

### agkit media-job list

List the project's media jobs (paginated).

- danger: `SR`
- scopes: `jobs:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-job.list.output.json`
- MCP: `agkit_media_job_read`

Examples:

```
agkit media-job list
agkit media-job list --status completed --limit 50
```

### agkit media-job get

Show one media job.

- danger: `SR`
- scopes: `jobs:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-job.get.output.json`
- MCP: `agkit_media_job_read`

Examples:

```
agkit media-job get --id mj_123
```

## audit

### agkit audit

List the account audit log (de-clamped keyset pagination; --project filters to one project).

- danger: `SR`
- scopes: `audit:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/audit.list.output.json`
- MCP: `agkit_audit_read`

Examples:

```
agkit audit
agkit audit --since 2026-07-01 --action project.create
```

## attested-key

### agkit attested-key list

List the project's attested keys (paginated).

- danger: `SR`
- scopes: `attest:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/attested-key.list.output.json`
- MCP: `agkit_attested_key_read`

Examples:

```
agkit attested-key list
agkit attested-key list --user-hash 0000000000000000000000000000000000000000000000000000000000000000
```

### agkit attested-key revoke

Revoke an attested device key by row id (destructive; confirm by the Apple App Attest key_id).

- danger: `D`
- scopes: `attest:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/attested-key.revoke.output.json`
- MCP: excluded (destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool)
- typed-confirm: type the key-id

Examples:

```
agkit attested-key revoke --id 1a2b3c4d-0000-4000-a000-000000000001 --confirm <key-id>
```

## account

### agkit account get

Show the account profile.

- danger: `SR`
- scopes: `account:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/account.get.output.json`
- MCP: `agkit_billing_read`

Examples:

```
agkit account get
```

### agkit account usage

Show account-level usage.

- danger: `SR`
- scopes: `usage:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/account.usage.output.json`
- MCP: `agkit_usage_read`

Examples:

```
agkit account usage
```

### agkit account security

Print the dashboard account-security page link (TOTP, password) and report what this credential can actually do.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/account.security.output.json`
- MCP: excluded (human browser deep-link + auth self-lookup (N-011 A003 class): prints a dashboard-session URL a token principal cannot use and principal facts the whoami self-lookup already owns)

Examples:

```
agkit account security
```

## billing

### agkit billing info

Show the current billing state.

- danger: `SR`
- scopes: `billing:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/billing.info.output.json`
- MCP: `agkit_billing_read`

Examples:

```
agkit billing info
```

### agkit billing plans

List the available billing plans (server truth; no local catalog).

- danger: `SR`
- scopes: `billing:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/billing.plans.output.json`
- MCP: `agkit_billing_read`

Examples:

```
agkit billing plans
```

### agkit billing checkout

Start a Stripe checkout session for a plan (returns a URL to open in a browser).

- danger: `M`
- scopes: `billing:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/billing.checkout.output.json`
- MCP: excluded (human browser ceremony — returns a Stripe checkout URL for a human to open; never a Plan)

Examples:

```
agkit billing checkout --plan pro
```

### agkit billing portal

Open the Stripe billing portal (returns a URL to open in a browser).

- danger: `M`
- scopes: `billing:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/billing.portal.output.json`
- MCP: excluded (human browser ceremony — returns a Stripe billing-portal URL for a human to open; never a Plan)

Examples:

```
agkit billing portal
```

## member

### agkit member

List the account's team members.

- danger: `SR`
- scopes: `account:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/member.list.output.json`
- MCP: `agkit_member_read`

Examples:

```
agkit member
```

## publishable-key (alias: pk)

### agkit publishable-key list

List the project's publishable keys (masked; paginated).

- danger: `SR`
- scopes: `keys:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/publishable-key.list.output.json`
- MCP: `agkit_key_read`

Examples:

```
agkit publishable-key list
agkit publishable-key list --limit 50
```

### agkit publishable-key create

Mint a publishable key (the full ak_pk_live_ value is shown once). --idempotency-key <k> for safe retry.

- danger: `M`
- scopes: `keys:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/publishable-key.create.output.json`
- MCP: excluded (direct shown-once mint returns no Plan (N-011 APX-D); cannot honestly project as a plan tool)

Examples:

```
agkit publishable-key create --name prod-web
```

### agkit publishable-key revoke

Revoke a publishable key (bricks apps using it — destructive; confirm by name).

- danger: `D`
- scopes: `keys:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/publishable-key.revoke.output.json`
- MCP: excluded (destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool)
- typed-confirm: type the resource-name

Examples:

```
agkit publishable-key revoke pk_123 --confirm prod-web
```

## attestation

### agkit attestation get

Show the project's App Attest configuration.

- danger: `SR`
- scopes: `projects:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/attestation.get.output.json`
- MCP: `agkit_attestation_read`

Examples:

```
agkit attestation get
```

### agkit attestation set

Set or clear the project's App Attest configuration.

- danger: `M`
- scopes: `projects:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/attestation.set.output.json`
- MCP: `agkit_attestation_plan`{set}

Examples:

```
agkit attestation set --app-attest-app-id TEAM1.com.acme.app --environment production
agkit attestation set --clear
```

## provider-key

### agkit provider-key list

List provider credentials for the current project (masked prefix metadata only; never key material).

- danger: `SR`
- scopes: `provider-keys:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/provider-key.list.output.json`
- MCP: `agkit_provider_key_read`

Examples:

```
agkit provider-key list
```

### agkit provider-key add

Store a provider credential (secret via --api-key-env <VAR>, --api-key-file <PATH>, or a hidden prompt; never argv). Re-run to add another provider.

- danger: `M`
- scopes: `provider-keys:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/provider-key.add.output.json`
- MCP: `agkit_provider_key_plan`{add}

Examples:

```
agkit provider-key add --provider example-llm --api-key-env EXAMPLE_LLM_KEY
agkit provider-key add --provider example-llm --api-key-env EXAMPLE_LLM_KEY --endpoint-url https://api.example.com/v1 --auth-style example-style --header-name api-key --extra-header x-title=my-app
```

### agkit provider-key rotate

Rotate a provider credential to a new key (prod-rebinding; secret via --api-key-env <VAR>, --api-key-file <PATH>, or a hidden prompt).

- danger: `PR`
- scopes: `provider-keys:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/provider-key.rotate.output.json`
- MCP: `agkit_provider_key_plan`{rotate}
- typed-confirm: type the confirm-string

Examples:

```
agkit provider-key rotate --provider example-llm --api-key-env EXAMPLE_LLM_KEY
```

### agkit provider-key revoke

Revoke a provider credential (SOFT delete — stops dispatching immediately; confirm by provider slug).

- danger: `PR`
- scopes: `provider-keys:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/provider-key.revoke.output.json`
- MCP: excluded (destructive direct_confirm revoke (typed human confirm ceremony); returns no plan — not an MCP tool)
- typed-confirm: type the resource-name

Examples:

```
agkit provider-key revoke --provider example-llm --confirm example-llm
```

## route

### agkit route list

List model routes for the current project (tier → model/provider/execution-target bindings).

- danger: `SR`
- scopes: `routes:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.list.output.json`
- MCP: `agkit_route_read`

Examples:

```
agkit route list
```

### agkit route get

Show one model route by id.

- danger: `SR`
- scopes: `routes:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.get.output.json`
- MCP: `agkit_route_read`

Examples:

```
agkit route get mr_123
```

### agkit route defaults

Show the recommended default model routes for the current project (the server's starting catalog).

- danger: `SR`
- scopes: `routes:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.defaults.output.json`
- MCP: `agkit_route_read`

Examples:

```
agkit route defaults
```

### agkit route create

Create a model route (prod-rebinding): bind a tier to a model/provider/execution-target.

- danger: `PR`
- scopes: `routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.create.output.json`
- MCP: `agkit_route_plan`{create}
- typed-confirm: type the confirm-string

Examples:

```
agkit route create --tier example-tier --model example-model --provider example-llm --execution-target example-target --attestation off
```

### agkit route update

Update a model route (prod-rebinding): patch its binding members (tier is immutable).

- danger: `PR`
- scopes: `routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.update.output.json`
- MCP: `agkit_route_plan`{update}
- typed-confirm: type the confirm-string

Examples:

```
agkit route update mr_123 --model example-model
```

### agkit route delete

Delete a model route (prod-rebinding, destructive).

- danger: `PR`
- scopes: `routes:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/route.delete.output.json`
- MCP: `agkit_route_plan`{delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit route delete mr_123
```

## secret-source

### agkit secret-source list

List the declared indirect secret sources for the active profile (names and paths only; never values).

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/secret-source.list.output.json`
- MCP: excluded (operator allowlist for indirect secret sources — writable ONLY from the CLI channel (an MCP host that could declare a source could expand its own read authority); not an MCP tool)

Examples:

```
agkit secret-source list
```

### agkit secret-source add

Declare an env var or a file as a secret source the MCP surface may reference (a declaration holds no secret material).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/secret-source.add.output.json`
- MCP: excluded (operator allowlist for indirect secret sources — writable ONLY from the CLI channel (an MCP host that could declare a source could expand its own read authority); not an MCP tool)

Examples:

```
agkit secret-source add --env EXAMPLE_LLM_KEY
agkit secret-source add --file /etc/agentkit/example-llm.key
```

### agkit secret-source remove

Withdraw a declared secret source (indirect references to it stop being honored).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/secret-source.remove.output.json`
- MCP: excluded (operator allowlist for indirect secret sources — writable ONLY from the CLI channel (an MCP host that could declare a source could expand its own read authority); not an MCP tool)

Examples:

```
agkit secret-source remove --env EXAMPLE_LLM_KEY
agkit secret-source remove --file /etc/agentkit/example-llm.key
```

## agent

### agkit agent list

List the project's agent profiles.

- danger: `SR`
- scopes: `agents:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.list.output.json`
- MCP: `agkit_agent_read`

Examples:

```
agkit agent list
```

### agkit agent get

Show an agent profile.

- danger: `SR`
- scopes: `agents:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.get.output.json`
- MCP: `agkit_agent_read`

Examples:

```
agkit agent get support-bot
```

### agkit agent create

Create an agent profile (prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.create.output.json`
- MCP: `agkit_agent_plan`{create}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent create support-bot --display-name "Support Bot" --static-system-prompt "You help customers." --allowed-tiers example-tier-a --allowed-tiers example-tier-b --max-input-tokens 8000 --max-output-tokens 2000
```

### agkit agent update

Update an agent profile's config (slug is immutable; prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.update.output.json`
- MCP: `agkit_agent_plan`{update}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent update support-bot --display-name "Support Assistant"
```

### agkit agent delete

Delete an agent profile (cascades to its tools + knowledge bindings — destructive, prod-rebinding).

- danger: `PR`
- scopes: `agents:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.delete.output.json`
- MCP: `agkit_agent_plan`{delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent delete support-bot
```

### agkit agent sync

Sync agent profiles from a JSON file (upsert-only; prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent.sync.output.json`
- MCP: excluded (direct_confirm: no TTY for the typed challenge and no local file over MCP ⇒ would be an unconfirmed bulk overwrite)
- typed-confirm: type the confirm-string

Examples:

```
agkit agent sync --file agents.json
```

## agent-tool

### agkit agent-tool list

List an agent profile's tools.

- danger: `SR`
- scopes: `agents:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent-tool.list.output.json`
- MCP: `agkit_agent_read`

Examples:

```
agkit agent-tool list --agent support-bot
```

### agkit agent-tool get

Show one of an agent profile's tools.

- danger: `SR`
- scopes: `agents:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent-tool.get.output.json`
- MCP: `agkit_agent_read`

Examples:

```
agkit agent-tool get lookup_order --agent support-bot
```

### agkit agent-tool create

Add a tool to an agent profile (prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent-tool.create.output.json`
- MCP: `agkit_agent_plan`{tool_create}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent-tool create lookup_order --agent support-bot --description "Look up an order" --parameter-schema '{"type":"object","properties":{}}'
```

### agkit agent-tool update

Update a tool's config (tool name is immutable; prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent-tool.update.output.json`
- MCP: `agkit_agent_plan`{tool_update}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent-tool update lookup_order --agent support-bot --description "Look up an order by id"
```

### agkit agent-tool delete

Delete a tool from an agent profile (prod-rebinding).

- danger: `PR`
- scopes: `agents:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/agent-tool.delete.output.json`
- MCP: `agkit_agent_plan`{tool_delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit agent-tool delete lookup_order --agent support-bot
```

## quota

### agkit quota get

Show the project's usage quotas (caps + current usage).

- danger: `SR`
- scopes: `quotas:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/quota.get.output.json`
- MCP: `agkit_quota_read`{kind:agent}

Examples:

```
agkit quota get
```

### agkit quota set

Set usage-quota caps (named members only; the others keep their current values).

- danger: `PR`
- scopes: `quotas:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/quota.set.output.json`
- MCP: `agkit_quota_plan`{set,kind:agent}
- typed-confirm: type the confirm-string

Examples:

```
agkit quota set --max-requests-per-second-per-user 10 --monthly-spend-cap-usd 100.00
```

### agkit quota clear

Clear named quota caps to uncapped (null); other members keep their current values.

- danger: `PR`
- scopes: `quotas:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/quota.clear.output.json`
- MCP: `agkit_quota_plan`{clear,kind:agent}
- typed-confirm: type the confirm-string

Examples:

```
agkit quota clear --fields monthly_token_cap
```

## revenuecat

### agkit revenuecat get

Show the project's RevenueCat binding config (the secret API key is never returned).

- danger: `SR`
- scopes: `revenuecat:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/revenuecat.get.output.json`
- MCP: `agkit_revenuecat_read`

Examples:

```
agkit revenuecat get
```

### agkit revenuecat set

Set or replace the RevenueCat secret API key (validated live; entitlement/claim/TTL config is dashboard-managed at this contract version; prod-rebinding).

- danger: `PR`
- scopes: `revenuecat:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/revenuecat.set.output.json`
- MCP: excluded (secret-bearing direct_confirm ceremony — the key rides env-indirection or a hidden TTY prompt, neither available to an MCP host; returns no Plan)
- typed-confirm: type the project-name

Examples:

```
agkit revenuecat set --api-key-env MY_REVENUECAT_KEY
```

### agkit revenuecat delete

Delete the RevenueCat binding — hard-deletes the row (the dashboard's 'disable' label is a mislabel); end-user entitlement gating stops (destructive, prod-rebinding).

- danger: `PR`
- scopes: `revenuecat:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/revenuecat.delete.output.json`
- MCP: `agkit_revenuecat_plan`{delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit revenuecat delete
```

## kill-switch

### agkit kill-switch status

Show the project's kill-switch state (active, reason, attribution).

- danger: `SR`
- scopes: `killswitch:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/kill-switch.status.output.json`
- MCP: `agkit_killswitch_read`

Examples:

```
agkit kill-switch status
```

### agkit kill-switch activate

ENGAGE the kill switch — halts ALL end-user traffic for this project immediately (requires --reason).

- danger: `D`
- scopes: `killswitch:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/kill-switch.activate.output.json`
- MCP: excluded (incident-response direct_confirm ceremony — typed project-name confirm + mandatory reason; engaging a kill switch stays a human act; returns no Plan)
- typed-confirm: type the project-name

Examples:

```
agkit kill-switch activate --reason "provider incident"
```

### agkit kill-switch deactivate

Disengage the kill switch — resumes end-user traffic (prod-rebinding; prior attribution is preserved).

- danger: `PR`
- scopes: `killswitch:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/kill-switch.deactivate.output.json`
- MCP: `agkit_killswitch_plan`{deactivate}
- typed-confirm: type the confirm-string

Examples:

```
agkit kill-switch deactivate
```

## media-route

### agkit media-route list

List the project's media routes (capability → provider+model bindings).

- danger: `SR`
- scopes: `media-routes:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-route.list.output.json`
- MCP: `agkit_media_route_read`

Examples:

```
agkit media-route list
```

### agkit media-route get

Show one capability's media route.

- danger: `SR`
- scopes: `media-routes:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-route.get.output.json`
- MCP: `agkit_media_route_read`

Examples:

```
agkit media-route get image
```

### agkit media-route set

Bind a capability's media route to a provider + model (prod-rebinding).

- danger: `PR`
- scopes: `media-routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-route.set.output.json`
- MCP: `agkit_media_route_plan`{set}
- typed-confirm: type the confirm-string

Examples:

```
agkit media-route set image --provider example-media --model example-model
```

### agkit media-route enable

Enable a capability's media route (prod-rebinding).

- danger: `PR`
- scopes: `media-routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-route.enable.output.json`
- MCP: `agkit_media_route_plan`{enable}
- typed-confirm: type the confirm-string

Examples:

```
agkit media-route enable image
```

### agkit media-route disable

Disable a capability's media route (the binding is kept; enable restores it).

- danger: `PR`
- scopes: `media-routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-route.disable.output.json`
- MCP: `agkit_media_route_plan`{disable}
- typed-confirm: type the confirm-string

Examples:

```
agkit media-route disable image
```

## voice-identity (alias: voice)

### agkit voice-identity list

List the project's voice identities.

- danger: `SR`
- scopes: `identities:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.list.output.json`
- MCP: `agkit_voice_identity_read`

Examples:

```
agkit voice-identity list
```

### agkit voice-identity get

Show one voice identity (the resource id never appears in any read).

- danger: `SR`
- scopes: `identities:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.get.output.json`
- MCP: `agkit_voice_identity_read`

Examples:

```
agkit voice-identity get narrator
```

### agkit voice-identity set

Bind a voice identity to a provider resource (secret resource id; prod-rebinding).

- danger: `PR`
- scopes: `identities:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.set.output.json`
- MCP: excluded (typed-confirm direct ceremony binding a wire-secret resource id (out-of-band channels only) — returns no Plan)
- typed-confirm: type the key-id

Examples:

```
agkit voice-identity set narrator --provider example-voice --resource-id-env MY_VOICE_RESOURCE_ID
```

### agkit voice-identity enable

Enable a voice identity (re-validates live at the provider; prod-rebinding).

- danger: `PR`
- scopes: `identities:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.enable.output.json`
- MCP: excluded (typed-confirm direct ceremony (enable re-validates live at the provider) — returns no Plan)
- typed-confirm: type the key-id

Examples:

```
agkit voice-identity enable narrator
```

### agkit voice-identity disable

Disable a voice identity (the binding is kept; enable restores it).

- danger: `PR`
- scopes: `identities:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.disable.output.json`
- MCP: excluded (typed-confirm direct ceremony (the toggle path re-validates on enable) — returns no Plan)
- typed-confirm: type the key-id

Examples:

```
agkit voice-identity disable narrator
```

### agkit voice-identity revalidate

Re-check a voice identity against the live provider (records definitive verdicts).

- danger: `M`
- scopes: `identities:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.revalidate.output.json`
- MCP: excluded (direct external revalidation returning a verdict, not a Plan)

Examples:

```
agkit voice-identity revalidate narrator
```

### agkit voice-identity delete

HARD delete a voice identity — a live voice bound to this identity re-binds.

- danger: `PR`
- scopes: `identities:destroy`
- output schema: `https://schemas.agkit.cloud/cli/v1/voice-identity.delete.output.json`
- MCP: `agkit_voice_identity_plan`{delete}
- typed-confirm: type the confirm-string

Examples:

```
agkit voice-identity delete narrator
```

## media-quota

### agkit media-quota get

Show the project's media quotas (absent = not configured).

- danger: `SR`
- scopes: `quotas:read`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-quota.get.output.json`
- MCP: `agkit_quota_read`{kind:media}

Examples:

```
agkit media-quota get
```

### agkit media-quota set

Set ALL six media caps (each an explicit value or `unlimited`; prod-rebinding).

- danger: `PR`
- scopes: `quotas:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-quota.set.output.json`
- MCP: `agkit_quota_plan`{set,kind:media}
- typed-confirm: type the confirm-string

Examples:

```
agkit media-quota set --max-image-generations-per-day 1000 --max-audio-seconds-per-day 36000 --max-video-generations-per-day unlimited --max-dubbing-jobs-per-day 50 --monthly-media-budget-usd 500.00 --media-budget-alert-threshold-usd 400.00
```

### agkit media-quota clear

Clear named media caps to unlimited (other caps carried forward unchanged).

- danger: `PR`
- scopes: `quotas:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/media-quota.clear.output.json`
- MCP: `agkit_quota_plan`{clear,kind:media}
- typed-confirm: type the confirm-string

Examples:

```
agkit media-quota clear --max-video-generations-per-day
```

## mcp

### agkit mcp serve

Run the agkit MCP server on stdio (stdout carries protocol frames only).

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/mcp.serve.output.json`
- MCP: excluded (self-hosting paradox — the MCP server cannot be an MCP tool)

Examples:

```
agkit mcp serve
```

### agkit mcp doctor

Diagnose the MCP integration: client registration, credential, server, contract version.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/mcp.doctor.output.json`
- MCP: excluded (the MCP integration's own oracle: a diagnostic reachable as a tool of the server it diagnoses cannot report that server failing to start, and every verdict it returns over that transport is self-confirming — run it from the shell, never as an agent tool)

Examples:

```
agkit mcp doctor
agkit mcp doctor --offline
```

### agkit mcp print-config

Print the MCP client registration snippets for this machine (absolute binary path baked in); add --json to pipe them.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/mcp.print-config.output.json`
- MCP: excluded (cross-cutting local command: prints THIS server's own client-registration snippets, baking the absolute path of the binary the host already spawned — circular over MCP, and a machine-layout fact a tool has no reason to hand back; not a management resource tool)

Examples:

```
agkit mcp print-config
```

## selftest

### agkit selftest

Run end-to-end diagnostics (runtime, keychain, server, read/write path, skill & MCP).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/selftest.run.output.json`
- MCP: excluded (diagnostic aggregate performing a live write probe; not a resource tool)

Examples:

```
agkit selftest
```

## upgrade

### agkit upgrade

Update agkit to the latest release (npm-global installs only; others print the command).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/upgrade.run.output.json`
- MCP: excluded (mutates the local install; never an agent tool)

Examples:

```
agkit upgrade
```

## dashboard

### agkit dashboard

Open the management dashboard (optionally a page) in your browser.

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/dashboard.open.output.json`
- MCP: excluded (opens a local browser — human surface)

Examples:

```
agkit dashboard
agkit dashboard account/security
```

## api

### agkit api get (aliases: GET)

Send a raw GET to a management path (escape hatch; query rides inline in <path>).

- danger: `SR`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/api.get.output.json`
- MCP: excluded (raw wire escape hatch — MCP agents get typed, scope-audited tools; a raw HTTP door would bypass tool-level labeling)

Examples:

```
agkit api get /v1/management/audit?limit=50
```

### agkit api post (aliases: POST)

Send a raw POST to a management path (body via --input; M-class confirm).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/api.post.output.json`
- MCP: excluded (raw wire escape hatch — returns no Plan; typed MCP tools own the agent surface)

Examples:

```
agkit api post /v1/management/projects --input ./body.json
```

### agkit api put (aliases: PUT)

Send a raw PUT to a management path (body via --input; M-class confirm).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/api.put.output.json`
- MCP: excluded (raw wire escape hatch — returns no Plan; typed MCP tools own the agent surface)

Examples:

```
agkit api put /v1/management/projects/example-id --input ./body.json
```

### agkit api patch (aliases: PATCH)

Send a raw PATCH to a management path (body via --input; M-class confirm).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/api.patch.output.json`
- MCP: excluded (raw wire escape hatch — returns no Plan; typed MCP tools own the agent surface)

Examples:

```
agkit api patch /v1/management/projects/example-id --input ./body.json
```

### agkit api delete (aliases: DELETE)

Send a raw DELETE to a management path (M-class confirm).

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/api.delete.output.json`
- MCP: excluded (raw wire escape hatch — returns no Plan; typed MCP tools own the agent surface)

Examples:

```
agkit api delete /v1/management/projects/example-id
```

## init

### agkit init

Set up a project end to end: project, publishable key, provider credential, default routes, repo files.

- danger: `M`
- scopes: `projects:write`, `keys:write`, `provider-keys:write`, `routes:write`
- output schema: `https://schemas.agkit.cloud/cli/v1/init.run.output.json`
- MCP: excluded (interactive onboarding orchestrator: it prompts, writes repo files, and discloses a shown-once key)

Examples:

```
agkit init
agkit init --project-name my-app --key-name my-app
```

## setup

### agkit setup

Provision this machine for agents: install the agkit skill, register the MCP server, and add the agkit block to AGENTS.md.

- danger: `M`
- scopes: _(none)_
- output schema: `https://schemas.agkit.cloud/cli/v1/setup.run.output.json`
- MCP: excluded (local environment provisioning: writes ~/.claude/skills, the project's AGENTS.md and ~/.codex/config.toml — an MCP host must never rewrite its own client wiring; not an MCP tool)

Examples:

```
agkit setup
agkit setup --check
agkit setup --client codex
```
