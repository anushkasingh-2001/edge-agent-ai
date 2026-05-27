/**
 * POST /api/finding/patch
 *
 * Generates (preview) or applies (apply) a single-finding fix under a
 * chosen intelligence mode. Replaces the original scaffold.
 *
 * Two operations selected by `?mode=preview` (default) or `?mode=apply`:
 *
 *   preview  Build a graph-bounded ContextBundle (NOT the whole file),
 *            route a model by intelligence mode + complexity, run the
 *            patch pipeline (model → temp workspace → parse → re-scan),
 *            score confidence, and return the preview. Never writes.
 *
 *   apply    Re-verify the file hash, back up, write, then re-scan.
 *            Only reachable after a preview the user reviewed. Refuses
 *            if the file changed since preview, if the patch is a
 *            suggestion-only (not a real fix), or if the mode forbids
 *            patch generation (Save).
 *
 * Hard invariants:
 *   - Scanner remains the arbiter: a patch that doesn't clear the
 *     finding on re-scan is never marked applied/fixed.
 *   - Real-fix gate: a TODO/comment/whitespace/AST-equivalent diff is
 *     classified `suggestion` and CANNOT be applied as a fix.
 *   - No auto-apply: apply requires an explicit second request.
 *   - Secrets rule short-circuits to the deterministic template.
 */

import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { resolveAiProviderForRequest } from "@/lib/server-ai-provider-resolver"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import {
  generatePatchPreview,
  applyPatch,
  type PatchPreview,
  type PatchResult,
} from "@/lib/server-patch-pipeline"
import { cacheList, type CacheNamespace } from "@/lib/fix-cache"
import { runScannerOn } from "@/lib/server-scan"
import type { ProviderKind } from "@/lib/server-model-router"
import {
  MODE_POLICIES,
  scoreComplexity,
  enforceGuardrails,
} from "@/lib/intelligence-mode"
import type { IntelligenceMode } from "@/lib/context-bundle"
import { isRealFixDiff } from "@/lib/patch-confidence-realfix"

export const dynamic = "force-dynamic"
export const maxDuration = 300

