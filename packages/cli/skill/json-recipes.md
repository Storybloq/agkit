# agkit — JSON discipline & recipes

You are an agent. Treat `agkit` as a JSON API, never as a text UI. Every rule below
keys on **structured `--json` envelope fields**. Never parse the human-mode output
(the aligned `key: value` tables printed on a TTY) — that layout is for people and
is not a contract. If you find yourself reaching for `grep`/`awk`/`sed`/`cut` on
agkit output, stop and add `--json` (or `--jq`) instead.

## The envelope

Every `--json` invocation prints ONE JSON document to **stdout**:

- Success: `{ "version": <int>, "data": <payload> }`
- Error: `{ "version": <int>, "error": { "code": <string>, "message": <string>,
  "title": <string>, "hint": <string>, "exit_code": <int>, ... } }`

Branch on the presence of `data` vs `error`. Never branch on the human text.
`error.code` is the machine key (see `error-codes` in SKILL.md); `error.hint` is an
exact, copy-pasteable recovery command; `error.exit_code` equals the process exit
code (single source — no skew).

The process **exit code** is the fast, envelope-free signal — branch on it first
(see the exit-code contract in SKILL.md): `0` ok, `1` retryable, `2` terminal,
`3` partial, `130` interrupted.

## Rules

1. **Always `--json`.** Add it to every programmatic call. Output bytes are then
   identical whether or not a TTY is attached (no color, no table reflow).
2. **Parse the envelope, not prose.** Read `data.<field>` / `error.code`. Do not
   match on titles, labels, or table headers.
3. **`--compact` in tight loops.** `--json --compact` strips insignificant
   whitespace (smaller, one line) — use it when you fan out many calls.
4. **Project fields you need.** `--json <field>[,<field>...]` selects members of
   `data` (per item for lists), e.g. `agkit project list --json id,name`. An
   unknown field is a structured `unknown_field` error (exit 2) whose
   `error.available_fields` lists the valid ones — read that, don't guess.
5. **`--jq <expr>` for transforms.** A jq engine ships in the binary (no system jq
   needed): `agkit project list --json --jq '.data[].id'`. Prefer this over piping
   to an external tool, so you stay inside the structured contract.

## Reading one value

```
# authenticated? -> a boolean, from the envelope, never from a printed line
agkit status --json --jq '.data.authenticated'
```

## Pagination recipe

List commands cap page size with `--limit` (e.g. `agkit project list --limit 50`).
When a result is paginated, the **envelope carries the continuation cursor in
`meta`** (never in the human table). The loop:

1. Call the list command with `--json` (and `--limit`).
2. Consume `data` (the page of items).
3. Read the continuation cursor from the envelope `meta` (its exact key is shown by
   `agkit <noun> list --help` / `reference.md`). If absent/empty, stop.
4. Re-invoke the same command passing that cursor back through its cursor flag.
   Repeat until no cursor remains.

Never infer "there are more pages" from output length or a human "…more" hint —
only the structured cursor is authoritative.

## Errors are data

A non-zero exit is normal control flow, not a crash. Read `error.code`, apply the
recovery in `error-codes` (SKILL.md), and retry only the `retry`-classed wire codes
with backoff. `confirmation_required` on a non-TTY is the **normal** shape for a
destructive command you have not been told to confirm — not a failure (see
`plan-apply.md`).
