/**
 * POST /api/findings/fix-filtered
 *
 * Bulk "Fix selected" flow. Clusters the selection, generates one fix
 * per cluster (deterministic where possible, LLM where required), and
 * returns previews — never writes.
 *
 * Why "filtered": the typical entry point is "user filters findings
 * down to severity=high & category=tools, hits Fix selected". The
 * cluster step collapses N findings → M clusters → M model calls, so
 * the surfaced `estimated_llm_calls` lets the UI warn the user before
 * any traffic goes out.
 *
 * Mode is preview-only. Apply MUST happen one cluster at a time via
 * `/api/finding/patch?mode=apply` so the user always confirms a single
 * change before a single write.
 */

import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import {
  clusterFindings,
  totalEstimatedLlmCalls,
} from "@/lib/server-fix-clustering"
import {
  generatePatchPreview,
  type PatchResult,
} from "@/lib/server-patch-pipeline"
import {
  buildAndMaybeApplyFixes,
  targetsFromScannerFindings,
} from "@/lib/server-finding-fixes"
import type { ProviderKind } from "@/lib/server-model-router"

export const dynamic = "force-dynamic"
export const maxDuration = 300

interface BulkBody {
  projectPath?: string
  findings?: Array<Partial<PlannerFinding> & { has_suggested_patch?: boolean }>
  /** Cap concurrent LLM calls. Default 3, hard cap 6. */
  concurrency?: number
  /** Provider config — same shape as /api/finding/patch. */
  apiKey?: string
  baseUrl?: string | null
  provider?: ProviderKind
  privateCodeMode?: boolean
  /** When true, persist suppressions for `needs_user_decision` clusters
   *  marked as "user accepts this as a known FP". Default: false — UI
   *  must explicitly opt in (we never auto-suppress). */
  confirmSuppressions?: boolean
}

