# EventDiff

Prevent breaking analytics/event schema changes before they hit production.

EventDiff is a lightweight “schema governance” gate for pull requests:

- Schemas are stored in Git (JSON Schema files).
- A CLI diffs schemas between a PR’s **base** and **head** commits.
- A GitHub Action runs on PRs and blocks **breaking** changes.
- Risky-but-possibly-acceptable changes surface as **WARN** (so reviewers see them immediately).

This repo is designed as a demo artifact for Data / Platform PM interviews (inspired by Spotify’s Data Collection Platform patterns).

---

## Repo structure

```
schemas/
  checkout_completed.json
cli/
  eventdiff.mjs
  package.json
.github/workflows/
  eventdiff.yml
eventdiff.config.json
owners.json
```

---

## How it works

### 1) Schema diff (base vs head)

EventDiff compares the JSON Schema file(s) in `schemas/` between two Git refs:

- `--base=<sha>`: base commit (typically PR base)
- `--head=<sha>`: head commit (typically PR head)
- `--dir=<path>`: schema directory (defaults to `schemas`)

The CLI prints a human-readable CI header:

- `EventDiff: PASS/WARN/FAIL | blocks=X warns=Y passes=Z`
- `Owner: <team(s)>`
- `ACTION: <routing hint>`
- Then `BLOCK:` / `WARN:` lines (if any)
- Then a full JSON report

Exit codes:

- `0` = safe / no blocking changes
- `1` = at least one blocking change (CI should fail)

### 2) Rules + severities (policy)

Rules are evaluated on flattened field paths (e.g. `total_amount`, `customer.id`).

Severities are configurable via `eventdiff.config.json`:

- `block`: fail the run (exit code 1)
- `warn`: allow but flag loudly
- `pass`: informational / safe

If `eventdiff.config.json` is missing, defaults are used.

### 3) Ownership + routing

`owners.json` maps an event name to owning team(s). Event name is the schema filename without `.json`.

Example:

```json
{
  "checkout_completed": ["team-payments-platform"]
}
```

In CI, EventDiff prints:

- `Owner: team-payments-platform`
- `ACTION: Request review from owner team(s) above`

(Next step / roadmap: auto-tag owners as reviewers or comment on the PR.)

---

## Running locally

From repo root:

```bash
# No change (PASS, empty diff)
node cli/eventdiff.mjs --base=HEAD --head=HEAD --dir=schemas

# Compare two commits
node cli/eventdiff.mjs --base=<base_sha> --head=<head_sha> --dir=schemas
```

Tip: EventDiff reads files via `git show <ref>:<path>`, so you must commit your schema edits (or amend) before diffing refs.

---

## CI integration (GitHub Actions)

Workflow: `.github/workflows/eventdiff.yml`

Key detail: the workflow runs from `cli/`, so the schema directory is `../schemas`.

Expected command:

```bash
node eventdiff.mjs \
  --base=${{ github.event.pull_request.base.sha }} \
  --head=${{ github.event.pull_request.head.sha }} \
  --dir=../schemas
```

Notes:

- PR checks use the workflow from the **base branch**. Keep `main` correct to make demos consistent.
- If the CLI exits `1`, the PR check fails and the merge is blocked (depending on branch protection rules).

---

## Demo scenarios (PASS / WARN / FAIL)

These are the three end-to-end PR demos used for interviews.

### FAIL: breaking type change (BLOCK)

Change:

- `total_amount`: `number` → `string`

Expected CI line:

- `BLOCK: TYPE_CHANGED - Type changed 'total_amount': number → string`

### WARN: required becomes optional (WARN)

Change:

- Remove `payment_method` from `required`, but keep the field in `properties`.

Expected CI line:

- `WARN: REQUIRED_CHANGED - Required → optional: 'payment_method'.`

### PASS: add a new optional field (PASS)

Change:

- Add a new optional field (e.g. `coupon_code`) in `properties`, not in `required`.

Expected outcome:

- No `BLOCK:` lines
- `warns=0`
- at least one pass

---

## Keeping `main` demo-clean

For predictable demos:

- `main` contains the correct baseline schema and workflow.
- Each demo is a separate branch + PR:
  - `demo/fail-type-change`
  - `demo/warn-required-change`
  - `demo/pass-add-field`

---

## Git remote (repo moved)

If GitHub warns “repository moved”, update your remote:

```bash
git remote set-url origin https://github.com/AjithNeelakantan/eventdiff.git
```

---

## Roadmap

- Ownership + routing: done (owners.json + CI routing hint)
- Policy config: done (eventdiff.config.json)
- Suggested fix guidance per rule: later
- PR comments / auto-request reviewers: later
- More schema rules: later (pattern/min/max/format, etc.)

---

## Contact

Ajith Neelakantan  
Email: ajithsupsc@gmail.com
