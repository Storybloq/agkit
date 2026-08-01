# agkit — mutation policy (plan / apply / confirm)

This is the single most important safety rule in the skill. Read it before you run
any command whose danger class is not `SR` (safe read).

## Danger classes

Every command in `reference.md` declares a `danger` badge:

- `SR` — safe read. No mutation. Free to run.
- `M`  — mutating (creates/updates local or server state).
- `D`  — **destructive** (e.g. `agkit project archive` — bricks a project's apps).
- `PR` — **prod-rebinding** (e.g. `agkit issuer create` — changes what prod trusts).

## THE RULE (do not violate)

An agent **MUST NOT** pass `--yes` on a `D`- or `PR`-class command, and **MUST NOT**
pass `--confirm` at all, **unless the user explicitly instructed that specific
change.** Auto-confirming a destroy or a prod-rebind because it "seemed next" is a
forbidden action. When in doubt, do not confirm — surface the pending change and
ask.

- `--confirm <resource-name>` supplies the typed-confirmation challenge (the target's
  own name) that `D`/`PR` commands require. Providing it IS the act of confirming.
  Only do so when the user named that exact change.
- `--yes` blanket-answers interactive prompts. Never use it to slip past a
  destructive confirmation the user did not authorize.

## `confirmation_required` is NORMAL, not a failure

When you run a `D`/`PR` command non-interactively **without** the confirmation, agkit
returns a structured error:

```
{ "version": <int>, "error": { "code": "confirmation_required", "exit_code": 2,
  "hint": "agkit <command> --confirm <resource-name>", ... } }
```

This is the **expected, correct** shape — the guard working as designed, not a bug to
route around. The right response is to report the pending change to the user and wait
for an explicit go-ahead. Only after the user says "yes, archive project X" do you
re-run with `--confirm X`.

`confirmation_required` (exit 2, CLI-local, client-side) is distinct from the wire's
`confirm_required` (the server independently re-checking the confirmation field) —
defence in depth; either way, do not auto-confirm.

## Plan / apply

Mutating management operations are staged as a **plan** and then **applied** (the MCP
projection shows `..._plan{<verb>}` for these). The discipline:

1. **Plan** the change → inspect the returned plan `data` (what will change,
   preconditions, the plan id).
2. Show the user the plan. For `D`/`PR` changes, get explicit authorization.
3. **Apply** the plan by id, supplying `--confirm <name>` only when authorized.

Watch for these wire codes in the `error.code` field and do NOT blindly retry:

- `plan_stale` / `plan_expired` — the world moved under the plan. Re-plan from
  current state; do not force-apply.
- `plan_already_applied` — the change is already done; treat as success, not a retry.
- `confirm_required` — the server rejected a missing/incorrect confirmation.

Retry (with backoff) only the `retry`-classed wire codes (`rate_limited`,
`idempotency_in_flight`, `internal_error`, `upstream_error`, `service_unavailable`).
Never auto-retry a `none`-class terminal error.

> The exact `plan`/`apply` command names/flags evolve; discover the currently-
> available surface with `agkit --help` and `reference.md`. The **policy** above
> (never auto-confirm a destroy/prod-rebind) holds regardless of surface.