function bad(msg: string, status = 400): NextResponse {
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
    !id ||
    !rule_id ||
    !file ||
    !Number.isFinite(line) ||
    (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low")
  ) {
    return null
  }
  return {
    id,
    rule_id,
    severity,
    category: typeof raw.category === "string" ? raw.category : "",
    file,
    line: Math.max(1, Math.floor(line)),
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    confidence_band:
      typeof raw.confidence_band === "string" ? raw.confidence_band : undefined,
    has_suggested_patch: !!raw.has_suggested_patch,
    evidence_path_files:
      typeof raw.evidence_path_files === "number" ? raw.evidence_path_files : undefined,
    evidence_path_len:
      typeof raw.evidence_path_len === "number" ? raw.evidence_path_len : undefined,
  }
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, Math.max(1, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    },
  )
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
    return bad("findings[] is required (must be a non-empty array)")
  }
  if (body.findings.length > 500) {
    return bad("too many findings (max 500 per request)", 413)
  }

  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(body.projectPath.trim())
  if (!isPathInside(resolved, allowRoot)) {
    return bad("projectPath escapes scan root", 403)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return bad("projectPath is not a directory", 404)
  }

  const planned: { finding: PlannerFinding; plan: ReturnType<typeof planFix> }[] = []
  for (const raw of body.findings) {
    const f = coerceFinding(raw)
    if (!f) continue
    planned.push({ finding: f, plan: planFix(f) })
  }
  if (planned.length === 0) {
    return bad("no valid findings after parsing")
  }

  const clusters = clusterFindings(planned)
  const llmCallEstimate = totalEstimatedLlmCalls(clusters)

  const templateClusters = clusters.filter(
    (c) => c.fix_class === "template_fix" || c.fix_class === "scanner_rule_fix",
  )
  const llmClusters = clusters.filter(
    (c) => c.fix_class === "llm_simple_patch" || c.fix_class === "llm_complex_patch",
  )
  const handOffClusters = clusters.filter(
    (c) => c.fix_class === "cannot_fix_safely" || c.fix_class === "needs_user_decision",
  )

  const byId = new Map(planned.map((p) => [p.finding.id, p.finding]))

  const templateResults = templateClusters.map((c) => {
    const findings = c.finding_ids
      .map((id) => byId.get(id))
      .filter((f): f is PlannerFinding => !!f)
    const targets = targetsFromScannerFindings(
      findings.map((f) => ({
        id: f.id,
        rule_id: f.rule_id,
        file: f.file,
        line: f.line,
        title: undefined,
      })),
    )
    const r = buildAndMaybeApplyFixes({ projectPath: resolved, targets, mode: "suggest" })
    return {
      cluster_id: c.cluster_id,
      kind: c.kind,
      fix_class: c.fix_class,
      rule_id: c.rule_id,
      files: c.files,
      finding_ids: c.finding_ids,
      reason: c.reason,
      template_proposals: r.proposals,
      llm_preview: null as PatchResult | null,
    }
  })

  const concurrency = Math.max(1, Math.min(6, body.concurrency ?? 3))
  const llmResults = await mapWithLimit(llmClusters, concurrency, async (c) => {
    const representative = byId.get(c.finding_ids[0])
    if (!representative) {
      return {
        cluster_id: c.cluster_id,
        kind: c.kind,
        fix_class: c.fix_class,
        rule_id: c.rule_id,
        files: c.files,
        finding_ids: c.finding_ids,
        reason: c.reason,
        template_proposals: [],
        llm_preview: {
          refused: true as const,
          findingId: c.finding_ids[0],
          reason: "cluster representative finding missing",
          stage: "internal_error" as const,
        },
      }
    }
    const plan = {
      ...planFix(representative),
      fix_class: c.fix_class,
      needs_llm: true,
      needs_graph_context: true,
      reason: c.reason,
    }
    const preview = await generatePatchPreview({
      projectPath: resolved,
      finding: representative,
      plan,
      provider: (body.provider ?? "openai_compatible") as ProviderKind,
      apiKey: body.apiKey ?? process.env.OPENAI_API_KEY ?? null,
      baseUrl: body.baseUrl ?? null,
      privateCodeMode: !!body.privateCodeMode,
    })
    return {
      cluster_id: c.cluster_id,
      kind: c.kind,
      fix_class: c.fix_class,
      rule_id: c.rule_id,
      files: c.files,
      finding_ids: c.finding_ids,
      reason: c.reason,
      template_proposals: [],
      llm_preview: preview,
    }
  })

  const handOffResults = handOffClusters.map((c) => ({
    cluster_id: c.cluster_id,
    kind: c.kind,
    fix_class: c.fix_class,
    rule_id: c.rule_id,
    files: c.files,
    finding_ids: c.finding_ids,
    reason: c.reason,
    template_proposals: [],
    llm_preview: null as PatchResult | null,
  }))

  if (body.confirmSuppressions === true) {
    persistSuppressions(resolved, handOffClusters)
  }

  const bySig = new Map(
    [...templateResults, ...llmResults, ...handOffResults].map((r) => [
      r.cluster_id,
      r,
    ]),
  )
  const ordered = clusters
    .map((c) => bySig.get(c.cluster_id))
    .filter((x): x is NonNullable<typeof x> => !!x)

  return NextResponse.json({
    status: "ok",
    project: resolved,
    total_findings: planned.length,
    cluster_count: clusters.length,
    estimated_llm_calls: llmCallEstimate,
    clusters: ordered,
  })
}

interface SuppressionEntry {
  rule_id: string
  finding_id: string
  file: string
  line: number
  reason: string
  added_at: string
}

function persistSuppressions(
  projectPath: string,
  clusters: ReturnType<typeof clusterFindings>,
): void {
  const file = path.join(projectPath, ".edgeagent", "suppressions.json")
  let store: { suppressions: SuppressionEntry[] } = { suppressions: [] }
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8")) as typeof store
    if (!Array.isArray(store.suppressions)) store.suppressions = []
  } catch {
    /* fresh file */
  }
  const now = new Date().toISOString()
  for (const c of clusters) {
    for (const id of c.finding_ids) {
      store.suppressions.push({
        rule_id: c.rule_id,
        finding_id: id,
        file: c.files[0] ?? "",
        line: 0,
        reason: c.reason,
        added_at: now,
      })
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
  fs.renameSync(tmp, file)
}