interface PatchBody {
  projectPath?: string
  finding?: Partial<PlannerFinding>
  /** Intelligence mode (defaults to "auto"). */
  intelligenceMode?: IntelligenceMode
  /** Provider config — BYOK. */
  apiKey?: string
  baseUrl?: string | null
  provider?: ProviderKind
  privateCodeMode?: boolean
  /** Hosted (server-side key) vs BYOK (caller-supplied). The
   *  resolver in lib/server-ai-provider-resolver.ts uses this to pick
   *  the actual key + base URL + model id. */
  aiProviderMode?: "hosted" | "byok"
  /** Manual mode: per-task model overrides keyed by task slot
   *  (explain/root_cause/suggest/patch/bulk/verify). Two names exist
   *  for historical reasons — the v2 canonical key is
   *  ``manualModelSelection``; ``manualModels`` is the legacy alias
   *  from the Step-1 wiring and is accepted for backward compatibility. */
  manualModelSelection?: Record<string, string>
  manualModels?: import("@/lib/intelligence-mode").ManualOverrides
  /** apply only: the previewId the user reviewed. */
  previewId?: string
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

function coerceFinding(raw: Partial<PlannerFinding> | undefined): PlannerFinding | null {
  if (!raw || typeof raw !== "object") return null
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null
  const rule_id =
    typeof raw.rule_id === "string" && raw.rule_id.trim() ? raw.rule_id.trim() : null
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
    confidence_band: typeof raw.confidence_band === "string" ? raw.confidence_band : undefined,
    has_suggested_patch: !!raw.has_suggested_patch,
    evidence_path_files:
      typeof raw.evidence_path_files === "number" ? raw.evidence_path_files : undefined,
    evidence_path_len:
      typeof raw.evidence_path_len === "number" ? raw.evidence_path_len : undefined,
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url)
  const op = url.searchParams.get("mode") === "apply" ? "apply" : "preview"

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return bad("invalid JSON body")
  }
  if (!body.projectPath) return bad("projectPath is required")

  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(body.projectPath.trim())
  if (!isPathInside(resolved, allowRoot)) return bad("projectPath escapes scan root", 403)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return bad("projectPath is not a directory", 404)
  }

  const intelligenceMode: IntelligenceMode = body.intelligenceMode ?? "auto"
  const policy = MODE_POLICIES[intelligenceMode]
  const finding = coerceFinding(body.finding)
  if (!finding) return bad("valid finding is required")

  // ---- Guardrails: Save forbids patch generation; secrets never LLM. ----
  const guard = enforceGuardrails({
    mode: intelligenceMode,
    task: "patch",
    ruleId: finding.rule_id,
  })
  if (!guard.ok) {
    return NextResponse.json(
      {
        status: "refused",
        reason: guard.reason,
        intelligenceMode,
        hint:
          intelligenceMode === "save"
            ? "Save mode returns deterministic templates/suggestions only. Switch to Auto/Pro/Max to generate a patch."
            : undefined,
      },
      { status: 200 },
    )
  }

  /* ---------------------------- APPLY ---------------------------- */
  if (op === "apply") {
    if (!body.previewId) return bad("previewId is required for apply")
    const NS: CacheNamespace = "patch_previews"
    const previews = cacheList<PatchPreview>(resolved, NS)
    const preview = previews.find((p) => p && p.previewId === body.previewId)
    if (!preview) {
      return bad("preview not found or expired; re-run preview", 409)
    }
    // Real-fix gate: a suggestion-only preview can never be applied as a fix.
    // We re-check the unified diff per file so a multi-file preview with one
    // suggestion-only entry can't sneak through alongside a real change.
    const realFix = preview.patches.every(
      (p) => isRealFixDiff(preview.unifiedDiff, p.file).isRealFix,
    )
    if (!realFix) {
      return NextResponse.json(
        {
          status: "refused",
          reason:
            "patch is a suggestion only (comment/TODO/whitespace/no-op). It will not be applied as a fix.",
          previewId: preview.previewId,
        },
        { status: 200 },
      )
    }
    if (!preview.resolved) {
      return NextResponse.json(
        {
          status: "refused",
          reason: "re-scan did not clear the finding; refusing to mark as fixed",
          previewId: preview.previewId,
        },
        { status: 200 },
      )
    }

    const result = applyPatch({ projectPath: resolved, preview })
    if (!result.applied) {
      return NextResponse.json({ status: "refused", ...result }, { status: 200 })
    }
    // Post-apply re-scan = the true arbiter.
    let stillPresent = false
    try {
      const report = await runScannerOn(resolved, { timeoutMs: 90_000 })
      stillPresent = report.findings.some(
        (f) => f.rule_id === finding.rule_id && path.normalize(f.file) === path.normalize(finding.file),
      )
    } catch {
      stillPresent = false
    }
    return NextResponse.json({
      status: "applied",
      intelligenceMode,
      fixed: !stillPresent,
      reScanConfirmedFixed: !stillPresent,
      appliedFileHashes: result.appliedFileHashes,
      backupCreated: true,
    })
  }

  /* --------------------------- PREVIEW --------------------------- */
  // BYOK-only: the caller must supply provider/apiKey/baseUrl/model.
  // The resolver enforces plan gating + manual-mode policy and
  // returns the tuple to use upstream; missing/invalid keys return
  // a structured 400 with the canonical UX message.
  const aiProviderMode = "byok" as const
  // Normalise the manual-model picks: canonical name is
  // ``manualModelSelection``; ``manualModels`` is the legacy alias.
  // Accept either; pass both onwards.
  const manualPicks: Record<string, string> | undefined =
    (body.manualModelSelection && typeof body.manualModelSelection === "object"
      ? (body.manualModelSelection as Record<string, string>)
      : undefined) ??
    (body.manualModels && typeof body.manualModels === "object"
      ? (body.manualModels as Record<string, string>)
      : undefined)
  const complexity = scoreComplexity({
    rule_id: finding.rule_id,
    severity: finding.severity,
    evidencePathFiles: finding.evidence_path_files,
    evidencePathLen: finding.evidence_path_len,
  })
  const resolution = resolveAiProviderForRequest({
    userId: "local-user",
    workspaceId: "local-workspace",
    aiProviderMode,
    intelligenceMode,
    task: "patch",
    complexity,
    manualModelSelection: manualPicks,
    byokApiKey: typeof body.apiKey === "string" ? body.apiKey : null,
    byokBaseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    byokProvider: body.provider,
  })
  if (!resolution.ok) {
    const httpStatus =
      resolution.code === "missing_api_key" || resolution.code === "invalid_api_key"
        ? 400
        : 403
    return NextResponse.json(
      { status: "refused", reason: resolution.reason, code: resolution.code, upgrade: resolution.upgrade ?? false },
      { status: httpStatus },
    )
  }
  const provider = resolution.provider
  const apiKey = resolution.apiKey

  const plan = planFix(finding)

  // Save: no LLM patch; return the plan + suggestion guidance.
  if (!policy.allowPatchGeneration) {
    return NextResponse.json({
      status: "suggestion_only",
      intelligenceMode,
      plan,
      reason:
        "Save mode does not generate LLM patches. A deterministic template/suggestion is available via /api/findings/fix.",
    })
  }

  const preview: PatchResult = await generatePatchPreview({
    projectPath: resolved,
    finding,
    plan,
    provider,
    apiKey,
    baseUrl: resolution.baseUrl ?? null,
    privateCodeMode: !!body.privateCodeMode,
    intelligenceMode,
    complexity,
    manualModels: manualPicks as import("@/lib/intelligence-mode").ManualOverrides | undefined,
    // v2: lock the resolver's choice into the pipeline so the pipeline
    // can't silently re-route to a different model. ``forceModel`` /
    // ``forceTwoStep`` only override fields on the routing decision;
    // budget gates, ContextBundle build, and validation are unchanged.
    forceModel: resolution.model,
    forceTwoStep: resolution.twoStep,
  })

  if ("refused" in preview && preview.refused) {
    return NextResponse.json({ status: "refused", intelligenceMode, ...preview }, { status: 200 })
  }

  // BYOK-only: no credit consumption. The user's upstream provider
  // bills them directly. (The resolver still returns an
  // ``estimatedCostUsd`` for the UI to display, informational only.)

  const p = preview as PatchPreview
  // Stamp the suggestion/fix role from the real-fix gate so the UI can
  // render "Suggestion only" vs "Real fix candidate".
  const realFix = isRealFixDiff(p.unifiedDiff, p.patches[0]?.file ?? finding.file)
  return NextResponse.json({
    status: "preview",
    intelligenceMode,
    complexity,
    role: realFix.isRealFix && p.resolved ? "fix" : "suggestion",
    realFixReason: realFix.reason,
    preview: p,
  })
}
