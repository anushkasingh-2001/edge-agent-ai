import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
  validateRef,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"
import { evaluatePolicy, type PolicyEvaluation } from "@/lib/policy"
import {
  loadComparisonBaseline,
  loadPolicyFor,
  writeLastScan,
} from "@/lib/server-policy"
import type { ScanReport } from "@/lib/scan-report"
import { getStoredAuth, gitHubAuthArgs } from "@/lib/server-github-auth"
import {
  checkGitHubStatus,
  fetchRepoPermissions,
  isGitHubPermissionError,
  readGitHubRemote,
  type GitHubRepoPermissionResult,
  type GitHubStatus,
} from "@/lib/server-github"

/**
 * POST /api/git/push
 *
 * Body:
 *   {
 *     projectPath: string
 *     branch: string
 *     runScanBeforePush: boolean
 *     warnOnCriticalFindings: boolean
 *   }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath. Ensure it's a Git repo.
 *   2. Validate `branch`.
 *   3. If `runScanBeforePush`, run the scanner. If
 *      `warnOnCriticalFindings` and the scan reports any critical or
 *      high findings, return 409 with `{ blocked: true, report }` so
 *      the UI can let the user review before retrying.
 *   4. `git push origin <branch>` (no `--force`, no shell).
 *
 * Network credentials come from the user's existing git config; we
 * never prompt (GIT_TERMINAL_PROMPT=0 is set in `runGit`), so missing
 * credentials surface cleanly via stderr instead of hanging.
 */

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      branch?: string
      runScanBeforePush?: boolean
      warnOnCriticalFindings?: boolean
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)
    const branch = validateRef(body.branch, "branch")

    // Load policy first so we can force the scan whenever it's in
    // block mode. Otherwise a stale `runScanBeforePush: false` in
    // the user's localStorage would silently skip the gate and
    // ship a regression. Policy file is authoritative.
    const loaded = loadPolicyFor(resolved)
    const policyEnforces = loaded.policy.mode === "block"
    const requestedScan = !!body.runScanBeforePush
    const runScan = policyEnforces || requestedScan
    const scanForcedByPolicy = policyEnforces && !requestedScan
    const warnOnCritical = !!body.warnOnCriticalFindings

    /* ------------------------------------------------------------------
     * GitHub permission pre-flight.
     *
     * Only enforced when the project's `origin` is on GitHub *and* we
     * could conclusively determine the authenticated account doesn't
     * have push access. We never block based on "couldn't check" —
     * absent/uninstalled gh, missing remote, or 401/404 from the API
     * all fall through to the actual `git push`, which has its own
     * 403 detection below.
     *
     * The real blocker this prevents is the one the user reported: gh
     * auth shows account A, git credential helper has cached account
     * B's token, push gets a 403, and the user wastes time guessing
     * which account is wrong. With this gate they get a clear
     * explanation *before* the push runs.
     * ----------------------------------------------------------------- */
    let ghStatus: GitHubStatus | null = null
    let ghPermission: GitHubRepoPermissionResult | null = null
    const ghRemote = readGitHubRemote(resolved)
    if (ghRemote) {
      ghStatus = checkGitHubStatus()
      if (ghStatus.authenticated) {
        ghPermission = await fetchRepoPermissions(ghRemote)
        if (ghPermission.resolved && !ghPermission.canPush) {
          return NextResponse.json(
            {
              ok: false,
              blocked: true,
              phase: "permission",
              reason: "no_push_permission",
              message: `Authenticated GitHub account '${
                ghStatus.login ?? "?"
              }' does not have push permission to ${ghPermission.owner}/${
                ghPermission.repo
              }. Connect the correct account or ask for repo access.`,
              github: {
                login: ghStatus.login,
                owner: ghPermission.owner,
                repo: ghPermission.repo,
                remoteUrl: ghPermission.remoteUrl,
                protocol: ghPermission.protocol,
                permissions: ghPermission.permissions,
                canPush: false,
              },
            },
            { status: 403 }
          )
        }
      }
    }

    let scan: Awaited<ReturnType<typeof runScannerOn>> | null = null
    let policyEval: PolicyEvaluation | null = null
    let policyMeta:
      | {
          policySource: "file" | "default"
          policyErrors: string[]
          baseSource: "base_branch" | "snapshot" | "none"
          baseBranch: string | null
          baseSha: string | null
          scanForcedByPolicy: boolean
        }
      | null = null
    if (runScan) {
      try {
        scan = await runScannerOn(resolved)
      } catch (e) {
        const err = e as ScannerError
        return NextResponse.json(
          {
            ok: false,
            phase: "scan",
            error: "Pre-push scan failed",
            message: err.message,
            stderr: err.stderr,
          },
          { status: 500 }
        )
      }

      // Compare the working tree against the configured base branch
      // (default "main") — same comparison Branch Compare surfaces
      // visually. Falls back to the per-branch last-scan snapshot
      // when we're already on the base branch or the base scan
      // can't be produced. Without a baseline, delta rules fall
      // through as "inapplicable" and any regression slips past.
      const baseline = await loadComparisonBaseline(resolved, {
        policy: loaded.policy,
        currentBranch: branch,
      })
      policyEval = evaluatePolicy({
        baseReport: baseline.baseReport ?? null,
        targetReport: {
          risk_score: scan.risk_score,
          summary: scan.summary,
        } as unknown as ScanReport,
        policy: loaded.policy,
        context: { branch },
      })
      policyMeta = {
        policySource: loaded.policySource,
        policyErrors: loaded.policyErrors,
        baseSource: baseline.baseSource,
        baseBranch: baseline.baseBranchScan.branch,
        baseSha: baseline.baseBranchScan.sha,
        scanForcedByPolicy,
      }

      const policyBlocks = policyEval.decision === "block"
      const fallbackBlocks =
        loaded.policySource === "default" &&
        warnOnCritical &&
        (scan.summary.critical > 0 || scan.summary.high > 0)
      if (policyBlocks || fallbackBlocks) {
        return NextResponse.json(
          {
            ok: false,
            blocked: true,
            phase: "scan",
            reason: policyBlocks
              ? "policy_block"
              : "critical_or_high_findings",
            message: policyBlocks
              ? `Push blocked by policy: ${
                  policyEval.reasons[0] ?? "see details"
                }`
              : `Push blocked: scanner reports ${scan.summary.critical} critical and ${scan.summary.high} high finding(s).`,
            report: {
              risk_score: scan.risk_score,
              summary: scan.summary,
            },
            policy: loaded.policy,
            policySource: loaded.policySource,
            policyErrors: loaded.policyErrors,
            baseSource: policyMeta?.baseSource,
            baseBranch: policyMeta?.baseBranch,
            baseSha: policyMeta?.baseSha,
            scanForcedByPolicy: policyMeta?.scanForcedByPolicy,
            evaluation: policyEval,
          },
          { status: 409 }
        )
      }
    }

    // Inject the in-app GitHub token via `gitHubAuthArgs` (HTTP Basic
    // with the token as password — the scheme git's HTTPS server
    // actually accepts). The helper also clears competing credential
    // helpers so a stale `gh auth` from a different account can't
    // silently override our header. Falls back to whatever git
    // already has (gh, ssh keys, osxkeychain, etc.) when no token
    // is stored.
    const stored = getStoredAuth()
    const pushArgs = [
      ...gitHubAuthArgs(stored?.token),
      "push",
      "origin",
      branch,
    ]
    const push = runGit(resolved, pushArgs, { timeoutMs: 90_000 })
    if (push.status !== 0) {
      // Detect the canonical "wrong-account / cached-credential" 403 so
      // the UI can render a tailored explanation + suggested fixes
      // instead of dumping the raw stderr.
      const isPermErr = isGitHubPermissionError(push.stderr)
      if (isPermErr) {
        const suggestions = [
          "Run `gh auth login` and choose the account that has access to this repo.",
          "Run `gh auth status` to confirm which account git/gh is using.",
          ghPermission?.protocol === "https"
            ? "If you authenticated with the correct account but the push still fails, your Git credential helper may have cached an older token. Clear it (macOS: `printf 'host=github.com\\nprotocol=https\\n' | git credential-osxkeychain erase`) and try again."
            : "Verify your SSH key is loaded: `ssh -T git@github.com`.",
          ghRemote?.protocol === "https"
            ? `Or switch the remote to SSH: \`git remote set-url origin git@github.com:${ghRemote.owner}/${ghRemote.repo}.git\` (uses your SSH agent identity instead of cached HTTPS credentials).`
            : "Or switch the remote to HTTPS and re-authenticate via `gh auth login`.",
        ]
        return NextResponse.json(
          {
            ok: false,
            phase: "push",
            blocked: true,
            reason: "permission_denied",
            message:
              "GitHub rejected the push because the authenticated account does not have permission for this repository. Your Git may be using cached credentials from another account.",
            stderr: push.stderr.slice(0, 4000),
            stdout: push.stdout.slice(0, 2000),
            github: ghPermission
              ? {
                  login: ghStatus?.login ?? null,
                  owner: ghPermission.owner,
                  repo: ghPermission.repo,
                  remoteUrl: ghPermission.remoteUrl,
                  protocol: ghPermission.protocol,
                  permissions: ghPermission.permissions,
                  canPush: ghPermission.canPush,
                }
              : ghRemote
                ? {
                    login: ghStatus?.login ?? null,
                    owner: ghRemote.owner,
                    repo: ghRemote.repo,
                    remoteUrl: ghRemote.remoteUrl,
                    protocol: ghRemote.protocol,
                  }
                : undefined,
            suggestions,
          },
          { status: 403 }
        )
      }
      return NextResponse.json(
        {
          ok: false,
          phase: "push",
          message: "git push failed",
          stderr: push.stderr.slice(0, 4000),
          stdout: push.stdout.slice(0, 2000),
        },
        { status: 502 }
      )
    }

    // Push succeeded — bake this state into the snapshot so the next
    // pre-commit/pre-push gate has a baseline to compare against.
    if (scan) {
      const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
      const shortSha = sha.status === 0 ? sha.stdout.trim() || null : null
      writeLastScan(resolved, {
        risk_score: scan.risk_score,
        summary: { ...scan.summary },
        generated_at: new Date().toISOString(),
        branch,
        sha: shortSha,
        source: "push",
      })
    }

    return NextResponse.json({
      ok: true,
      branch,
      message: `Pushed '${branch}' to origin.`,
      stdout: push.stdout.trim(),
      stderr: push.stderr.trim(),
      report: scan
        ? { risk_score: scan.risk_score, summary: scan.summary }
        : null,
      evaluation: policyEval,
      policySource: policyMeta?.policySource,
      policyErrors: policyMeta?.policyErrors,
      baseSource: policyMeta?.baseSource,
      baseBranch: policyMeta?.baseBranch,
      baseSha: policyMeta?.baseSha,
      scanForcedByPolicy: policyMeta?.scanForcedByPolicy,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { ok: false, error: err.message, stderr: err.stderr || undefined },
        { status: err.status }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
