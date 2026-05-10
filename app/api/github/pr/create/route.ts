/**
 * POST /api/github/pr/create
 *
 * Body:
 *   {
 *     projectPath: string
 *     baseBranch:  string
 *     title:       string
 *     body:        string
 *     draft?:      boolean             // default false
 *     runPolicyGate?: boolean          // default true
 *     enableAutoMergeIfAllowed?: boolean
 *     mergeMethod?: "squash" | "merge" | "rebase"   // default squash
 *   }
 *
 * Behaviour (all checks short-circuit on failure with structured errors):
 *
 *   1. Resolve + authorise projectPath. Confirm git repo.
 *   2. Detect HEAD branch. Refuse if it's main/master — PRs must come
 *      from a feature branch.
 *   3. Confirm gh is installed and a user is logged in.
 *   4. Read origin URL, parse owner/repo, refuse non-GitHub remotes.
 *   5. Verify the authenticated account has push permission via
 *      `gh api repos/<owner>/<repo>`.
 *   6. If `runPolicyGate`: scan the project, load
 *      `.edgeagent/policy.yaml`, evaluate. If decision is `block`,
 *      stop here with a structured error. If `warn`, force `--draft`.
 *   7. `git push -u origin <currentBranch>`. (Without push the PR
 *      cannot be opened — but we keep it last so we never push when
 *      the policy already said no.)
 *   8. `gh pr create --repo <owner>/<repo> --base <base> --head <head>
 *                    --title <title> --body <body> [--draft]`.
 *   9. If `enableAutoMergeIfAllowed && decision === auto_merge_allowed`,
 *      call `gh pr merge <url> --auto --squash` (or selected method).
 *  10. Return PR URL + everything we learned along the way so the UI
 *      can show "PR opened, auto-merge enabled" or "policy blocked,
 *      no push, no PR" without a second round-trip.
 *
 * No shell strings — every gh/git invocation goes through spawnSync
 * with an args array. We never store passwords or PATs.
 */

import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
  validateRef,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  resolvePrAction,
  type Policy,
  type PolicyEvaluation,
} from "@/lib/policy"
import {
  loadComparisonBaseline,
  loadPolicyFor,
  writeLastScan,
} from "@/lib/server-policy"
import type { ScanReport } from "@/lib/scan-report"
import {
  checkGitHubStatus,
  createPullRequest,
  enableAutoMerge,
  fetchRepoPermissions,
  isGitHubPermissionError,
  readGitHubRemote,
} from "@/lib/server-github"
import { getStoredAuth, gitHubAuthArgs } from "@/lib/server-github-auth"

