"use client"

/**
 * IntelligenceModeToggle
 *
 * The five-mode selector shown in the scan/findings toolbar. Pure
 * presentational + a callback; the parent owns the selected mode and
 * passes it to the fix/explain APIs as `intelligenceMode`.
 *
 * These are ANALYSIS-EFFORT modes — deliberately named differently from
 * the billing PLANS (free/starter/pro/team). A mode is never gated by the
 * plan; a heavier mode simply spends more credits per fix/explain. The
 * wire IDs stay stable (save/auto/pro/max/manual) so the policy + routing
 * layers don't change — only the user-facing labels do.
 *
 *   save (Lite)        Deterministic + cheap explain. Lowest credit use.
 *   auto (Balanced)    Smart routing. Recommended everyday default.
 *   pro  (Deep)        Stronger model + larger graph. More credits.
 *   max  (Exhaustive)  Best model, plan→patch→validate. Most credits.
 *   manual (Custom)    Pick the model per task yourself.
 *
 * Custom mode reveals the <ModelSelector/> (separate component).
 */

import { Zap, Gauge, Sparkles, ShieldCheck, SlidersHorizontal, Lock } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
// Single source of truth: `lib/context-bundle.ts` defines the canonical
// `IntelligenceMode` type. Re-export it here so call sites that import
// the toggle don't have to know the lib path.
import type { IntelligenceMode } from "@/lib/context-bundle"
export type { IntelligenceMode }

const MODES: Array<{
  id: IntelligenceMode
  label: string
  icon: typeof Zap
  blurb: string
}> = [
  { id: "save", label: "Lite", icon: Zap, blurb: "Deterministic scanner truth + a cheap explanation only. No LLM patches. Lowest credit use." },
  { id: "auto", label: "Balanced", icon: Gauge, blurb: "Smart routing: cheap→strong only when it helps. Recommended everyday default." },
  { id: "pro", label: "Deep", icon: Sparkles, blurb: "Stronger model + larger code-graph neighborhood for high/critical findings. Spends more credits." },
  { id: "max", label: "Exhaustive", icon: ShieldCheck, blurb: "Best model with plan→patch→validate (parse/test/re-scan). PR-gate quality. Spends the most credits." },
  { id: "manual", label: "Custom", icon: SlidersHorizontal, blurb: "Pick the model per task yourself. Guardrails still enforced." },
]

/** Friendly mode label by wire ID — shared so every surface (toggle,
 *  settings, billing) shows the same effort-mode names. */
export const MODE_LABELS: Record<IntelligenceMode, string> = MODES.reduce(
  (acc, m) => {
    acc[m.id] = m.label
    return acc
  },
  {} as Record<IntelligenceMode, string>,
)

export function modeLabel(id: IntelligenceMode): string {
  return MODE_LABELS[id] ?? id
}

export interface IntelligenceModeToggleProps {
  value: IntelligenceMode
  onChange: (mode: IntelligenceMode) => void
  className?: string
  /** Modes the user may select. When provided, any mode NOT in this list
   *  renders locked (disabled styling + lock icon) and clicking it calls
   *  `onLockedModeClick` instead of `onChange`. When omitted, all modes
   *  are selectable (back-compat for callers that don't gate). */
  allowedModes?: IntelligenceMode[]
  /** Invoked when the user clicks a locked mode (e.g. navigate to the
   *  Plan & Billing page to subscribe / sign in). */
  onLockedModeClick?: (mode: IntelligenceMode) => void
  /** Tooltip shown on locked modes. */
  lockedMessage?: string
}

export function IntelligenceModeToggle({
  value,
  onChange,
  className,
  allowedModes,
  onLockedModeClick,
  lockedMessage = "Sign in to use AI modes (each mode spends credits; heavier modes spend more).",
}: IntelligenceModeToggleProps) {
  const isLocked = (id: IntelligenceMode): boolean =>
    Array.isArray(allowedModes) && !allowedModes.includes(id)

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
          const locked = isLocked(m.id)
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-disabled={locked}
                  data-locked={locked || undefined}
                  onClick={() => (locked ? onLockedModeClick?.(m.id) : onChange(m.id))}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    locked
                      ? "cursor-not-allowed text-muted-foreground/50 hover:text-muted-foreground/70"
                      : active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-background/60",
                  )}
                >
                  {locked ? <Lock className="size-3.5" /> : <Icon className="size-3.5" />}
                  <span>{m.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-56 text-xs">
                {locked ? lockedMessage : m.blurb}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
