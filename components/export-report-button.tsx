"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, FileText, ShieldCheck } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { exportPolicyReport, exportScanReport } from "@/lib/export-report"
import type { PolicyApiResponse } from "@/lib/policy-client"
import type { Project } from "@/lib/projects"
import type { ScanReport } from "@/lib/scan-report"

interface ExportReportButtonProps {
  /** The scan to export. When null the button stays visible but disabled,
   * with a tooltip telling the user to run a scan first. */
  report: ScanReport | null
  project: Project | null
  branch?: string | null
  /** Optional policy evaluation. When present the dropdown grows two
   *  extra options ("Export policy report (JSON/Markdown)") so users
   *  can hand the gate decision to reviewers / compliance. The buttons
   *  stay omitted (not just disabled) when there's no evaluation yet,
   *  to keep the menu small on first-run states. */
  policy?: PolicyApiResponse | null
  /** Visual variant — defaults to outline. */
  variant?: "default" | "outline"
  size?: "default" | "sm"
  /** Render as a full-width button (used inside the Scan Center sidebar). */
  fullWidth?: boolean
}

/**
 * Drop-in replacement for the static "Export Report" buttons. Offers JSON
 * and Markdown via a small dropdown. Disabled with explanatory tooltip when
 * no scan has been loaded yet — never silently no-ops.
 *
 * When a `policy` evaluation is also supplied the dropdown additionally
 * exposes "Export policy report" (JSON + Markdown). The policy export
 * captures decision + reasons + base-vs-target deltas — i.e. why the
 * gate fired — which is what compliance / PR reviewers actually need.
 */
export function ExportReportButton({
  report,
  project,
  branch = null,
  policy = null,
  variant = "outline",
  size = "sm",
  fullWidth = false,
}: ExportReportButtonProps) {
  const disabled = report === null
  const triggerClass = `gap-2 ${fullWidth ? "w-full" : ""}`
  const hasPolicyEvaluation = !!policy?.evaluation

  const handleExport = (format: "json" | "markdown") => {
    if (!report) return
    exportScanReport(format, { project, branch, report })
  }

  const handlePolicyExport = (format: "json" | "markdown") => {
    if (!policy?.evaluation) return
    exportPolicyReport(format, {
      project,
      branch,
      scanReport: report,
      policy,
      generatedAt: new Date().toISOString(),
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
                className={triggerClass}
                disabled
              >
                <FileText className={`h-4 w-4 ${fullWidth ? "mr-2" : ""}`} />
                Export Report
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            No scan report available. Run a scan first.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className={triggerClass}>
          <FileText className={`h-4 w-4 ${fullWidth ? "mr-2" : ""}`} />
          Export Report
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Scan report
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => handleExport("json")}>
          <FileText className="h-4 w-4" />
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("markdown")}>
          <FileText className="h-4 w-4" />
          Export as Markdown
        </DropdownMenuItem>
        {hasPolicyEvaluation && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Policy report
              <span className="ml-2 inline-flex items-center rounded-sm bg-secondary/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
                {policy?.evaluation?.decision ?? "—"}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => handlePolicyExport("json")}>
              <ShieldCheck className="h-4 w-4" />
              Export policy as JSON
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePolicyExport("markdown")}>
              <ShieldCheck className="h-4 w-4" />
              Export policy as Markdown
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
