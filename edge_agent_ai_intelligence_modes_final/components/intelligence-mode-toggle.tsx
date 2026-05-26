"use client"

/**
 * IntelligenceModeToggle
 *
 * The five-mode selector shown in the scan/findings toolbar. Pure
 * presentational + a callback; the parent owns the selected mode and
 * passes it to the fix/explain APIs as `intelligenceMode`.
 *
 *   save    Deterministic + Explain (cheapest)
 *   auto    Smart Routing (recommended default)
 *   pro     High Accuracy
 *   max     Deep Review (PR gate)
 *   manual  Select Model
 *
 * Manual mode reveals the <ModelSelector/> (separate component).
 */

import { Zap, Gauge, Sparkles, ShieldCheck, SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type IntelligenceMode = "save" | "auto" | "pro" | "max" | "manual"

const MODES: Array<{
  id: IntelligenceMode
  label: string
  icon: typeof Zap
  blurb: string
}> = [
  { id: "save", label: "Save Resources", icon: Zap, blurb: "Deterministic scanner truth + cheap explanation only. No LLM patches." },
  { id: "auto", label: "Auto", icon: Gauge, blurb: "Smart routing: cheap→strong only when it helps. Recommended." },
  { id: "pro", label: "Pro", icon: Sparkles, blurb: "Stronger model + larger graph neighborhood for high/critical findings." },
  { id: "max", label: "Max", icon: ShieldCheck, blurb: "Best model, plan→patch→validate (parse/test/re-scan). PR-gate quality." },
  { id: "manual", label: "Manual", icon: SlidersHorizontal, blurb: "Choose a model per task. Guardrails still enforced." },
]

export interface IntelligenceModeToggleProps {
  value: IntelligenceMode
  onChange: (mode: IntelligenceMode) => void
  className?: string
}

export function IntelligenceModeToggle({
  value,
  onChange,
  className,
}: IntelligenceModeToggleProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="radiogroup"
        aria-label="Analysis mode"
        className={cn(
          "inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1",
          className,
        )}
      >
        {MODES.map((m) => {
          const Icon = m.icon
          const active = value === m.id
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onChange(m.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/60",
                  )}
                >
                  <Icon className="size-3.5" />
                  <span>{m.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-56 text-xs">
                {m.blurb}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
