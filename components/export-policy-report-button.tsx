"use client"

import { useEffect, useState } from "react"
import { ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { exportPolicyReport } from "@/lib/export-report"
import {
  getLatestPolicyResult,
  type LatestPolicyResult,
} from "@/lib/latest-policy-result"
import type { Project } from "@/lib/projects"

interface ExportPolicyReportButtonProps {
  /** Currently opened project — required to look up the latest policy
   *  result in localStorage. When null the button is disabled with a
   *  helpful tooltip. */
  project: Project | null
  /** Optional explicit override. When supplied the button uses this
   *  result directly instead of reading from localStorage — useful
   *  for callers that already hold the freshest payload in component
   *  state (e.g. the Branch Compare or PR-create dialogs). */
  result?: LatestPolicyResult | null
  /** Visual variant. Defaults to "default" (the app's teal primary) so
   *  the export reads as a real action — not a tertiary affordance.
   *  Pass "outline" if you need it to sit quietly inside a dense
   *  table or modal footer. */
  variant?: "default" | "outline" | "ghost"
  size?: "default" | "sm" | "icon"
  className?: string
  /** Render as a full-width button (used inside dialogs / sidebars). */
  fullWidth?: boolean
  /** Override the button label. Defaults to "Export Policy Report". */
  label?: string
}

/**
 * Drop-in "Export Policy Report" button. Reads the latest real policy
 * result from `edge-agent-ai.latestPolicyResult` (or the prop
 * override) and triggers a Markdown download. Disabled with a tooltip
 * when nothing's available — never silently no-ops.
 *
 * Subscribes to the storage event and our custom
 * `edge-agent-ai:policy-result-saved` event so the button enables
 * itself as soon as the user runs a gate, without remounting.
 */
export function ExportPolicyReportButton({
  project,
  result: explicitResult = null,
  variant = "default",
  size = "sm",
  className = "",
  fullWidth = false,
  label = "Export Policy Report",
}: ExportPolicyReportButtonProps) {
  const [cachedResult, setCachedResult] = useState<LatestPolicyResult | null>(
    null
  )

  useEffect(() => {
    if (explicitResult) return
    const refresh = () => {
      setCachedResult(getLatestPolicyResult(project?.path ?? null))
    }
    refresh()
    if (typeof window === "undefined") return
    const onStorage = (e: StorageEvent) => {
      if (e.key === "edge-agent-ai.latestPolicyResult") refresh()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener("edge-agent-ai:policy-result-saved", refresh)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("edge-agent-ai:policy-result-saved", refresh)
    }
  }, [project?.path, explicitResult])

  const result = explicitResult ?? cachedResult
  const disabled = !result || !result.policy?.evaluation
  const widthCls = fullWidth ? "w-full" : ""

  const handleClick = () => {
    if (!result || !result.policy.evaluation) return
    exportPolicyReport("markdown", {
      project,
      branch: result.targetBranch,
      scanReport: result.targetReport
        ? ({
            risk_score: result.targetReport.risk_score,
            summary: result.targetReport.summary,
            generated_at: result.targetReport.generated_at,
            findings: result.targetReport.findings,
          } as Parameters<typeof exportPolicyReport>[1]["scanReport"])
        : null,
      policy: result.policy,
      generatedAt: result.generatedAt,
      operation: result,
    })
  }

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={fullWidth ? "block w-full" : "inline-block"}>
              <Button
                variant={variant}
                size={size}
                className={`gap-2 ${widthCls} ${className}`}
                disabled
              >
                <ShieldCheck className={`h-4 w-4 ${fullWidth ? "mr-2" : ""}`} />
                {label}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            No policy result available. Run Branch Compare, Commit, Push, or
            Create PR gate first.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={`gap-2 ${widthCls} ${className}`}
      onClick={handleClick}
    >
      <ShieldCheck className={`h-4 w-4 ${fullWidth ? "mr-2" : ""}`} />
      {label}
    </Button>
  )
}
