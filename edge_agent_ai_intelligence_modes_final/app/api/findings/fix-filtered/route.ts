/**
 * POST /api/findings/fix-filtered  (intelligence-mode aware)
 *
 * Bulk "Fix filtered/selected" with clustering FIRST so N findings →
 * M clusters → M model calls (many of them zero, resolved by template).
 *
 * This version adds, on top of the original:
 *   - `intelligenceMode` handling (Save = templates/suggestions only,
 *     no LLM clusters; Auto/Pro/Max = LLM clusters allowed).
 *   - a pre-flight COST ESTIMATE + budget gate before any LLM traffic.
 *   - one representative LLM call per cluster (never one per finding),
 *     using a graph-bounded ContextBundle for the representative.
 *   - per-member status surfaced so the UI shows "1 patch → 5 findings".
 *
 * Still preview-only: apply happens one cluster at a time via
 * /api/finding/patch?mode=apply so a human confirms each write.
 */

import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import { clusterFindings, totalEstimatedLlmCalls } from "@/lib/server-fix-clustering"
import { generatePatchPreview, type PatchResult } from "@/lib/server-patch-pipeline"
import {
  buildAndMaybeApplyFixes,
  targetsFromScannerFindings,
} from "@/lib/server-finding-fixes"
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
export const maxDuration = 300

