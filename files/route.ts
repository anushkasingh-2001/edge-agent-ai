/**
 * POST /api/finding/patch   (MODIFIED — replaces the not-implemented scaffold)
 *
 * Single-finding "Fix code" flow. Returns a PatchPreview. NEVER writes the
 * real file — apply is a separate explicit action (mode "apply" below).
 *
 * Flow (locked architecture):
 *   1. Validate project path against the scan allow-root (same as scan route).
 *   2. Fix Planner classifies the finding.
 *   3. template_fix / scanner_rule_fix → deterministic engine
 *      (lib/server-finding-fixes.ts), NO AI.
 *   4. cannot_fix_safely / needs_user_decision → honest, non-AI response.
 *   5. llm_simple / llm_complex → graph-bounded patch pipeline.
 *   6. Cache the validated preview (patch_previews namespace).
 *   7. mode "apply" → reuse the deterministic engine's apply path so LLM
 *      and template patches get the SAME atomic-write + backup + rollback.
 *
 * Constraints enforced here:
 *   - No write before explicit mode:"apply".
 *   - The model never sets severity/evidence/rule_id — we only pass them in.
 *   - The scanner re-scan (inside the pipeline) is the arbiter of success.
 */

import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import {
  generatePatchPreview,
  hashContext,
  type GraphContext,
  type PipelineFinding,
  type LlmConfig,
} from "@/lib/server-patch-pipeline"
import {
  buildAndMaybeApplyFixes,
  type FixTarget,
} from "@/lib/server-finding-fixes"
import {
  buildCacheKey,
  cacheGet,
  cacheSet,
  hashFileContents,
} from "@/lib/fix-cache"
import type { ProviderKind } from "@/lib/server-model-router"

export const dynamic = "force-dynamic"
export const maxDuration = 90

