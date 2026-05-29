/**
 * POST /api/finding/patch
 *
 * Generates (preview) or applies (apply) a single-finding fix under a
 * chosen intelligence mode. Hosted-only contract.
 *
 * Two operations selected by `?mode=preview` (default) or `?mode=apply`:
 *
 *   preview  Build a graph-bounded ContextBundle (NOT the whole file),
 *            route a model by intelligence mode + complexity, run the
 *            patch pipeline (model → temp workspace → parse → re-scan),
 *            score confidence, and return the preview. Never writes.
 *
 *   apply    Re-verify the file hash, back up, write, then re-scan.
 *            Only reachable after a preview the user reviewed.
 *
 * Hosted contract:
 *   - The request body NEVER carries `apiKey` / `baseUrl` / `provider`.
 *     Any such fields from a legacy client are silently ignored.
 *   - The provider credential is read server-side via
 *     `resolveAiProviderForRequest`. The response never echoes the key.
 *   - Authentication is asserted via `assertSession`.
 *   - Plan + per-mode + quota gates run BEFORE the upstream call.
 *
 * Hard invariants (unchanged from BYOK era):
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
import {
  assertHostedRequest,
  RouteGuardError,
} from "@/lib/server-route-guards"
import { generateFindingPatch } from "@/lib/server-patch-generation-gateway"

import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import {
  applyPatch,
  type PatchPreview,
  type PatchResult,
} from "@/lib/server-patch-pipeline"
import { cacheList, type CacheNamespace } from "@/lib/fix-cache"
import { runScannerOn } from "@/lib/server-scan"
import {
  MODE_POLICIES,
  scoreComplexity,
  enforceGuardrails,
} from "@/lib/intelligence-mode"
import type { IntelligenceMode } from "@/lib/context-bundle"
import { isRealFixDiff } from "@/lib/patch-confidence-realfix"

export const dynamic = "force-dynamic"
// This route runs on the desktop's local standalone server, where
// `maxDuration` is a no-op (no platform function timeout). The value only
// matters if the app is deployed to Vercel; 60 keeps such a deploy buildable
// on any plan (Hobby caps at 60s). AI generation itself is delegated to the
// cloud `/api/cloud/...` endpoints, so the long local pipeline is unaffected.
export const maxDuration = 60

interface PatchBody {
  projectPath?: string
  finding?: Partial<PlannerFinding>
  /** Intelligence mode (defaults to "auto"). */
  intelligenceMode?: IntelligenceMode
  /** Wire-level value retained for backward compat. Always treated as
   *  hosted; the resolver is hosted-only. */
  aiProviderMode?: "hosted" | "byok"
  privateCodeMode?: boolean
  /** Manual mode: per-task model overrides. Two names exist for
   *  historical reasons — canonical is ``manualModelSelection``;
   *  ``manualModels`` is the legacy alias. */
  manualModelSelection?: Record<string, string>
  manualModels?: import("@/lib/intelligence-mode").ManualOverrides
  /** apply only: the previewId the user reviewed. */
  previewId?: string
  /** Optional IR neighborhood for the bundle builder. */
  neighborhood?: import("@/lib/server-context-bundle").IRNeighborhoodInput
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
    agent: typeof raw.agent === "string" ? raw.agent : null,
    evidence_path: Array.isArray(raw.evidence_path)
      ? raw.evidence_path
          .filter(
            (n): n is { kind: string; label: string; file?: string | null; line?: number | null } =>
              !!n &&
              typeof (n as Record<string, unknown>).kind === "string" &&
              typeof (n as Record<string, unknown>).label === "string",
          )
          .map((n) => ({
            kind: n.kind,
            label: n.label,
            file: typeof n.file === "string" ? n.file : null,
            line: typeof n.line === "number" ? n.line : null,
          }))
      : undefined,
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

  let session
  try {
    session = assertHostedRequest(req, body as unknown as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
  }

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

  const plan = planFix(finding)

  // Save: no LLM patch; return the plan + suggestion guidance. (Decided
  // locally in BOTH web and desktop modes — no model call, so nothing to
  // delegate to the cloud.)
  if (!policy.allowPatchGeneration) {
    return NextResponse.json({
      status: "suggestion_only",
      intelligenceMode,
      plan,
      reason:
        "Save mode does not generate LLM patches. A deterministic template/suggestion is available via /api/findings/fix.",
    })
  }

  // Generation gateway: in-process (web) OR relayed to the cloud generation
  // endpoint (desktop). Either way the returned preview is validated in a
  // local temp workspace; apply still happens locally above.
  const gen = await generateFindingPatch({
    req,
    session,
    projectPath: resolved,
    finding,
    plan,
    intelligenceMode,
    complexity,
    manualModelSelection: manualPicks,
    privateCodeMode: !!body.privateCodeMode,
    neighborhood: body.neighborhood,
    task: "patch",
    cloudEndpoint: "/api/cloud/finding/patch-generate",
  })

  if (gen.blocked) {
    return NextResponse.json(
      {
        status: "refused",
        reason: gen.blocked.reason,
        code: gen.blocked.code,
        upgrade: gen.blocked.upgrade ?? false,
        remaining: gen.blocked.remaining,
        needed: gen.blocked.needed,
      },
      { status: gen.blocked.status },
    )
  }

  const preview = gen.preview as PatchResult

  if ("refused" in preview && preview.refused) {
    return NextResponse.json({ status: "refused", intelligenceMode, ...preview }, { status: 200 })
  }

  const p = preview as PatchPreview

  const realFix = isRealFixDiff(p.unifiedDiff, p.patches[0]?.file ?? finding.file)
  return NextResponse.json({
    status: "preview",
    intelligenceMode,
    complexity,
    role: realFix.isRealFix && p.resolved ? "fix" : "suggestion",
    realFixReason: realFix.reason,
    preview: p,
    // Hosted contract metadata (no key).
    apiKeySource: "hosted" as const,
    provider: gen.provider ?? "hosted",
    model: gen.model ?? p.modelUsed,
    creditsUsed: gen.creditsUsed,
    quotaRemaining: gen.quotaRemaining,
  })
}
