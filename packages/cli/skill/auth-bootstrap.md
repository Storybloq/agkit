# agkit — authentication bootstrap ladder

Resolve credentials in this fixed order. Stop at the first rung that applies. The
CLI never stores a token in `config.json` (credentials live only in the OS keychain,
the `AGKIT_TOKEN` env var, or an explicit-opt-in plaintext file) — so there is no
config key to read a token from.

Check where you stand first:

```
agkit status --json --jq '{auth: .data.authenticated, src: .data.credential_source}'
```

`credential_source` is one of `env`, `keychain`, `insecure_file`, `none`.

## The ladder

1. **`AGKIT_TOKEN` is set → use it.** If the env var holds a token, agkit uses it
   directly (source `env`). This is the preferred path for CI and for you, the
   agent: no interactive step, no keychain. A human/operator mints the token; you
   consume it from the environment.

2. **Interactive TTY + a browser available → `agkit login`.** The human-in-the-loop
   browser OAuth flow. Writes the credential to the OS keychain (source `keychain`).
   This is a **human** action — do not attempt it unattended.

3. **Headless (no browser) but interactive → `agkit login --device`.** The device-
   authorization flow: agkit shows a code, the human approves it in a browser
   elsewhere. Still a human action.

4. **CI / fully non-interactive → a human mints a scoped token out of band.**
   An operator runs `agkit token create --scope <scope> --expires-in <duration>`
   once, stores the result as a secret, and exposes it to the job as `AGKIT_TOKEN`
   (rung 1). You never run `token create` on the user's behalf unless explicitly
   instructed — it is a credential-minting, secret-bearing action.

> `login` and `token` are the **documented** bootstrap surface. Some rungs may not
> be available in every build yet — do not invent flags beyond those named here.
> Discover the exact, currently-available auth commands with `agkit --help` and
> `reference.md`. If a rung's command is unavailable, fall back up the ladder to
> `AGKIT_TOKEN`.

## Failure recovery (structured codes)

Read `error.code` from the `--json` envelope:

- `not_logged_in` — no resolvable credential for an authenticated op. Recovery:
  set `AGKIT_TOKEN`, or have the human run `agkit login`. (`error.hint` names it.)
- `keychain_unavailable` — no OS secret-service backend. Prefer `AGKIT_TOKEN`; the
  loud plaintext alternative is `agkit login --insecure-storage` (a human choice).
- `insecure_storage_refused` — under CI, plaintext storage needs a **double**
  opt-in: `AGKIT_ALLOW_INSECURE_STORAGE=1` alongside `--insecure-storage`. Prefer
  `AGKIT_TOKEN` instead of storing plaintext at all.
- `insecure_file_permissions` — the plaintext credentials file is group/other
  readable. `error.hint` gives the exact `chmod 600 …` fix.
- `version_skew` — the CLI is older than the server's management API. Recovery:
  `npm install -g @storybloq/agkit@latest`.

Never downgrade the auth tier silently: if the intended rung is unavailable, surface
it (or its structured error) — do not fall back to plaintext without an explicit
instruction.