interface BulkBody {
  projectPath?: string
  findings?: Array<Partial<PlannerFinding> & { has_suggested_patch?: boolean }>
  intelligenceMode?: IntelligenceMode
  concurrency?: number
  apiKey?: string
  baseUrl?: string | null
  provider?: ProviderKind
  privateCodeMode?: boolean
  /** When true, skip the budget gate (UI confirmed the estimate). */
  budgetConfirmed?: boolean
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

function coerceFinding(
  raw: Partial<PlannerFinding> & { has_suggested_patch?: boolean },
): PlannerFinding | null {
  if (!raw || typeof raw !== "object") return null
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null
  const rule_id = typeof raw.rule_id === "string" && raw.rule_id.trim() ? raw.rule_id.trim() : null
  const severity = raw.severity
  const file = typeof raw.file === "string" && raw.file.trim() ? raw.file : null
  const line = typeof raw.line === "number" ? raw.line : Number.NaN
  if (
    !id || !rule_id || !file || !Number.isFinite(line) ||
    (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low")
  ) {
    return null
  }
  return {
    id, rule_id, severity,
    category: typeof raw.category === "string" ? raw.category : "",
    file, line: Math.max(1, Math.floor(line)),
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    confidence_band: typeof raw.confidence_band === "string" ? raw.confidence_band : undefined,
    has_suggested_patch: !!raw.has_suggested_patch,
    evidence_path_files: typeof raw.evidence_path_files === "number" ? raw.evidence_path_files : undefined,
    evidence_path_len: typeof raw.evidence_path_len === "number" ? raw.evidence_path_len : undefined,
  }
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (i: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export async function POST(req: Request) {
  let body: BulkBody
  try {
    body = (await req.json()) as BulkBody
  } catch {
    return bad("invalid JSON body")
  }
  if (!body.projectPath) return bad("projectPath is required")
  if (!Array.isArray(body.findings) || body.findings.length === 0) {
    return bad("findings[] is required (non-empty)")
  }
  if (body.findings.length > 500) return bad("too many findings (max 500)", 413)

  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(body.projectPath.trim())
  if (!isPathInside(resolved, allowRoot)) return bad("projectPath escapes scan root", 403)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return bad("projectPath is not a directory", 404)
  }

  const intelligenceMode: IntelligenceMode = body.intelligenceMode ?? "auto"
  const policy = MODE_POLICIES[intelligenceMode]
  const provider = (body.provider ?? "openai_compatible") as ProviderKind

  const planned: { finding: PlannerFinding; plan: ReturnType<typeof planFix> }[] = []
  for (const raw of body.findings) {
    const f = coerceFinding(raw)
    if (!f) continue
    planned.push({ finding: f, plan: planFix(f) })
  }
  if (planned.length === 0) return bad("no valid findings after parsing")

  const clusters = clusterFindings(planned)
  const byId = new Map(planned.map((p) => [p.finding.id, p.finding]))

  const templateClusters = clusters.filter(
    (c) => c.fix_class === "template_fix" || c.fix_class === "scanner_rule_fix",
  )
  const llmClusters = clusters.filter(
    (c) => c.fix_class === "llm_simple_patch" || c.fix_class === "llm_complex_patch",
  )
  const handOffClusters = clusters.filter(
    (c) => c.fix_class === "cannot_fix_safely" || c.fix_class === "needs_user_decision",
  )

  // ---- COST ESTIMATE (one call per LLM cluster) + budget gate ----
  const callEstimates: CallEstimate[] = []
  if (policy.allowPatchGeneration) {
    for (const c of llmClusters) {
      const rep = byId.get(c.finding_ids[0])
      if (!rep) continue
      const complexity = scoreComplexity({
        rule_id: rep.rule_id,
        severity: rep.severity,
        evidencePathFiles: rep.evidence_path_files,
        evidencePathLen: rep.evidence_path_len,
      })
      const decision = routeForMode({
        mode: intelligenceMode,
        task: "bulk",
        complexity,
        provider,
        privateCodeMode: !!body.privateCodeMode,
      })
      const inputTokens = BUNDLE_INPUT_TOKEN_CAP[decision.bundleMode]
      callEstimates.push(
        estimateCall({
          model: decision.model,
          tier: decision.tier,
          inputTokens,
          outputTokens: decision.maxTokens,
          provider,
        }),
      )
    }
  }
  const estimate = summarizeBatch(callEstimates)
  const budget = checkBudget(estimate.estimatedCostUsdHigh)
  if (!budget.ok && !body.budgetConfirmed) {
    return NextResponse.json({
      status: "needs_budget_confirmation",
      intelligenceMode,
      total_findings: planned.length,
      cluster_count: clusters.length,
      estimate,
      budget,
    })
  }

  // ---- Template clusters: zero LLM ----
  const templateResults = templateClusters.map((c) => {
    const findings = c.finding_ids.map((id) => byId.get(id)).filter((f): f is PlannerFinding => !!f)
    const targets = targetsFromScannerFindings(
      findings.map((f) => ({ id: f.id, rule_id: f.rule_id, file: f.file, line: f.line, title: undefined })),
    )
    const r = buildAndMaybeApplyFixes({ projectPath: resolved, targets, mode: "suggest" })
    return {
      cluster_id: c.cluster_id, kind: c.kind, fix_class: c.fix_class, rule_id: c.rule_id,
      files: c.files, finding_ids: c.finding_ids, reason: c.reason,
      template_proposals: r.proposals, llm_preview: null as PatchResult | null,
    }
  })

  // ---- LLM clusters: ONE representative call each (Save skips entirely) ----
  const concurrency = Math.max(1, Math.min(6, body.concurrency ?? 3))
  const llmResults = policy.allowPatchGeneration
    ? await mapWithLimit(llmClusters, concurrency, async (c) => {
        const representative = byId.get(c.finding_ids[0])
        if (!representative) {
          return {
            cluster_id: c.cluster_id, kind: c.kind, fix_class: c.fix_class, rule_id: c.rule_id,
            files: c.files, finding_ids: c.finding_ids, reason: c.reason, template_proposals: [],
            llm_preview: { refused: true as const, findingId: c.finding_ids[0], reason: "cluster representative missing", stage: "internal_error" as const },
          }
        }
        const plan = { ...planFix(representative), fix_class: c.fix_class, needs_llm: true, needs_graph_context: true, reason: c.reason }
        const preview = await generatePatchPreview({
          projectPath: resolved, finding: representative, plan, provider,
          apiKey: body.apiKey ?? process.env.OPENAI_API_KEY ?? null,
          baseUrl: body.baseUrl ?? null, privateCodeMode: !!body.privateCodeMode,
        })
        return {
          cluster_id: c.cluster_id, kind: c.kind, fix_class: c.fix_class, rule_id: c.rule_id,
          files: c.files, finding_ids: c.finding_ids, reason: c.reason, template_proposals: [],
          llm_preview: preview,
        }
      })
    : llmClusters.map((c) => ({
        cluster_id: c.cluster_id, kind: c.kind, fix_class: c.fix_class, rule_id: c.rule_id,
        files: c.files, finding_ids: c.finding_ids, reason: c.reason, template_proposals: [],
        llm_preview: { refused: true as const, findingId: c.finding_ids[0], reason: "Save mode: LLM patch generation disabled; use template/suggestion", stage: "guard_provider" as const },
      }))

  const handOffResults = handOffClusters.map((c) => ({
    cluster_id: c.cluster_id, kind: c.kind, fix_class: c.fix_class, rule_id: c.rule_id,
    files: c.files, finding_ids: c.finding_ids, reason: c.reason, template_proposals: [],
    llm_preview: null as PatchResult | null,
  }))

  const bySig = new Map(
    [...templateResults, ...llmResults, ...handOffResults].map((r) => [r.cluster_id, r]),
  )
  const ordered = clusters.map((c) => bySig.get(c.cluster_id)).filter((x): x is NonNullable<typeof x> => !!x)

  return NextResponse.json({
    status: "ok",
    intelligenceMode,
    project: resolved,
    total_findings: planned.length,
    cluster_count: clusters.length,
    estimated_llm_calls: policy.allowPatchGeneration ? totalEstimatedLlmCalls(clusters) : 0,
    estimate,
    budget,
    clusters: ordered,
  })
}
