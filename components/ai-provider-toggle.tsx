"use client"

/**
 * AiProviderToggle
 *
 * Hosted AI (included in plan, no key) vs BYOK (user's own key). Pure
 * presentational + callback; the parent owns the value and threads it
 * into every scan/explain/fix request as `aiProviderMode`.
 *
 * Hosted is the default. When Hosted is selected the parent hides API
 * key inputs and shows plan/credits; when BYOK is selected the parent
 * reveals provider/key settings.
 */

import { ServerCog, KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AiProviderMode } from "@/lib/context-bundle"

// Re-export so existing callers that imported the toggle's local
// declaration keep working without an import path migration.
export type { AiProviderMode }

export interface PlanInfo {
  tier: string
  creditsRemaining: number
  creditsTotal: number
}

export interface AiProviderToggleProps {
  value: AiProviderMode
  onChange: (mode: AiProviderMode) => void
  /** Plan summary for the Hosted card (credits). Optional. */
  plan?: PlanInfo | null
  className?: string
}

export function AiProviderToggle({ value, onChange, plan, className }: AiProviderToggleProps) {
  return (
    <div className={cn("grid gap-2 sm:grid-cols-2", className)}>
      <button
        type="button"
        aria-pressed={value === "hosted"}
        onClick={() => onChange("hosted")}
        className={cn(
          "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
          value === "hosted" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
        )}
      >
        <ServerCog className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Hosted AI</span>
          <span className="text-xs text-muted-foreground">
            Included in your plan — no API key needed.
          </span>
          {plan ? (
            <span className="mt-1 text-[11px] text-muted-foreground">
              {plan.tier} plan · {plan.creditsRemaining}/{plan.creditsTotal} credits left
            </span>
          ) : null}
        </div>
      </button>

      <button
        type="button"
        aria-pressed={value === "byok"}
        onClick={() => onChange("byok")}
        className={cn(
          "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
          value === "byok" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
        )}
      >
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Bring Your Own Key</span>
          <span className="text-xs text-muted-foreground">
            Use your own provider key (Settings). Calls bill your account.
          </span>
        </div>
      </button>
    </div>
  )
}
