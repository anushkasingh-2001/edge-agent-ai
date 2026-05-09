/**
 * Known model catalogs per LLM provider slot.
 *
 * Lives separately from `model-keys.ts` because the catalog is purely
 * presentational data (what to show in dropdowns) while `model-keys`
 * owns persistence semantics. UI components import from here so the
 * model picker is consistent across Settings, Prompt Playground, and
 * any future surface (Chat Assistant, batch runners, etc.).
 *
 * This list is deliberately curated, not auto-discovered:
 *   - Most providers don't expose a free "list public models" endpoint
 *     that the user wants us to ping on every page load with their key.
 *   - A short list is easier to reason about than 30 obscure preview SKUs.
 *   - Users can always type a model name we don't know about — every
 *     picker exposes a "Custom model name…" escape hatch.
 *
 * IMPORTANT: model identifiers below are stable strings the upstream
 * provider accepts in its API. Renaming one breaks every saved session.
 */

import type { LlmSlot } from "@/lib/model-keys"

export interface KnownModel {
  /** API id (e.g. "gpt-4o-mini"). Sent to the provider as-is. */
  id: string
  /** Friendly name shown in dropdowns. */
  label: string
  /** Optional one-liner shown as a description. */
  hint?: string
}

/**
 * Per-slot catalog. The "custom" slot is freeform on purpose — it points
 * at OpenAI-compatible endpoints (Ollama / Groq / Together / vLLM /
 * LiteLLM) where the model namespace varies wildly between users.
 */
export const MODEL_CATALOG: Record<LlmSlot, KnownModel[]> = {
  openai: [
    { id: "gpt-4o", label: "GPT-4o", hint: "Flagship multimodal" },
    { id: "gpt-4o-mini", label: "GPT-4o mini", hint: "Cheap, fast, 128k ctx" },
    { id: "gpt-4.1", label: "GPT-4.1", hint: "Frontier reasoning" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", hint: "Smaller GPT-4.1" },
    { id: "gpt-4.1-nano", label: "GPT-4.1 nano", hint: "Cheapest 4.1 tier" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", hint: "Legacy, cheap" },
    { id: "o4-mini", label: "o4-mini", hint: "Reasoning model" },
    { id: "o3-mini", label: "o3-mini", hint: "Reasoning model" },
  ],
  anthropic: [
    {
      id: "claude-opus-4-1-20250805",
      label: "Claude Opus 4.1",
      hint: "Most capable",
    },
    {
      id: "claude-sonnet-4-5-20250929",
      label: "Claude Sonnet 4.5",
      hint: "Balanced flagship",
    },
    {
      id: "claude-3-7-sonnet-latest",
      label: "Claude 3.7 Sonnet",
      hint: "Extended thinking",
    },
    {
      id: "claude-3-5-sonnet-latest",
      label: "Claude 3.5 Sonnet",
      hint: "Strong general-purpose",
    },
    {
      id: "claude-3-5-haiku-latest",
      label: "Claude 3.5 Haiku",
      hint: "Fast, cheap",
    },
    {
      id: "claude-3-opus-20240229",
      label: "Claude 3 Opus",
      hint: "Legacy flagship",
    },
  ],
  google: [
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      hint: "Flagship reasoning",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      hint: "Fast, cheap, 1M ctx",
    },
    {
      id: "gemini-2.0-flash",
      label: "Gemini 2.0 Flash",
      hint: "Stable, fast",
    },
    {
      id: "gemini-2.0-flash-lite",
      label: "Gemini 2.0 Flash-Lite",
      hint: "Cheapest",
    },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", hint: "Legacy 2M ctx" },
    {
      id: "gemini-1.5-flash",
      label: "Gemini 1.5 Flash",
      hint: "Legacy fast",
    },
  ],
  // Custom is freeform — we still seed a couple of common local-dev
  // model names so the dropdown isn't empty, but the user is expected
  // to type whatever their endpoint serves.
  custom: [
    { id: "llama3.1:8b", label: "llama3.1:8b (Ollama)" },
    { id: "llama3.3:70b", label: "llama3.3:70b (Ollama)" },
    { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b (Ollama)" },
    { id: "mixtral-8x7b-32768", label: "mixtral-8x7b (Groq)" },
  ],
}

/**
 * Look up a friendly label for an arbitrary model id (might be a
 * custom one the user typed). Falls back to the raw id so the UI
 * always renders something sensible.
 */
export function modelLabel(slot: LlmSlot, id: string): string {
  const found = MODEL_CATALOG[slot].find((m) => m.id === id)
  return found?.label ?? id
}

/** True when this id is in the curated catalog for the slot. */
export function isKnownModel(slot: LlmSlot, id: string): boolean {
  return MODEL_CATALOG[slot].some((m) => m.id === id)
}
