import path from "node:path"
import fs from "node:fs"
import { NextResponse } from "next/server"
import { getScanAllowRoot, isPathInside } from "@/lib/server-path-utils"
import {
  buildAndMaybeApplyFixes,
  type FixTarget,
  type FixMode,
} from "@/lib/server-finding-fixes"
// Step 2: mode-aware LLM delegation. When the mode allows LLM patches
// and the deterministic engine couldn't fix a target, we upgrade that
// target via the graph-routed pipeline (suggest only — apply still goes
// through the deterministic safe-write path).
import { planFix, type PlannerFinding } from "@/lib/fix-planner"
import { generatePatchPreview, type PatchPreview } from "@/lib/server-patch-pipeline"
import { MODE_POLICIES, scoreComplexity } from "@/lib/intelligence-mode"
import type { IntelligenceMode } from "@/lib/context-bundle"
import type { ProviderKind } from "@/lib/server-model-router"
import type { FixProposal } from "@/lib/finding-fixes-client"
import { resolveAiProviderForRequest } from "@/lib/server-ai-provider-resolver"

/**
 * POST /api/findings/fix
 *
 * Body:
 *   {
 *     projectPath: string,
 *     mode: "suggest" | "apply",
 *     targets: [{ ref_id, rule_id, file, line, title? }, ...]
 *   }
 *
 * Returns the per-target FixProposal list. In `suggest` mode we never
 * touch the filesystem. In `apply` mode we write each file atomically
 * after dropping a `.edge-agent.bak` backup so the user can revert
 * without git.
 */
export async function POST(request: Request) {
  let body: {
    projectPath?: string
    mode?: FixMode
    targets?: unknown
    /** Intelligence mode threaded from the UI (save/auto/pro/max/manual). */
    intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
    /** Hosted (server-side key) vs BYOK (caller-supplied). */
    aiProviderMode?: "hosted" | "byok"
    /** Manual mode: per-task model overrides. v2 canonical name is
     *  ``manualModelSelection``; ``manualModels`` is the Step-1 alias. */
    manualModelSelection?: Record<string, string>
    manualModels?: Record<string, string>
    /** Provider config for the LLM upgrade path (BYOK). Optional —
     *  when absent, the LLM delegation is skipped and the deterministic
     *  result is returned unchanged. */
    provider?: ProviderKind
    apiKey?: string | null
    baseUrl?: string | null
    privateCodeMode?: boolean
  } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const intelligenceMode = body.intelligenceMode ?? "auto"
  void intelligenceMode

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
    // Deterministic-first stays the source of truth. We only invoke
    // the graph-routed pipeline for targets the deterministic engine
    // could NOT fix (no template / comment-marker-only), and only
    // when:
    //   - mode allows patch generation (Save does not), AND
    //   - we're in "suggest" mode (apply keeps the deterministic safe
    //     write path; the LLM preview is reviewed, then applied via
    //     /api/finding/patch?mode=apply), AND
    //   - the caller supplied a BYOK key.
    //
    // If the user picks Auto/Pro/Max/Manual without a key in Settings,
    // we return the structured per-proposal error from the resolver
    // (so the UI can render the "API key not provided" CTA) instead
    // of silently doing nothing.
    const mode = (body.intelligenceMode ?? "auto") as IntelligenceMode
    const policy = MODE_POLICIES[mode] ?? MODE_POLICIES.auto
    const aiProviderMode = "byok" as const
    // Accept either canonical (`manualModelSelection`) or legacy
    // (`manualModels`) name from the client.
    const manualPicks = (body.manualModelSelection ?? body.manualModels) as
      | Record<string, string>
      | undefined

    // Surface the BYOK missing-key error at the top level if the
    // mode would have wanted an LLM upgrade. This is the canonical
    // UX path: the user picked Pro/Max/Manual and forgot the key.
    if (policy.allowPatchGeneration && body.mode === "suggest") {
      const probe = resolveAiProviderForRequest({
        userId: "local-user",
        workspaceId: "local-workspace",
        aiProviderMode,
        intelligenceMode: mode,
        task: "patch",
        complexity: 0,
        manualModelSelection: manualPicks,
        byokApiKey: typeof body.apiKey === "string" ? body.apiKey : null,
        byokBaseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
        byokProvider: body.provider,
      })
      if (
        !probe.ok &&
        (probe.code === "missing_api_key" || probe.code === "invalid_api_key")
      ) {
        // Deterministic proposals still ran above, so we attach the
        // structured error rather than dropping the whole response.
        // The UI shows the CTA AND the templates the engine could
        // fix without any LLM at all.
        return NextResponse.json({
          ...result,
          error: probe.reason,
          code: probe.code,
        })
      }
    }

    if (policy.allowPatchGeneration && body.mode === "suggest") {
      const unfixed = result.proposals.filter(
        (p) => !p.applied && (p.error_kind !== null || !p.diff || p.diff.trim() === ""),
      )
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
        const resolution = resolveAiProviderForRequest({
          userId: "local-user",
          workspaceId: "local-workspace",
          aiProviderMode,
          intelligenceMode: mode,
          task: "patch",
          complexity,
          manualModelSelection: manualPicks,
          byokApiKey: typeof body.apiKey === "string" ? body.apiKey : null,
          byokBaseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
          byokProvider: body.provider,
        })
        if (!resolution.ok) continue

        const preview = await generatePatchPreview({
          projectPath: requested,
          finding,
          plan: planFix(finding),
          provider: resolution.provider,
          apiKey: resolution.apiKey,
          baseUrl: resolution.baseUrl ?? null,
          privateCodeMode: !!body.privateCodeMode,
          intelligenceMode: mode,
          complexity,
          manualModels: manualPicks,
          forceModel: resolution.model,
          forceTwoStep: resolution.twoStep,
        })
        if ("refused" in preview && preview.refused) continue
        // BYOK-only: no credit accounting; user's upstream provider
        // bills them directly.
        const pv = preview as PatchPreview
        // Convert the PatchPreview into the FixProposal shape the UI
        // already renders. Marked not-applied (suggest); the user
        // promotes to a real write via the patch route.
        const upgraded: Partial<FixProposal> = {
          title: `${proposal.title} (AI ${mode})`,
          description: pv.reason,
          before: pv.patches[0]?.beforeFileHash ? proposal.before : proposal.before,
          after: pv.patches[0]?.newContents ?? proposal.after,
          diff: pv.unifiedDiff || proposal.diff,
          risk: pv.resolved ? "edits-line" : "no-op",
          error: pv.resolved ? null : "LLM patch did not clear the finding on re-scan",
          error_kind: pv.resolved ? null : proposal.error_kind,
        }
        Object.assign(proposal, upgraded)
      }
    }

    return NextResponse.json(result)
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
