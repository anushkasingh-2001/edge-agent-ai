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
import { ChevronDown, FileText } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { exportScanReport } from "@/lib/export-report"
import type { Project } from "@/lib/projects"
import type { ScanReport } from "@/lib/scan-report"

interface ExportReportButtonProps {
  /** The scan to export. When null the button stays visible but disabled,
   * with a tooltip telling the user to run a scan first. */
  report: ScanReport | null
  project: Project | null
  branch?: string | null
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
 */
export function ExportReportButton({
  report,
  project,
  branch = null,
  variant = "outline",
  size = "sm",
  fullWidth = false,
}: ExportReportButtonProps) {
  const disabled = report === null
  const triggerClass = `gap-2 ${fullWidth ? "w-full" : ""}`

  const handleExport = (format: "json" | "markdown") => {
    if (!report) return
    exportScanReport(format, { project, branch, report })
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
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Export format
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleExport("json")}>
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleExport("markdown")}>
          Export as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
