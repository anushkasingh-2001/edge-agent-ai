/**
 * POST /api/findings/fix-filtered   (NEW FILE)
 *
 * Bulk "Fix filtered" flow. Takes many selected findings and returns a
 * grouped set of previews — one fix per ROOT CAUSE, not per finding.
 *
 * Flow:
 *   1. Validate project path.
 *   2. Cluster the selection (lib/server-fix-clustering.ts) — deterministic.
 *   3. For each cluster, by strategy:
 *        deterministic_batch       → existing engine, ALL members at once, no AI
 *        suppress_batch            → one suppression entry, no AI
 *        llm_single_representative → ONE pipeline call on the representative,
 *                                    then fan the diff out as a template
 *   4. Cache cluster results (grouped_fixes namespace).
 *   5. Return grouped previews + an LLM-call estimate so the UI can warn
 *      "this will make N model calls" before the user commits.
 *
 * This is how 100 findings collapse to a handful of calls. Nothing is
 * written; the user reviews and applies per-cluster or per-file.
 */

import path from "node:path"
import { NextResponse } from "next/server"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  clusterFindings,
  estimateLlmCalls,
  type ClusterableFinding,
  type FindingCluster,
} from "@/lib/server-fix-clustering"
import {
  buildAndMaybeApplyFixes,
  targetsFromScannerFindings,
} from "@/lib/server-finding-fixes"
import { TEMPLATE_COVERED_RULES } from "@/lib/fix-planner"
import {
  generatePatchPreview,
  type GraphContext,
  type LlmConfig,
  type PipelineFinding,
} from "@/lib/server-patch-pipeline"
import { cacheGet, cacheSet, buildCacheKey } from "@/lib/fix-cache"
import type { ProviderKind } from "@/lib/server-model-router"

export const dynamic = "force-dynamic"
export const maxDuration = 300 // bulk can take a while; clusters run concurrently below

interface BulkBody {
  projectPath?: string
  scannerVersion?: string
  findings?: Array<
    ClusterableFinding & {
      severity: "critical" | "high" | "medium" | "low"
      category?: string
      evidence?: string
    }
  >
  /** Per-cluster graph context, keyed by cluster signature (optional). */
  contextBySignature?: Record<string, GraphContext>
  apiKey?: string
  baseUrl?: string | null
  provider?: ProviderKind
  privateCodeMode?: boolean
  /** Cap concurrent LLM calls. Default 4. */
  concurrency?: number
}

