"use client"

/**
 * ModelSelector (Manual mode)
 *
 * Stores model choices as provider-qualified ids: `${slot}:${modelId}`.
 * Example: `anthropic:claude-sonnet-4-5-20250929`.
 *
 * The server accepts these real model ids end-to-end. Tier strings
 * (`cheap`, `mid`, `coding_flagship`, `local`) are still supported by
 * the resolver, but this UI intentionally sends model ids because the
 * user asked to manually choose the actual model.
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
  | "explain"
  | "root_cause"
  | "suggest"
  | "patch"
  | "bulk"
  | "verify"

export type ManualModelMap = Partial<Record<ManualTask, string>>

const TASKS: Array<{ id: ManualTask; label: string; hint: string }> = [
  { id: "explain", label: "Explanation", hint: "Cheap model is fine here" },
  { id: "root_cause", label: "Root-cause reasoning", hint: "Stronger helps on ambiguous flows" },
  { id: "suggest", label: "Suggestion", hint: "Mid tier is a good default" },
  { id: "patch", label: "Patch generation", hint: "Use your best coding model" },
  { id: "bulk", label: "Bulk fix", hint: "One call per cluster, not per finding" },
  { id: "verify", label: "Verifier", hint: "Cheap model; only validates" },
]

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
        Choose the exact model per task. Safety is still enforced on the server:
        graph-bounded context, secret redaction, token caps, validation, and no auto-apply.
      </p>
      {TASKS.map((t) => (
        <div key={t.id} className="grid grid-cols-[160px_1fr] items-center gap-3">
          <div className="grid">
            <Label className="text-xs font-medium">{t.label}</Label>
            <span className="text-[11px] text-muted-foreground">{t.hint}</span>
          </div>
          <Select value={value[t.id] ?? undefined} onValueChange={(v) => set(t.id, v)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Use mode default" />
            </SelectTrigger>
            <SelectContent>
              {availableSlots.map((slot) => (
                <SelectGroup key={slot}>
                  <SelectLabel className="text-[11px] uppercase">{slot}</SelectLabel>
                  {MODEL_CATALOG[slot].map((m) => (
                    <SelectItem key={`${slot}:${m.id}`} value={`${slot}:${m.id}`} className="text-xs">
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
