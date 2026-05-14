"use client"

import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Check, ChevronDown, Lightbulb, Wrench } from "lucide-react"
import { FindingFixDialog } from "@/components/finding-fix-dialog"
import type { FixMode, FixTarget, RunFixesResult } from "@/lib/finding-fixes-client"

interface FindingFixButtonProps {
  /** Targets the dropdown's actions will run against. */
  targets: FixTarget[]
  projectPath: string | null
  /** Dropdown label (e.g. "Fix this", "Fix all", "Fix code"). */
  label?: string
  /** Header text inside the resulting dialog. */
  dialogTitle?: string
  /** Visual size of the trigger. */
  size?: "default" | "sm" | "icon" | "lg"
  /** Variant for the trigger button. */
  variant?: "default" | "outline" | "secondary" | "ghost"
  /** Disable when the caller has no targets. */
  disabled?: boolean
  className?: string
  onApplied?: (result: RunFixesResult) => void
}

/**
 * One reusable trigger for the three "Fix" menus in the Findings view.
 *
 *   - "Provide suggestion" opens the dialog in `suggest` mode (no
 *     writes; user can promote to apply via the dialog footer button).
 *   - "Fix it" opens the dialog in `apply` mode (writes to disk
 *     immediately, with .edge-agent.bak backups left behind).
 *
 * Both options end up in the same `FindingFixDialog`, so the diff
 * renderer and per-proposal drilldown stay consistent everywhere.
 */
export function FindingFixButton({
  targets,
  projectPath,
  label = "Fix code",
  dialogTitle,
  size = "sm",
  variant = "outline",
  disabled = false,
  className,
  onApplied,
}: FindingFixButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<FixMode>("suggest")

  const trigger = (mode: FixMode) => {
    setDialogMode(mode)
    setDialogOpen(true)
  }

  const effectiveDisabled =
    disabled || targets.length === 0 || projectPath === null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size={size}
            disabled={effectiveDisabled}
            className={className}
            title={
              effectiveDisabled
                ? targets.length === 0
                  ? "No findings selected"
                  : "Open a project to enable fixes"
                : undefined
            }
          >
            <Wrench className="h-3.5 w-3.5 mr-1.5" />
            {label}
            <ChevronDown className="h-3.5 w-3.5 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs">
            How should we apply the fix?
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => trigger("suggest")}
            className="gap-2"
          >
            <Lightbulb className="h-4 w-4 text-yellow-400" />
            <div className="flex flex-col">
              <span>Provide suggestion</span>
              <span className="text-[10px] text-muted-foreground">
                Preview the patch — nothing written
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => trigger("apply")} className="gap-2">
            <Check className="h-4 w-4 text-emerald-400" />
            <div className="flex flex-col">
              <span>Fix it</span>
              <span className="text-[10px] text-muted-foreground">
                Apply now (.edge-agent.bak backup is left next to each file)
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FindingFixDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        targets={targets}
        mode={dialogMode}
        projectPath={projectPath}
        title={dialogTitle ?? label}
        onApplied={onApplied}
      />
    </>
  )
}
