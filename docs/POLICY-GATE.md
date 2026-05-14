# GitHub Actions — Edge Agent AI Policy Gate

The CI gate runs the **same scanner and policy evaluator** that the desktop app uses, so the verdict you see in the IDE is the verdict you'll see on the pull request — no drift, no surprises at merge time.

This page is the setup checklist.

---

## What you get out of the box

A workflow at `.github/workflows/edge-agent-policy.yml` that, on every PR (and every push to `main` / `master` / `develop`):

1. Installs the Python scanner from `scanner/` and the Node deps.
2. Scans the **target** (the PR head).
3. Scans the **base** (the PR base branch) in a throwaway worktree, so delta rules like `block_if_high_increased` and `require_risk_score_not_increase` actually have a baseline to compare against.
4. Loads `.edgeagent/policy.yaml` (or the safe default).
5. Calls the very same `evaluatePolicy()` the desktop app uses.
6. Writes a Markdown summary into the job's **Step Summary** (the green panel at the bottom of the run page).
7. Uploads `policy-report.md`, `policy-result.json`, and the raw target / base scan JSON as a workflow artifact (`edge-agent-policy-report`).
8. Posts a sticky comment with the full report on the PR.
9. **Fails the check** when `policy.mode: block` and the decision is BLOCK. `warn` mode never fails — it just annotates.

The CLI lives at `scripts/policy-gate.ts` and is callable locally too:

```bash
pnpm policy-gate --target HEAD --base origin/main
```

---

## One-time setup on the GitHub side

These are the bits you need to do — the code is already in the repo.

### 1. Push the workflow file

The workflow is committed at `.github/workflows/edge-agent-policy.yml`. Push it to any branch — GitHub picks it up automatically the next time a PR is opened against `main`, `master`, or `develop`.

### 2. (Recommended) Make the gate a **required status check**

This is the step that actually prevents merging a BLOCK'd PR.

1. Open the repo on GitHub → **Settings → Branches**.
2. Add a branch protection rule for `main` (and any other long-lived branches).
3. Under **Require status checks to pass before merging**:
   - Tick **Require status checks to pass before merging**.
   - Search for `Run policy gate` (the `name:` of the job in the workflow) and select it.
   - Tick **Require branches to be up to date before merging** if you want strict linear history.
4. Save.

After the first PR run, the check name should appear in the search box. If it doesn't, push one commit to any open PR to trigger the workflow once, then come back to the settings page.

### 3. (Optional) PR comments

The workflow already grants `pull-requests: write` permission, so the sticky comment works without any further setup. If your org disables that by default:

- **Settings → Actions → General → Workflow permissions** → choose **Read and write permissions**.

If you don't want PR comments at all, just remove this line from `edge-agent-policy.yml`:

```yaml
pull-requests: write
```

The gate still runs and still posts the Step Summary; only the inline PR comment is skipped.

### 4. (Optional) Tune triggers

The default triggers are:

```yaml
on:
  pull_request:
    branches: [main, master, develop]
  push:
    branches: [main, master, develop]
```

Edit the `branches:` lists for your branch naming, or drop `push:` entirely if you only want PR-time gating.

### 5. (Optional) Use it from other repos

If you want to share this gate across multiple repositories without copying the workflow, the composite action at `action.yml` lets a downstream repo do:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: <your-org>/edge-agent-ai@v1
  with:
    policy-file: .edgeagent/policy.yaml
    base-ref: origin/${{ github.base_ref }}
```

Cut a tag (`v1`, `v1.0.0`) on this repo after the action lands, and consume by tag in downstream repos. No publishing to the Marketplace is required for internal use.

---

## What you need to add **per-project**

For each repo that you want gated:

1. **A `.edgeagent/policy.yaml` file** (or accept the defaults — the gate falls back to `DEFAULT_POLICY` from `lib/policy.ts`).
   - Easiest way to author one: open the project in Edge Agent AI → **Settings → Policy Rules** → tweak → **Save Policy**. That writes the file for you.
2. **Both the scanner and the Node deps installable in CI.** The included workflow already does this (`pip install -e ./scanner` and `pnpm install --frozen-lockfile`). Nothing to add unless your project layout is non-standard.
3. **`fetch-depth: 0`** on the checkout step — already set in the included workflow. Without it the base ref is unreachable and all delta rules become inapplicable.

---

## Reading a failed gate

The job's **Step Summary** shows, in this order:

- The verdict (`✅ PASS`, `⚠️ WARN`, or `🛑 BLOCK`) and the policy mode.
- Base vs target SHA / branch.
- Risk + severity deltas (`+13` style cells).
- Every **failed condition** with its stable id (e.g. `security.block_if_critical`) and the human-readable reason.
- Every **passed condition** (for evidence, and for editing the policy with confidence).
- The 10 most severe blocking findings.
- A short list of recommended next actions.

The same Markdown lives in the `edge-agent-policy-report` artifact, plus a machine-readable `policy-result.json` that mirrors `PolicyEvaluation`. The raw `report-target.json` and `report-base.json` are uploaded too, so you can re-run the policy locally without re-scanning:

```bash
# Download the artifact from the run page, then:
pnpm tsx scripts/policy-gate.ts --target HEAD
```

---

## Running locally

The CLI is a normal Node script that imports `lib/policy.ts`, so anything you can do in CI you can do on your laptop.

```bash
# Same scope as a CI run, comparing local HEAD vs origin/main:
pnpm policy-gate --target HEAD --base origin/main

# No base (no delta rules — useful for very first scan on a brand-new repo):
pnpm policy-gate --target HEAD

# Point at another project on disk:
pnpm policy-gate --repo /path/to/some/repo --target HEAD --base origin/main
```

Artifacts land in `<repo>/edge-agent-output/`.

---

## Exit-code contract (so you can wire this into other tools)

| `policy.mode` | `decision` | exit code | check status |
| ---           | ---        | ---:      | ---          |
| `block`       | `pass`     | 0         | ✅ green     |
| `block`       | `warn`     | 0         | ✅ green (annotated) |
| `block`       | `block`    | 1         | ❌ red (PR cannot merge with required check) |
| `warn`        | any        | 0         | ✅ green (Step Summary still shows the issue) |
| `auto_merge`  | any        | 0         | ✅ green (auto-merge happens elsewhere) |

This means **you can ship `warn` mode first** (observation only), watch what trips on real PRs, tune the policy, and then flip to `block` once the team is happy with the rule set.

---

## Troubleshooting

- **"base scan failed — delta rules will be skipped"** in the log → make sure the checkout step has `fetch-depth: 0`. Without it, `origin/<base-branch>` doesn't exist on the runner.
- **`pip install -e ./scanner` fails** → the scanner expects a `pyproject.toml` or `setup.py` in `scanner/`. If you moved the scanner, update the install path in the workflow.
- **Step Summary is empty** → check the `Run policy gate` step's log for `policy-gate crashed`. The most common cause is a malformed `.edgeagent/policy.yaml` — the CLI prints which key fails Zod validation.
- **Sticky comment didn't appear** → confirm `permissions: pull-requests: write` is present in the workflow file and the org-level setting in **Actions → General → Workflow permissions** is at least "Read and write".
