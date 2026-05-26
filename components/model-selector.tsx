"use client"

/**
 * ModelSelector (Manual mode)
 *
 * Claude/Cursor-style per-task model picker. The user assigns a model
 * to each task; the server still enforces all guardrails (graph-bounded
 * context, redaction, token caps, validation, no auto-apply) regardless
 * of choice.
 *
 * Tasks:
 *   explanation · root cause · suggestion · patch generation · bulk fix · verifier
 *
 * Models come from `MODEL_CATALOG` (lib/model-catalog.ts) for whichever
 * providers the user has configured in Settings. This component is
 * presentational; the parent persists the chosen map and forwards it to
 * the fix/explain APIs as `manualModels`.
 */

import { MODEL_CATALOG } from "@/lib/model-catalog"
import type { LlmSlot } from "@/lib/model-keys"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"

export type ManualTask =
  | "explanation"
  | "root_cause"
  | "suggestion"
  | "patch"
  | "bulk"
  | "verifier"

export type ManualModelMap = Partial<Record<ManualTask, string>>

const TASKS: Array<{ id: ManualTask; label: string; hint: string }> = [
  { id: "explanation", label: "Explanation", hint: "Cheap model is fine here" },
  { id: "root_cause", label: "Root-cause reasoning", hint: "Stronger helps on ambiguous flows" },
  { id: "suggestion", label: "Suggestion", hint: "Mid tier is a good default" },
  { id: "patch", label: "Patch generation", hint: "Use your best coding model" },
  { id: "bulk", label: "Bulk fix (per cluster)", hint: "One call per cluster, not per finding" },
  { id: "verifier", label: "Verifier (LLM judge)", hint: "Cheap model; only validates" },
]

/** Configured slots the user has keys for. Parent passes this in. */
export interface ModelSelectorProps {
  availableSlots: LlmSlot[]
  value: ManualModelMap
  onChange: (next: ManualModelMap) => void
}

export function ModelSelector({ availableSlots, value, onChange }: ModelSelectorProps) {
  const set = (task: ManualTask, model: string) =>
    onChange({ ...value, [task]: model })

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Choose a model per task. Safety is enforced on the server regardless of
        selection: graph-bounded context, secret redaction, token caps, patch
        validation, and no auto-apply.
      </p>
      {TASKS.map((t) => (
        <div key={t.id} className="grid grid-cols-[160px_1fr] items-center gap-3">
          <div className="grid">
            <Label className="text-xs font-medium">{t.label}</Label>
            <span className="text-[11px] text-muted-foreground">{t.hint}</span>
          </div>
          <Select value={value[t.id] ?? ""} onValueChange={(v) => set(t.id, v)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Use mode default" />
            </SelectTrigger>
            <SelectContent>
              {availableSlots.map((slot) => (
                <SelectGroup key={slot}>
                  <SelectLabel className="text-[11px] uppercase">{slot}</SelectLabel>
                  {MODEL_CATALOG[slot].map((m) => (
                    <SelectItem key={`${slot}:${m.id}`} value={m.id} className="text-xs">
                      {m.label}
                      {m.hint ? <span className="ml-2 text-muted-foreground">{m.hint}</span> : null}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  )
}