interface ClusterResult {
  signature: string
  label: string
  strategy: FindingCluster["strategy"]
  member_ids: string[]
  /** For deterministic/LLM: the proposals/preview(s). */
  previews: unknown[]
  /** For suppress_batch. */
  suppressed?: { rule_id: string; count: number }
  error: string | null
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

/** Run async tasks with a concurrency cap. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export async function POST(req: Request) {
  let body: BulkBody = {}
  try {
    body = (await req.json()) as BulkBody
  } catch {
    return bad("invalid_json")
  }
  if (!body.projectPath) return bad("projectPath is required")
  if (!Array.isArray(body.findings) || body.findings.length === 0) {
    return bad("findings[] is required")
  }

  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(body.projectPath)
  if (!isPathInside(resolved, allowRoot)) return bad("projectPath escapes scan root", 403)

  const scannerVersion = body.scannerVersion ?? "unknown"
  const concurrency = Math.max(1, Math.min(8, body.concurrency ?? 4))

  // 2. Cluster — tag template-coverable so the clusterer can pick
  //    deterministic_batch where every member is templated.
  const clusterable: ClusterableFinding[] = body.findings.map((f) => ({
    ...f,
    template_coverable: f.template_coverable ?? TEMPLATE_COVERED_RULES.has(f.rule_id),
  }))
  const clusters = clusterFindings(clusterable)
  const llmCallEstimate = estimateLlmCalls(clusters)

  const llmClusters = clusters.filter((c) => c.strategy === "llm_single_representative")
  const cheapClusters = clusters.filter((c) => c.strategy !== "llm_single_representative")

  // 3a. Deterministic + suppress clusters — instant, no AI, run inline.
  const cheapResults: ClusterResult[] = cheapClusters.map((c) => {
    if (c.strategy === "suppress_batch") {
      // TODO(integration): persist a suppression rule for this FP class to
      // .edgeagent/suppressions.json so future scans skip it. Here we just
      // report what WOULD be suppressed; nothing is written until apply.
      return {
        signature: c.signature,
        label: c.label,
        strategy: c.strategy,
        member_ids: c.members.map((m) => m.id),
        previews: [],
        suppressed: { rule_id: c.rule_id, count: c.members.length },
        error: null,
      }
    }
    // deterministic_batch: feed ALL members to the engine in suggest mode.
    const targets = targetsFromScannerFindings(
      c.members.map((m) => ({
        id: m.id,
        rule_id: m.rule_id,
        file: m.file,
        line: m.line,
        title: undefined,
      })),
    )
    const r = buildAndMaybeApplyFixes({ projectPath: resolved, targets, mode: "suggest" })
    return {
      signature: c.signature,
      label: c.label,
      strategy: c.strategy,
      member_ids: c.members.map((m) => m.id),
      previews: r.proposals,
      error: null,
    }
  })

  // 3b. LLM clusters — ONE pipeline call per cluster on the representative,
  //     concurrency-capped.
  const llm: LlmConfig = {
    apiKey: body.apiKey ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl: body.baseUrl ?? null,
    provider: (body.provider ?? "openai") as ProviderKind,
    privateCodeMode: body.privateCodeMode,
  }

  const llmResults: ClusterResult[] = await mapWithLimit(llmClusters, concurrency, async (c) => {
    const modelForKey = body.privateCodeMode ? "local" : (body.provider ?? "openai")
    const cacheKey = buildCacheKey({
      model: modelForKey,
      scannerVersion,
      fileHashes: [c.signature], // signature already encodes file/shape/path
      findingIds: c.members.map((m) => m.id),
      contextHash: c.signature,
    })
    const cached = cacheGet<ClusterResult>(resolved, "grouped_fixes", cacheKey)
    if (cached) return cached

    const rep = c.representative
    const finding: PipelineFinding = {
      id: rep.id,
      rule_id: rep.rule_id,
      severity: rep.severity,
      category: "",
      file: rep.file,
      line: rep.line,
      evidence: "",
      code: rep.code ?? "",
    }
    const ctx = body.contextBySignature?.[c.signature]

    // Complex if the cluster spans multiple files; else simple.
    const distinctFiles = new Set(c.members.map((m) => m.file)).size
    const fixClass = distinctFiles > 1 ? "llm_complex_patch" : "llm_simple_patch"

    const preview = await generatePatchPreview({
      projectPath: resolved,
      scannerVersion,
      finding,
      fixClass,
      context: ctx,
      llm,
    })

    const result: ClusterResult = {
      signature: c.signature,
      label: c.label,
      strategy: c.strategy,
      member_ids: c.members.map((m) => m.id),
      // The representative preview is the template; the client fans it out
      // to the other members (same code shape ⇒ same fix). We include the
      // member list so the UI can show "applies to N findings".
      previews: [preview],
      error: preview.error,
    }
    if (preview.applicable && !preview.error) {
      cacheSet(resolved, "grouped_fixes", cacheKey, result)
    }
    return result
  })

  // Preserve the clusterer's ordering (deterministic first).
  const bySig = new Map<string, ClusterResult>()
  for (const r of [...cheapResults, ...llmResults]) bySig.set(r.signature, r)
  const ordered = clusters.map((c) => bySig.get(c.signature)).filter(Boolean)

  return NextResponse.json({
    status: "ok",
    total_findings: body.findings.length,
    cluster_count: clusters.length,
    llm_call_estimate: llmCallEstimate,
    clusters: ordered,
  })
}