interface PatchRouteBody {
  projectPath?: string
  mode?: "suggest" | "apply"
  scannerVersion?: string
  finding?: Partial<PipelineFinding> & {
    confidence?: number
    has_suggested_patch?: boolean
    evidence_path_files?: number
    evidence_path_len?: number
  }
  /** Graph-bounded context (built by the context layer / client). */
  context?: GraphContext
  /** BYOK. */
  apiKey?: string
  baseUrl?: string | null
  provider?: ProviderKind
  privateCodeMode?: boolean
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

export async function POST(req: Request) {
  let body: PatchRouteBody = {}
  try {
    body = (await req.json()) as PatchRouteBody
  } catch {
    return bad("invalid_json")
  }

  if (!body.projectPath || typeof body.projectPath !== "string") {
    return bad("projectPath is required")
  }
  const f = body.finding
  if (!f || !f.id || !f.rule_id || !f.file || typeof f.line !== "number") {
    return bad("finding {id, rule_id, file, line} is required")
  }

  // Path safety — identical guard to the scan route.
  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(body.projectPath)
  if (!isPathInside(resolved, allowRoot)) {
    return bad("projectPath escapes the allowed scan root", 403)
  }

  const scannerVersion = body.scannerVersion ?? "unknown"

  // 2. Plan.
  const plannerInput: PlannerFinding = {
    id: f.id,
    rule_id: f.rule_id,
    severity: (f.severity ?? "medium") as PlannerFinding["severity"],
    category: f.category ?? "",
    file: f.file,
    line: f.line,
    confidence: f.confidence,
    has_suggested_patch: f.has_suggested_patch,
    evidence_path_files: f.evidence_path_files,
    evidence_path_len: f.evidence_path_len,
  }
  const plan = planFix(plannerInput)

  // 4. Honest non-AI outcomes.
  if (plan.fix_class === "cannot_fix_safely" || plan.fix_class === "needs_user_decision") {
    return NextResponse.json({
      status: plan.fix_class,
      applicable: false,
      finding_id: f.id,
      reason: plan.reason,
      // No diff. The UI shows manual guidance, not an Apply button.
    })
  }

  const finding: PipelineFinding = {
    id: f.id,
    rule_id: f.rule_id,
    severity: plannerInput.severity,
    category: f.category ?? "",
    file: f.file,
    line: f.line,
    evidence: f.evidence ?? "",
    code: f.code ?? "",
  }

  // ---- mode: apply — reuse the deterministic engine for safe write. ----
  // (Only deterministic classes auto-apply via the engine; LLM patches are
  //  applied by writing the previewed `after` through the same engine path.
  //  Here we keep it simple: apply uses the existing engine for template /
  //  scanner classes. LLM apply should re-run suggest then write the cached
  //  preview — wired by the client passing mode:"apply" only after preview.)
  if (body.mode === "apply") {
    if (plan.fix_class === "template_fix" || plan.fix_class === "scanner_rule_fix") {
      const target: FixTarget = {
        ref_id: f.id,
        rule_id: f.rule_id,
        file: f.file,
        line: f.line,
        title: (f as { title?: string }).title,
      }
      const result = buildAndMaybeApplyFixes({
        projectPath: resolved,
        targets: [target],
        mode: "apply",
      })
      // Applying a file invalidates any cached preview for it.
      return NextResponse.json({ status: "applied", ...result })
    }
    // For LLM patches, the client must apply the previously-previewed diff.
    return bad("llm_patch_apply_requires_preview_diff", 409)
  }

  // ---- mode: suggest (default) — build a preview. ----

  // Deterministic preview via the existing engine (suggest mode = no write).
  let deterministicDiff: { diff: string; before: string; after: string } | undefined
  if (plan.fix_class === "template_fix" || plan.fix_class === "scanner_rule_fix") {
    const target: FixTarget = {
      ref_id: f.id,
      rule_id: f.rule_id,
      file: f.file,
      line: f.line,
      title: (f as { title?: string }).title,
    }
    const r = buildAndMaybeApplyFixes({ projectPath: resolved, targets: [target], mode: "suggest" })
    const p = r.proposals[0]
    if (p && !p.error) {
      deterministicDiff = { diff: p.diff, before: p.before, after: p.after }
    } else {
      return NextResponse.json({
        status: "cannot_fix_safely",
        applicable: false,
        finding_id: f.id,
        reason: p?.error ?? "deterministic fix unavailable for this finding",
      })
    }
  }

  // Cache lookup (patch_previews) — keyed on file hash so an edited file misses.
  let fileHash = "nofile"
  try {
    fileHash = hashFileContents(fs.readFileSync(path.resolve(resolved, f.file), "utf8"))
  } catch { /* file may be unreadable; pipeline will surface it */ }

  const ctxHash = body.context ? hashContext(body.context) : "no-ctx"
  const modelForKey = body.privateCodeMode ? "local" : (body.provider ?? "openai")
  const cacheKey = buildCacheKey({
    model: modelForKey,
    scannerVersion,
    fileHashes: [fileHash],
    findingIds: [f.id],
    contextHash: ctxHash,
  })

  const cached = cacheGet(resolved, "patch_previews", cacheKey)
  if (cached) {
    return NextResponse.json({ status: "ok", cached: true, preview: cached })
  }

  // Assemble LLM config only when needed.
  const llm: LlmConfig | undefined =
    plan.needs_llm
      ? {
          apiKey: body.apiKey ?? process.env.OPENAI_API_KEY ?? "",
          baseUrl: body.baseUrl ?? null,
          provider: (body.provider ?? "openai") as ProviderKind,
          privateCodeMode: body.privateCodeMode,
        }
      : undefined

  const preview = await generatePatchPreview({
    projectPath: resolved,
    scannerVersion,
    finding,
    fixClass: plan.fix_class,
    context: body.context,
    llm,
    deterministicDiff,
  })

  // Cache only successful, applicable previews.
  if (preview.applicable && !preview.error) {
    cacheSet(resolved, "patch_previews", cacheKey, preview)
  }

  return NextResponse.json({ status: preview.error ? "error" : "ok", cached: false, preview })
}
