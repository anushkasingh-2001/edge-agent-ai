/**
 * /api/policy/evaluate
 *
 * Two verbs share this route:
 *
 *   GET  ?projectPath=...                — just load + parse the policy
 *                                           file. Useful for the Overview
 *                                           and dialog headers, which want
 *                                           to show "Policy: warn (default)"
 *                                           even before any scan exists.
 *
 *   POST { projectPath, targetReport,
 *          baseReport?, baseMetrics?,
 *          targetMetrics?, context? }    — load policy AND evaluate it
 *                                           against the supplied report(s).
 *
 * Both verbs go through `resolveProjectPath` so the policy file lookup
 * inherits the same allow-root sandboxing as every other /api/git/*
 * endpoint — clients can't trick us into reading
 * `/etc/policy.yaml` by passing a malicious path.
 */

import { NextResponse } from "next/server"
import { z } from "zod"
import { GitError, resolveProjectPath } from "@/lib/server-git"
import {
  evaluatePolicy,
  type EvalMetrics,
  type PolicyEvalContext,
  type PolicyEvaluation,
} from "@/lib/policy"
import { loadComparisonBaseline, loadPolicyFor } from "@/lib/server-policy"
import type { ScanReport, WorkingTreeStatus } from "@/lib/scan-report"

/**
 * The evaluator only reads `risk_score` and `summary`, so we accept a
 * narrow subset of the full ScanReport shape. That lets Branch Compare
 * pass the lite scan summaries we already have from /api/git/compare-scan
 * without re-loading or fabricating the full report. Extra fields are
 * passed through and ignored.
 */
const PolicyReportInputSchema = z
  .object({
    risk_score: z.number(),
    summary: z.object({
      critical: z.number(),
      high: z.number(),
      medium: z.number(),
      low: z.number(),
      total: z.number(),
    }),
  })
  .passthrough()

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const { resolved } = resolveProjectPath(url.searchParams.get("projectPath"))
    const loaded = loadPolicyFor(resolved)
    return NextResponse.json({ ...loaded, evaluation: null })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}

interface PostBody {
  projectPath?: string
  targetReport?: ScanReport
  baseReport?: ScanReport
  targetMetrics?: EvalMetrics
  baseMetrics?: EvalMetrics
  context?: PolicyEvalContext
  /** When false, the route does NOT auto-fetch a base-branch scan
   *  to fill in a missing `baseReport`. Branch Compare leaves this
   *  unset (defaults to true) but explicitly supplies both reports
   *  so the auto-fetch never runs there anyway. Most callers can
   *  ignore this — the auto-fetch is what makes Overview / dialog
   *  policy cards report regressions instead of "skipped (no base)". */
  autoLoadBase?: boolean
  /** Force a fresh scan of the base branch, ignoring the on-disk
   *  cache. The "Re-scan main" button passes this to recover from
   *  stale baselines. */
  refreshBase?: boolean
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as PostBody
    const { resolved } = resolveProjectPath(body.projectPath)

    if (!body.targetReport) {
      return NextResponse.json(
        { error: "targetReport is required" },
        { status: 400 }
      )
    }

    const targetParse = PolicyReportInputSchema.safeParse(body.targetReport)
    if (!targetParse.success) {
      return NextResponse.json(
        {
          error: "targetReport failed validation",
          issues: targetParse.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 }
      )
    }
    let baseReport: ScanReport | undefined
    if (body.baseReport) {
      const baseParse = PolicyReportInputSchema.safeParse(body.baseReport)
      if (!baseParse.success) {
        return NextResponse.json(
          {
            error: "baseReport failed validation",
            issues: baseParse.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          { status: 400 }
        )
      }
      // The evaluator's TypeScript signature is the full ScanReport, but
      // it only touches risk_score + summary. We safely cast through the
      // lite shape — passthrough() preserves any extra fields the caller
      // sent so future evaluator extensions can use them.
      baseReport = baseParse.data as unknown as ScanReport
    }

    const loaded = loadPolicyFor(resolved)

    // Auto-fill the baseline if the caller didn't supply one. This is
    // the load-bearing fix for callers like Overview's policy card —
    // they only have the latest scan in hand, so without this branch
    // the evaluator marks every delta rule "inapplicable" and the
    // card always shows "pass · 2 conditions skipped (no base)" even
    // when Branch Compare next door is correctly screaming "blocked,
    // high +18". Branch Compare itself supplies both reports so this
    // path is a no-op there.
    let baseSource: "request" | "base_branch" | "snapshot" | "none" =
      baseReport ? "request" : "none"
    let baseBranch: string | null = null
    let baseSha: string | null = null
    let baseCachedAt: string | null = null
    let baseRiskScore: number | null = null
    let baseSummary: ScanReport["summary"] | null = null
    if (!baseReport && body.autoLoadBase !== false) {
      const baseline = await loadComparisonBaseline(resolved, {
        policy: loaded.policy,
        currentBranch: body.context?.branch ?? null,
        skipBaseCache: !!body.refreshBase,
      })
      if (baseline.baseReport) {
        baseReport = baseline.baseReport
        baseSource = baseline.baseSource
        baseBranch = baseline.baseBranchScan.branch
        baseSha = baseline.baseBranchScan.sha
        baseCachedAt = baseline.baseBranchScan.cachedAt
        // Surface the actual baseline numbers so the UI can render
        // "main@abc1234 · risk 87 · high 5" alongside the verdict
        // and users can spot a stale baseline at a glance.
        if (baseline.baseBranchScan.snapshot) {
          baseRiskScore = baseline.baseBranchScan.snapshot.risk_score
          baseSummary = baseline.baseBranchScan.snapshot.summary as ScanReport["summary"]
        } else if (baseline.snapshot) {
          baseRiskScore = baseline.snapshot.risk_score
          baseSummary = baseline.snapshot.summary as ScanReport["summary"]
        }
      }
    }

    const evaluation: PolicyEvaluation = evaluatePolicy({
      baseReport,
      targetReport: targetParse.data as unknown as ScanReport,
      baseMetrics: body.baseMetrics ?? null,
      targetMetrics: body.targetMetrics ?? null,
      policy: loaded.policy,
      context: body.context,
    })

    // Pull the working_tree stamp off the *target* report and forward
    // it to the client. The base report comes from `loadBaseBranchScan`
    // which always materialises a pristine `git worktree` checkout, so
    // by construction it can never be dirty — we only need the target
    // side to power the "Scanned with N uncommitted files" warning in
    // PolicyStatusCard.
    const targetWt =
      (body.targetReport as { working_tree?: WorkingTreeStatus } | undefined)
        ?.working_tree ?? null

    return NextResponse.json({
      ...loaded,
      evaluation,
      baseSource,
      baseBranch,
      baseSha,
      baseCachedAt,
      baseRiskScore,
      baseSummary,
      targetWorkingTree: targetWt,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
