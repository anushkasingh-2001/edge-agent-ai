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

/** Sentinel value for the "fall back to the mode default" option. Radix
 *  Select can't use an empty string, so we use this and clear the key. */
const DEFAULT_VALUE = "__mode_default__"

/**
 * The TIER each task falls back to when no model is picked. Mirrors
 * `MODE_POLICIES.manual` + `routeTaskForMode` in lib/intelligence-mode.ts:
 * explain → explainTier (cheap); patch/bulk → patchTier (coding_flagship);
 * everything else → reasonTier (mid).
 */
const DEFAULT_TIER_BY_TASK: Record<ManualTask, "cheap" | "mid" | "coding_flagship"> = {
  explain: "cheap",
  root_cause: "mid",
  suggest: "mid",
  patch: "coding_flagship",
  bulk: "coding_flagship",
  verify: "mid",
}

/**
 * Concrete in-package model each tier resolves to for Custom mode. Custom
 * prefers the OpenAI provider (see `providerPreferenceFor("manual")`) and
 * these mirror the hosted defaults in `tierModels()` (server-model-router.ts):
 * cheap → gpt-4.1-mini, mid/coding_flagship → gpt-4.1.
 */
const TIER_DEFAULT_MODEL: Record<"cheap" | "mid" | "coding_flagship", string> = {
  cheap: "GPT-4.1 mini",
  mid: "GPT-4.1",
  coding_flagship: "GPT-4.1",
}

function defaultModelLabel(task: ManualTask): string {
  return TIER_DEFAULT_MODEL[DEFAULT_TIER_BY_TASK[task]]
}

export interface ModelSelectorProps {
  availableSlots: LlmSlot[]
  value: ManualModelMap
  onChange: (next: ManualModelMap) => void
}

export function ModelSelector({ availableSlots, value, onChange }: ModelSelectorProps) {
  const set = (task: ManualTask, v: string) => {
    if (v === DEFAULT_VALUE) {
      // Clear the override so the task falls back to the mode default.
      const next = { ...value }
      delete next[task]
      onChange(next)
      return
    }
    onChange({ ...value, [task]: v })
  }

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Choose the exact model per task. Leave a task on{" "}
        <span className="font-medium text-foreground">Mode default</span> to use the in-package
        model for that step (shown in each dropdown). Safety is still enforced on the server:
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
              <SelectValue placeholder={`Mode default · ${defaultModelLabel(t.id)}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VALUE} className="text-xs">
                Mode default
                <span className="ml-2 text-muted-foreground">{defaultModelLabel(t.id)}</span>
              </SelectItem>
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