function detectCurrentBranch(cwd: string): string | null {
  const r = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (r.status !== 0) return null
  const b = r.stdout.trim()
  if (!b || b === "HEAD") return null
  return b
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      baseBranch?: string
      /**
       * Optional override for the head/source branch. When omitted we
       * fall back to the project's checked-out HEAD. Letting the
       * client name this lets users open a PR for, say, a local
       * `feat/x` branch even while their working tree is on `main` —
       * a common workflow when they're using the app to compare
       * branches without switching their editor's checkout.
       */
      headBranch?: string
      title?: string
      body?: string
      draft?: boolean
      runPolicyGate?: boolean
      enableAutoMergeIfAllowed?: boolean
      mergeMethod?: "squash" | "merge" | "rebase"
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const baseBranch = validateRef(body.baseBranch, "baseBranch")
    const title = (body.title ?? "").trim()
    const prBody = (body.body ?? "").trim()
    if (!title) {
      return NextResponse.json(
        { ok: false, reason: "validation", message: "PR title is required." },
        { status: 400 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 2: Resolve the head branch.
     *   - If the client supplied one, validate it through validateRef
     *     (rejects shell-metacharacters, leading dashes, etc.) and use
     *     that. The push step below will fail loudly if the branch
     *     doesn't exist locally — gh pr create needs the branch to be
     *     on origin, which is exactly what `git push -u origin <head>`
     *     guarantees.
     *   - Otherwise fall back to the project's checked-out HEAD.
     * Either way the head branch must not be main/master.
     * ----------------------------------------------------------------- */
    const head = body.headBranch
      ? validateRef(body.headBranch, "headBranch")
      : detectCurrentBranch(resolved)
    if (!head) {
      return NextResponse.json(
        {
          ok: false,
          reason: "no_branch",
          message:
            "Could not detect current branch (HEAD is detached?). Check out a feature branch first.",
        },
        { status: 400 }
      )
    }
    const headLower = head.toLowerCase()
    if (headLower === "main" || headLower === "master") {
      return NextResponse.json(
        {
          ok: false,
          reason: "on_default_branch",
          message: `Create a feature branch before opening a pull request (currently on '${head}').`,
        },
        { status: 400 }
      )
    }
    // The PR must compare two distinct refs.
    if (head === baseBranch) {
      return NextResponse.json(
        {
          ok: false,
          reason: "head_equals_base",
          message: `Head branch '${head}' is the same as base '${baseBranch}'. Pick a different base.`,
        },
        { status: 400 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 3-4: any GitHub auth source available + repo on GitHub.
     *
     * checkGitHubStatus() now reports "authenticated" if EITHER the
     * in-app token (preferred) OR `gh auth status` succeeds. We only
     * hard-block when nothing is configured.
     * ----------------------------------------------------------------- */
    const gh = checkGitHubStatus()
    if (!gh.authenticated) {
      return NextResponse.json(
        {
          ok: false,
          reason: "not_authenticated",
          message:
            "Sign in to GitHub from Settings (or run `gh auth login`) before opening a pull request.",
        },
        { status: 412 }
      )
    }
    const remote = readGitHubRemote(resolved)
    if (!remote) {
      return NextResponse.json(
        {
          ok: false,
          reason: "not_github_remote",
          message:
            "Project's `origin` remote is not a GitHub URL. Cannot open a GitHub pull request.",
        },
        { status: 400 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 5: per-repo permission check (same code path as /api/git/push).
     * ----------------------------------------------------------------- */
    const perm = await fetchRepoPermissions(remote)
    if (perm.resolved && !perm.canPush) {
      return NextResponse.json(
        {
          ok: false,
          reason: "no_push_permission",
          message: `Authenticated GitHub account '${gh.login ?? "?"}' does not have push permission to ${perm.owner}/${perm.repo}. Connect the correct account or ask for repo access.`,
          github: {
            login: gh.login,
            owner: perm.owner,
            repo: perm.repo,
            remoteUrl: perm.remoteUrl,
            protocol: perm.protocol,
            permissions: perm.permissions,
            canPush: false,
          },
        },
        { status: 403 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 6: policy gate (scan + evaluate).
     *
     * The gate runs whenever the request asks for it (default true) OR
     * the project's policy is in block mode. The latter override is
     * load-bearing — it's what guarantees a stale `runPolicyGate:
     * false` in any client code can't bypass an enforcing policy.
     * Policy file is authoritative.
     * ----------------------------------------------------------------- */
    const policyForGateDecision = loadPolicyFor(resolved)
    const policyEnforces = policyForGateDecision.policy.mode === "block"
    const requestedGate = body.runPolicyGate !== false
    const runPolicyGate = policyEnforces || requestedGate
    const gateForcedByPolicy = policyEnforces && !requestedGate
    let scan: Awaited<ReturnType<typeof runScannerOn>> | null = null
    let evaluation: PolicyEvaluation | null = null
    let policyMeta:
      | { policy: Policy; policySource: "file" | "default"; policyErrors: string[] }
      | null = null
    let baseMeta:
      | {
          baseSource: "base_branch" | "snapshot" | "none"
          baseBranch: string | null
          baseSha: string | null
          gateForcedByPolicy: boolean
        }
      | null = null
    let prAction = resolvePrAction(DEFAULT_POLICY, "pass")
    let forcedDraft = false
    if (runPolicyGate) {
      try {
        scan = await runScannerOn(resolved)
      } catch (e) {
        const err = e as ScannerError
        return NextResponse.json(
          {
            ok: false,
            reason: "scan_failed",
            message: "Pre-PR scan failed.",
            stderr: err.stderr,
          },
          { status: 500 }
        )
      }
      // Compare the head branch against the configured base branch
      // (the PR's `base`, or `policy.pull_request.base_branch`,
      // defaulting to "main"). This is the same comparison Branch
      // Compare does — without it, delta rules fall through as
      // "inapplicable" and a regression like "+13 risk, +3 high"
      // gets `decision: "pass"`. The per-branch last-scan snapshot
      // is the fallback when we're already on the base branch or
      // the base scan can't be produced.
      const loaded = policyForGateDecision
      const baseline = await loadComparisonBaseline(resolved, {
        // Honour the PR's selected base over policy.pull_request.base_branch.
        // Constructed via spread to avoid mutating the loaded policy object.
        policy: { ...loaded.policy, pull_request: {
          ...loaded.policy.pull_request,
          base_branch: baseBranch,
        } },
        currentBranch: head,
      })
      policyMeta = loaded
      baseMeta = {
        baseSource: baseline.baseSource,
        baseBranch: baseline.baseBranchScan.branch,
        baseSha: baseline.baseBranchScan.sha,
        gateForcedByPolicy,
      }
      evaluation = evaluatePolicy({
        baseReport: baseline.baseReport ?? null,
        targetReport: {
          risk_score: scan.risk_score,
          summary: scan.summary,
        } as unknown as ScanReport,
        policy: loaded.policy,
        context: { branch: head },
      })
      prAction = resolvePrAction(loaded.policy, evaluation.decision, {
        userWantsAutoMerge: !!body.enableAutoMergeIfAllowed,
      })

      if (prAction.kind === "block") {
        return NextResponse.json(
          {
            ok: false,
            created: false,
            blocked: true,
            reason: "policy_block",
            decision: evaluation.decision,
            message: `Pull request was not created because policy gate failed: ${prAction.reason}`,
            policy: loaded.policy,
            policySource: loaded.policySource,
            policyErrors: loaded.policyErrors,
            baseSource: baseMeta?.baseSource,
            baseBranch: baseMeta?.baseBranch,
            baseSha: baseMeta?.baseSha,
            gateForcedByPolicy: baseMeta?.gateForcedByPolicy,
            evaluation,
            report: { risk_score: scan.risk_score, summary: scan.summary },
            prAction,
          },
          { status: 409 }
        )
      }
      if (prAction.kind === "draft") {
        forcedDraft = true
      }
    }

    const wantDraft = !!body.draft || forcedDraft

    /* ------------------------------------------------------------------
     * Step 7: push the branch. `-u` makes the local branch track
     * origin afterwards.
     *
     * When the user signed in inside the app we inject the token via
     * `gitHubAuthArgs(token)` which sets HTTP Basic auth (the scheme
     * the git/HTTPS server actually accepts) and clears competing
     * credential helpers so cached accounts can't shadow our header.
     *
     * When no token is stored we leave the env alone and let git's
     * existing credential helper (gh, osxkeychain, ssh-key, etc.)
     * handle the push transparently.
     * ----------------------------------------------------------------- */
    const stored = getStoredAuth()
    const pushArgs = [
      ...gitHubAuthArgs(stored?.token),
      "push",
      "-u",
      "origin",
      head,
    ]
    const push = runGit(resolved, pushArgs, { timeoutMs: 90_000 })
    if (push.status !== 0) {
      const isPermErr = isGitHubPermissionError(push.stderr)
      return NextResponse.json(
        {
          ok: false,
          reason: isPermErr ? "permission_denied" : "push_failed",
          message: isPermErr
            ? "GitHub rejected the push because the authenticated account does not have permission for this repository. Your Git may be using cached credentials from another account."
            : "git push failed",
          stderr: push.stderr.slice(0, 4000),
          stdout: push.stdout.slice(0, 2000),
        },
        { status: isPermErr ? 403 : 502 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 8: open the PR. createPullRequest prefers the in-app token
     * (REST POST /repos/:owner/:repo/pulls) and falls back to
     * `gh pr create` only when no token is stored.
     * ----------------------------------------------------------------- */
    const created = await createPullRequest({
      cwd: resolved,
      owner: remote.owner,
      repo: remote.repo,
      base: baseBranch,
      head,
      title,
      body: prBody,
      draft: wantDraft,
    })
    if (!created.ok) {
      return NextResponse.json(
        {
          ok: false,
          created: false,
          reason: created.reason,
          message: created.message,
          stderr: created.stderr,
          decision: evaluation?.decision,
          evaluation,
          policy: policyMeta?.policy,
          policySource: policyMeta?.policySource,
          policyErrors: policyMeta?.policyErrors,
          baseSource: baseMeta?.baseSource,
          baseBranch: baseMeta?.baseBranch,
          baseSha: baseMeta?.baseSha,
          gateForcedByPolicy: baseMeta?.gateForcedByPolicy,
          report: scan
            ? { risk_score: scan.risk_score, summary: scan.summary }
            : null,
        },
        { status: 502 }
      )
    }

    /* ------------------------------------------------------------------
     * Step 9: optional auto-merge.
     * ----------------------------------------------------------------- */
    let autoMerge:
      | { enabled: true }
      | { enabled: false; reason: string; message?: string }
      | null = null
    if (prAction.kind === "auto_merge") {
      const am = enableAutoMerge({
        cwd: resolved,
        prUrl: created.url,
        method: body.mergeMethod ?? "squash",
      })
      autoMerge = am.ok
        ? { enabled: true }
        : { enabled: false, reason: am.reason, message: am.message }
    }

    // PR was opened — bake this state into the snapshot so the next
    // commit/push/PR can detect a regression vs the state we just
    // shipped. We persist after the PR is opened (not just after the
    // push) so a push that succeeds but `gh pr create` that errors
    // doesn't lock in a baseline the user never actually approved.
    if (scan) {
      const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
      const shortSha = sha.status === 0 ? sha.stdout.trim() || null : null
      writeLastScan(resolved, {
        risk_score: scan.risk_score,
        summary: { ...scan.summary },
        generated_at: new Date().toISOString(),
        branch: head,
        sha: shortSha,
        source: "pr",
      })
    }

    return NextResponse.json({
      ok: true,
      created: true,
      url: created.url,
      number: created.number,
      head,
      base: baseBranch,
      draft: wantDraft,
      decision: evaluation?.decision ?? "pass",
      prAction,
      autoMerge,
      report: scan
        ? { risk_score: scan.risk_score, summary: scan.summary }
        : null,
      policy: policyMeta?.policy,
      policySource: policyMeta?.policySource,
      policyErrors: policyMeta?.policyErrors,
      baseSource: baseMeta?.baseSource,
      baseBranch: baseMeta?.baseBranch,
      baseSha: baseMeta?.baseSha,
      gateForcedByPolicy: baseMeta?.gateForcedByPolicy,
      evaluation,
      github: {
        login: gh.login,
        owner: remote.owner,
        repo: remote.repo,
        remoteUrl: remote.remoteUrl,
        protocol: remote.protocol,
      },
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { ok: false, reason: "git_error", message: err.message, stderr: err.stderr || undefined },
        { status: err.status }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        reason: "unknown",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
