/**
 * POST /api/scan/estimate
 *
 * Pre-flight cost/latency estimate for a planned fix operation under a
 * chosen intelligence mode, BEFORE any model traffic. The UI calls this
 * to render "Fix all 47 → ~6 calls, ~$0.12–$0.20" so the user can
 * confirm.
 *
 * It reuses the SAME clustering + routing + pricing the real fix route
 * uses, so the estimate tracks reality. No model is called; no file is
 * written.
 */

import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import { clusterFindings } from "@/lib/server-fix-clustering"
import type { ProviderKind } from "@/lib/server-model-router"
import { MODE_POLICIES, scoreComplexity } from "@/lib/intelligence-mode"
import { routeForMode } from "@/lib/server-model-router-ext"
import {
  estimateCall,
  summarizeBatch,
  checkBudget,
  type CallEstimate,
} from "@/lib/server-cost-controller"
import { BUNDLE_INPUT_TOKEN_CAP } from "@/lib/context-bundle"
import type { IntelligenceMode } from "@/lib/context-bundle"

export const dynamic = "force-dynamic"

interface EstimateBody {
  projectPath?: string
  findings?: Array<Partial<PlannerFinding>>
  intelligenceMode?: IntelligenceMode
  provider?: ProviderKind
  privateCodeMode?: boolean
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

function coerce(raw: Partial<PlannerFinding>): PlannerFinding | null {
  if (!raw?.id || !raw.rule_id || !raw.file || typeof raw.line !== "number") return null
  const sev = raw.severity
  if (sev !== "critical" && sev !== "high" && sev !== "medium" && sev !== "low") return null
  return {
    id: raw.id, rule_id: raw.rule_id, severity: sev, category: raw.category ?? "",
    file: raw.file, line: Math.max(1, Math.floor(raw.line)),
    confidence: raw.confidence, has_suggested_patch: !!raw.has_suggested_patch,
    evidence_path_files: raw.evidence_path_files, evidence_path_len: raw.evidence_path_len,
  }
}

export async function POST(req: Request) {
  let body: EstimateBody
  try {
    body = (await req.json()) as EstimateBody
  } catch {
    return bad("invalid JSON body")
  }
  if (!body.projectPath) return bad("projectPath is required")
  if (!Array.isArray(body.findings) || body.findings.length === 0) {
    return bad("findings[] required")
  }
  const resolved = path.resolve(body.projectPath.trim())
  if (!isPathInside(resolved, getScanAllowRoot())) return bad("projectPath escapes scan root", 403)
  if (!fs.existsSync(resolved)) return bad("projectPath not found", 404)

  const intelligenceMode: IntelligenceMode = body.intelligenceMode ?? "auto"
  const policy = MODE_POLICIES[intelligenceMode]
  const provider = (body.provider ?? "openai_compatible") as ProviderKind

  const planned = body.findings
    .map((r) => coerce(r))
    .filter((f): f is PlannerFinding => !!f)
    .map((f) => ({ finding: f, plan: planFix(f) }))

  const clusters = clusterFindings(planned)
  const byId = new Map(planned.map((p) => [p.finding.id, p.finding]))
  const llmClusters = clusters.filter(
    (c) => c.fix_class === "llm_simple_patch" || c.fix_class === "llm_complex_patch",
  )

  const calls: CallEstimate[] = []
  const perCluster: Array<Record<string, unknown>> = []
  if (policy.allowPatchGeneration) {
    for (const c of llmClusters) {
      const rep = byId.get(c.finding_ids[0])
      if (!rep) continue
      const complexity = scoreComplexity({
        rule_id: rep.rule_id, severity: rep.severity,
        evidencePathFiles: rep.evidence_path_files, evidencePathLen: rep.evidence_path_len,
      })
      const decision = routeForMode({ mode: intelligenceMode, task: "bulk", complexity, provider, privateCodeMode: !!body.privateCodeMode })
      const inputTokens = BUNDLE_INPUT_TOKEN_CAP[decision.bundleMode]
      const est = estimateCall({ model: decision.model, tier: decision.tier, inputTokens, outputTokens: decision.maxTokens, provider })
      calls.push(est)
      perCluster.push({
        cluster_id: c.cluster_id, rule_id: c.rule_id, members: c.finding_ids.length,
        model: decision.model, tier: decision.tier, bundleMode: decision.bundleMode,
        twoStep: decision.twoStep, estCostUsd: est.costUsd,
      })
    }
  }

  const batch = summarizeBatch(calls)
  const budget = checkBudget(batch.estimatedCostUsdHigh)

  return NextResponse.json({
    status: "ok",
    intelligenceMode,
    total_findings: planned.length,
    cluster_count: clusters.length,
    llm_cluster_count: policy.allowPatchGeneration ? llmClusters.length : 0,
    template_cluster_count: clusters.length - llmClusters.length,
    estimate: batch,
    budget,
    per_cluster: perCluster,
    note:
      intelligenceMode === "save"
        ? "Save mode performs zero LLM patch calls; templates/suggestions only."
        : `One LLM call per LLM cluster (not per finding): ${planned.length} findings → ${llmClusters.length} calls.`,
  })
}
