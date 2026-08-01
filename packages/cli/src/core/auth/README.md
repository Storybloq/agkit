# `core/auth` — the agkit credential chain (T-206 / canonical L2-CLI-05)

Token custody for the `agkit` management-plane CLI. Anchor **A5** (a missing
keychain fails **LOUD**, never a silent plaintext fallback) and **§B-9** (never
silently downgrade).

## Precedence (N-011 §APX-E.4 — keychain-first, the ratified order)

```
AGKIT_TOKEN  >  OS keychain (or the insecure file when present — it OCCUPIES the
                keychain slot)  >  credential-helper  >  LOUD keychain_unavailable
```

- **`AGKIT_TOKEN`** short-circuits the ENTIRE chain: when set (non-empty), NO
  keychain access is attempted at all. This is the CI path.
- **OS keychain** via `@napi-rs/keyring`, service `agkit-cli`, account = profile
  (`AGKIT_PROFILE`, default `default`).
- **Insecure file** `~/.agentkit/credentials.json` (profile-keyed JSON of the E.4
  record, mode `0600`) — the explicit `--insecure-storage` opt-in. When present it
  occupies the keychain slot on reads.
- **Credential-helper** — `AGKIT_CREDENTIAL_HELPER` names an executable; its
  **stdout is one bare token** (trailing whitespace stripped, NEVER logged); 10s
  timeout with a slow-warning at 5s; non-zero exit / timeout ⇒ no credential.
- **Terminal** — a keychain that is *unavailable* (no secret-service backend) with
  no lower-precedence fallback throws `keychain_unavailable` naming two remedies:
  (a) set `AGKIT_TOKEN`, (b) explicit `--insecure-storage`. A keychain that is
  *healthy but empty* is honestly `none` ("not logged in"), not loud.

## Three CLI-local error codes (all exit 2, routed through the T-205 serializer)

| code | when |
|---|---|
| `keychain_unavailable` | no secret-service backend AND no sanctioned fallback |
| `insecure_storage_refused` | PL-14 CI/non-interactive double-opt-in not satisfied |
| `insecure_file_permissions` | the 0600 file widened / a symlink / not a regular file |

These are **placeholder** codes (mirroring T-205's `unknown_field`, with a
`// TODO(L2-CLI-04)` marker) — not a minted global taxonomy. L2-CLI-04 / T-207
own the teachable-error renderer + the real taxonomy.

## PL-14 — the `--insecure-storage` double-opt-in

- Under **CI (`CI` truthy) or non-interactive (`!isTTY`)** an insecure WRITE is
  refused UNLESS `AGKIT_ALLOW_INSECURE_STORAGE=1` is ALSO set. Re-checked on EVERY
  write (the gate is writes-only).
- The file is created `0600` (from creation, via `O_CREAT|O_EXCL|O_NOFOLLOW`, then
  an atomic rename) and its permissions are verified on EVERY read (via
  `O_RDONLY|O_NOFOLLOW` + `fstat` on that fd — no TOCTOU, no symlink follow). A
  widened mode (e.g. `0644`) is rejected with `insecure_file_permissions`.
- READS activate whenever the file exists — no flag — with the 0600 check + a
  **persistent stderr warning** on every read. `whoami` also surfaces
  `insecure_storage: true` in `--json`.

## PL-19 — cross-platform matrix (expected behavior)

The keychain is behind the injectable `KeyringPort` seam, so every path is unit-
tested on ONE machine by making the fake port throw `KeyringUnavailableError` to
simulate a missing secret-service. Expected behavior per platform:

| platform | keychain backend | expected |
|---|---|---|
| **macOS** | Keychain Services | keychain get/set works; `source: keychain` |
| **Ubuntu + libsecret** | Secret Service (gnome-keyring/KWallet) | keychain get/set works; `source: keychain` |
| **headless Linux, NO secret-service** | absent | keychain get/set throw ⇒ terminal `keychain_unavailable` with the TWO remedies — **NOT a crash** |
| any, `AGKIT_TOKEN` set | — | short-circuit; `source: env`; keychain never touched |
| any, `--insecure-storage` + CI double-opt-in | — | `0600` file; `source: insecure_file` + persistent warning |

The simulated no-secret-service path (`chain.test.ts`,
`keychain UNAVAILABLE, no fallback => LOUD`) is the unit-level stand-in for the
headless-Linux row. Wiring an ACTUAL macOS/Ubuntu/headless CI job matrix that
installs, packs, and loads the native `.node` addon is a packaging follow-up
(these unit tests exercise behavior, not native packaging across OSes).

## Purity / seams

Handlers stay pure: they READ `ctx.credential` (source + token + `insecure`). All
I/O (env, home dir, keychain, subprocess, stderr) is injected via `CredentialDeps`
and resolved by the shell (`run.ts`), only for commands that consume a credential
(`build-cli` `commandConsumesCredential`) — so `version` triggers no keychain
access. Secrets NEVER enter via argv: the only ingress paths are `AGKIT_TOKEN`,
the keychain, the `--insecure-storage` file, a TTY prompt (future), and the
credential-helper script.
