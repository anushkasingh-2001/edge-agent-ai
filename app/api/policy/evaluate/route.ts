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
import { loadPolicyFor } from "@/lib/server-policy"
import type { ScanReport } from "@/lib/scan-report"

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
    const evaluation: PolicyEvaluation = evaluatePolicy({
      baseReport,
      targetReport: targetParse.data as unknown as ScanReport,
      baseMetrics: body.baseMetrics ?? null,
      targetMetrics: body.targetMetrics ?? null,
      policy: loaded.policy,
      context: body.context,
    })

    return NextResponse.json({ ...loaded, evaluation })
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
