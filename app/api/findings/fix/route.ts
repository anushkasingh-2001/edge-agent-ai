import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  buildAndMaybeApplyFixes,
  type FixTarget,
  type FixMode,
} from "@/lib/server-finding-fixes"
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import { type PatchPreview } from "@/lib/server-patch-pipeline"
import { MODE_POLICIES, scoreComplexity } from "@/lib/intelligence-mode"
import type { IntelligenceMode } from "@/lib/context-bundle"
import type { FixProposal } from "@/lib/finding-fixes-client"
import {
  generateFindingPatch,
  type GatewayBlock,
} from "@/lib/server-patch-generation-gateway"
import {
  assertHostedRequest,
  RouteGuardError,
} from "@/lib/server-route-guards"

/**
 * POST /api/findings/fix  —  hosted-only contract.
 *
 * Body:
 *   {
 *     projectPath: string,
 *     mode: "suggest" | "apply",
 *     targets: [{ ref_id, rule_id, file, line, title? }, ...],
 *     intelligenceMode?: "save"|"auto"|"pro"|"max"|"manual",
 *     manualModelSelection?: Record<string,string>,
 *   }
 *
 * Returns the per-target FixProposal list. In `suggest` mode we never
 * touch the filesystem. In `apply` mode we write each file atomically
 * after dropping a `.edge-agent.bak` backup so the user can revert.
 *
 * The provider credential is read SERVER-SIDE from env via the hosted
 * resolver. The body NEVER carries `apiKey` / `baseUrl` / `provider` —
 * any such legacy fields are silently ignored.
 */
export async function POST(request: Request) {
  let body: {
    projectPath?: string
    mode?: FixMode
    targets?: unknown
    intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
    aiProviderMode?: "hosted" | "byok"
    manualModelSelection?: Record<string, string>
    manualModels?: Record<string, string>
    privateCodeMode?: boolean
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  let session
  try {
    session = assertHostedRequest(request, body as unknown as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
  }

  if (!body.projectPath || typeof body.projectPath !== "string") {
    return NextResponse.json(
      { error: "projectPath is required." },
      { status: 400 }
    )
  }
  if (body.mode !== "suggest" && body.mode !== "apply") {
    return NextResponse.json(
      { error: "mode must be either 'suggest' or 'apply'." },
      { status: 400 }
    )
  }
  if (!Array.isArray(body.targets) || body.targets.length === 0) {
    return NextResponse.json(
      { error: "targets must be a non-empty array." },
      { status: 400 }
    )
  }
  if (body.targets.length > 200) {
    return NextResponse.json(
      { error: "too many targets (max 200 per request)." },
      { status: 400 }
    )
  }

  const allowRoot = getScanAllowRoot()
  const requested = path.resolve(body.projectPath.trim())
  if (!isPathInside(requested, allowRoot)) {
    return NextResponse.json(
      { error: "projectPath is outside the allowed directory" },
      { status: 403 }
    )
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    return NextResponse.json(
      { error: "projectPath does not point to an existing directory" },
      { status: 404 }
    )
  }

  const targets: FixTarget[] = []
  for (const raw of body.targets as unknown[]) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    if (
      typeof r.ref_id !== "string" ||
      typeof r.rule_id !== "string" ||
      typeof r.file !== "string" ||
      typeof r.line !== "number" ||
      !Number.isFinite(r.line)
    ) {
      continue
    }
    targets.push({
      ref_id: r.ref_id,
      rule_id: r.rule_id,
      file: r.file,
      line: Math.max(1, Math.floor(r.line)),
      title: typeof r.title === "string" ? r.title : undefined,
    })
  }
  if (targets.length === 0) {
    return NextResponse.json(
      {
        error:
          "No valid targets after parsing. Each target needs ref_id, rule_id, file, and an integer line.",
      },
      { status: 400 }
    )
  }

  try {
    const result = buildAndMaybeApplyFixes({
      projectPath: requested,
      targets,
      mode: body.mode,
    })

    // ---- Mode-aware LLM upgrade -------------------------------------
    // Deterministic-first stays the source of truth. We invoke the
    // graph-routed pipeline ONLY for targets the deterministic engine
    // could NOT fix, only in "suggest" mode, only when the mode allows
    // LLM patches, and only when the hosted resolver clears plan +
    // quota. There is no client-supplied key path.
    const mode = (body.intelligenceMode ?? "auto") as IntelligenceMode
    const policy = MODE_POLICIES[mode] ?? MODE_POLICIES.auto
    const manualPicks = (body.manualModelSelection ?? body.manualModels) as
      | Record<string, string>
      | undefined

    // ---- LLM upgrade via the generation gateway -------------------
    // For unfixed targets we ask the gateway for a patch. In web/dev the
    // gateway resolves the key + calls the model in-process; on desktop it
    // relays a redacted prompt to /api/cloud/findings/fix-generate and the
    // cloud generates + bills. The first plan/quota/auth block surfaces as a
    // top-level error (deterministic proposals still attached) and stops.
    if (policy.allowPatchGeneration && body.mode === "suggest") {
      const unfixed = result.proposals.filter(
        (p) => !p.applied && (p.error_kind !== null || !p.diff || p.diff.trim() === ""),
      )
      let totalCreditsUsed = 0
      let topBlock: GatewayBlock | undefined
      for (const proposal of unfixed) {
        const target = targets.find((t) => t.ref_id === proposal.ref_id)
        if (!target) continue
        // secrets never goes to an LLM — leave the deterministic result.
        if (target.rule_id === "secrets") continue

        const finding: PlannerFinding = {
          id: target.ref_id,
          rule_id: target.rule_id,
          severity: "high", // conservative; real severity carried by scanner elsewhere
          category: "",
          file: target.file,
          line: target.line,
        }
        const complexity = scoreComplexity({
          rule_id: finding.rule_id,
          severity: finding.severity,
        })
        const gen = await generateFindingPatch({
          req: request,
          session,
          projectPath: requested,
          finding,
          plan: planFix(finding),
          intelligenceMode: mode,
          complexity,
          manualModelSelection: manualPicks,
          privateCodeMode: !!body.privateCodeMode,
          task: "patch",
          cloudEndpoint: "/api/cloud/findings/fix-generate",
        })
        if (gen.blocked) {
          topBlock = gen.blocked
          break
        }
        totalCreditsUsed += gen.creditsUsed
        const preview = gen.preview
        if (!preview || ("refused" in preview && preview.refused)) continue
        const pv = preview as PatchPreview

        const upgraded: Partial<FixProposal> = {
          title: `${proposal.title} (AI ${mode})`,
          description: pv.reason,
          after: pv.patches[0]?.newContents ?? proposal.after,
          diff: pv.unifiedDiff || proposal.diff,
          risk: pv.resolved ? "edits-line" : "no-op",
          error: pv.resolved ? null : "LLM patch did not clear the finding on re-scan",
          error_kind: pv.resolved ? null : proposal.error_kind,
        }
        Object.assign(proposal, upgraded)
      }
      if (topBlock) {
        return NextResponse.json({
          ...result,
          error: topBlock.reason,
          code: topBlock.code,
          upgrade: topBlock.upgrade ?? false,
          remaining: topBlock.remaining,
          needed: topBlock.needed,
        })
      }
      return NextResponse.json({
        ...result,
        apiKeySource: "hosted" as const,
        creditsUsed: totalCreditsUsed,
      })
    }

    return NextResponse.json({
      ...result,
      apiKeySource: "hosted" as const,
      creditsUsed: 0,
    })
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? `Fix engine failed: ${e.message}`
            : "Fix engine failed",
      },
      { status: 500 }
    )
  }
}
