import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import { runScannerOn, ScannerError } from "@/lib/server-scan"
import { evaluatePolicy, type PolicyEvaluation } from "@/lib/policy"
import {
  loadComparisonBaseline,
  loadPolicyFor,
  writeLastScan,
} from "@/lib/server-policy"
import type { ScanReport } from "@/lib/scan-report"

/**
 * POST /api/git/commit
 *
 * Body:
 *   {
 *     projectPath: string
 *     message: string
 *     runScanBeforeCommit: boolean
 *     warnOnCriticalFindings: boolean
 *   }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath. Ensure it's a Git repo.
 *   2. Validate `message` (required, capped length).
 *   3. If `runScanBeforeCommit`, run the scanner on the project. If
 *      `warnOnCriticalFindings` and the scan reports any critical/high
 *      findings, return 409 with `{ blocked: true, report }` so the UI
 *      can present the findings before letting the user proceed.
 *   4. `git status --short`; if empty, return `{ ok: true, noChanges: true }`.
 *   5. `git add -A` then `git commit -m <message>`.
 *
 * The route never pushes — push is a separate, explicitly confirmed
 * action under /api/git/push.
 */

const MAX_MESSAGE_LEN = 4000

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      message?: string
      runScanBeforeCommit?: boolean
      warnOnCriticalFindings?: boolean
    }

    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const rawMessage = typeof body.message === "string" ? body.message : ""
    const message = rawMessage.trim()
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Commit message is required." },
        { status: 400 }
      )
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return NextResponse.json(
        {
          ok: false,
          error: `Commit message too long (max ${MAX_MESSAGE_LEN} characters).`,
        },
        { status: 400 }
      )
    }

    // Load policy FIRST so we can force the scan whenever it's in
    // block mode. Otherwise a stale `runScanBeforeCommit: false` in
    // the user's localStorage (left over from before that toggle
    // defaulted to on) would silently skip the entire policy gate
    // and the commit would slip through even though the policy file
    // says it should block. The policy file is now authoritative —
    // not a UI checkbox.
    const loaded = loadPolicyFor(resolved)
    const policyEnforces = loaded.policy.mode === "block"
    const requestedScan = !!body.runScanBeforeCommit
    const runScan = policyEnforces || requestedScan
    const scanForcedByPolicy = policyEnforces && !requestedScan
    const warnOnCritical = !!body.warnOnCriticalFindings

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
            error: "Pre-commit scan failed",
            message: err.message,
            stderr: err.stderr,
          },
          { status: 500 }
        )
      }

      // Policy file (when present) supersedes the simple critical/high
      // toggle. We only block when policy says "block"; a pure "warn"
      // result lets the commit through but the UI still surfaces it.
      //
      // The baseline we compare against is, in priority order:
      //   1. A scan of the configured base branch (default "main"),
      //      which mirrors what Branch Compare does. This is what
      //      detects "you regressed vs main" — the case the
      //      per-project snapshot misses on first-commit-on-feature-
      //      branch.
      //   2. The per-branch last-scan snapshot, used when we're
      //      committing on the base branch itself or the base scan
      //      failed.
      //   3. None — only absolute rules (block_if_critical) apply.
      const branchInfo = runGit(resolved, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
      const currentBranch =
        branchInfo.status === 0 ? branchInfo.stdout.trim() || null : null
      const baseline = await loadComparisonBaseline(resolved, {
        policy: loaded.policy,
        currentBranch,
      })
      policyEval = evaluatePolicy({
        baseReport: baseline.baseReport ?? null,
        targetReport: {
          risk_score: scan.risk_score,
          summary: scan.summary,
        } as unknown as ScanReport,
        policy: loaded.policy,
        context: { branch: currentBranch ?? undefined },
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
              ? `Commit blocked by policy: ${
                  policyEval.reasons[0] ?? "see details"
                }`
              : `Commit blocked: scanner reports ${scan.summary.critical} critical and ${scan.summary.high} high finding(s).`,
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

    const status = runGit(resolved, ["status", "--short"])
    if (status.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "git status failed",
          stderr: status.stderr.slice(0, 2000),
        },
        { status: 500 }
      )
    }
    if (status.stdout.trim().length === 0) {
      return NextResponse.json({
        ok: true,
        noChanges: true,
        message: "No changes to commit.",
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
    }

    const add = runGit(resolved, ["add", "-A"], { timeoutMs: 60_000 })
    if (add.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "add",
          message: "git add -A failed",
          stderr: add.stderr.slice(0, 4000),
        },
        { status: 500 }
      )
    }

    const commit = runGit(resolved, ["commit", "-m", message], {
      timeoutMs: 30_000,
    })
    if (commit.status !== 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "commit",
          message: "git commit failed",
          stderr: commit.stderr.slice(0, 4000),
          stdout: commit.stdout.slice(0, 2000),
        },
        { status: 500 }
      )
    }

    const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
    const shortSha = sha.status === 0 ? sha.stdout.trim() || null : null

    // Persist the post-commit snapshot so the NEXT commit's pre-scan
    // can detect "you regressed since the last accepted change."
    // Only do this when we actually ran a scan and it passed the gate
    // — otherwise we'd have no data to record, or worse, would lock
    // in a state we never verified.
    if (scan) {
      const branchInfo = runGit(resolved, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
      const branch =
        branchInfo.status === 0 ? branchInfo.stdout.trim() || null : null
      writeLastScan(resolved, {
        risk_score: scan.risk_score,
        summary: { ...scan.summary },
        generated_at: new Date().toISOString(),
        branch,
        sha: shortSha,
        source: "commit",
      })
    }

    return NextResponse.json({
      ok: true,
      message: `Committed${shortSha ? ` (${shortSha})` : ""}: ${
        message.split("\n")[0]
      }`,
      sha: shortSha,
      stdout: commit.stdout.slice(0, 2000),
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
