/**
 * Browser-side storage for model provider configurations.
 *
 * Configurations live in `localStorage` under `STORAGE_KEY`. Each entry is a
 * single (provider, base URL, api key, default model) tuple — the same
 * provider can appear multiple times with different models so the user can
 * compare GPT-4o vs GPT-4o-mini with the same key.
 *
 * Security note: keys are kept in `localStorage`, which is acceptable for a
 * local dev tool but never appropriate for a multi-user deployment. The UI
 * masks the key by default and surfaces this trade-off in the Settings card.
 */

export const PROVIDER_TYPES = ["openai_compatible", "anthropic", "google"] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  google: "Google",
}

/**
 * All three providers now have a real runner in /api/playground/run:
 *   - openai_compatible: chat completions (also Ollama/Groq/Together via baseUrl)
 *   - anthropic: Messages API
 *   - google: Gemini generateContent
 * Listed here so anyone iterating on provider plumbing knows the
 * playground will dispatch to a real implementation for each.
 */
export const SUPPORTED_PROVIDER_TYPES: ProviderType[] = [
  "openai_compatible",
  "anthropic",
  "google",
]

export type ModelProviderConfig = {
  id: string
  type: ProviderType
  /** Friendly label shown in UI dropdowns. */
  label: string
  /** Default model id (e.g. "gpt-4o", "gpt-4o-mini"). */
  model: string
  /**
   * API key — never logged. Forwarded only to the configured provider or
   * to a local Edge Agent API route for the duration of a single request
   * (Prompt Playground, Chat Assistant, and the finding-explanation
   * endpoint). It is never persisted server-side, never written to the
   * explanation cache, and never included in error messages or telemetry.
   */
  apiKey: string
  /** Optional override for OpenAI-compatible endpoints (Together, Groq, Ollama, etc). */
  baseUrl?: string
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = "edge-agent-ai.modelKeys"

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function isConfig(v: unknown): v is ModelProviderConfig {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    PROVIDER_TYPES.includes(o.type as ProviderType) &&
    typeof o.label === "string" &&
    typeof o.model === "string" &&
    typeof o.apiKey === "string"
  )
}

function safeRead(): ModelProviderConfig[] {
  if (!isBrowser()) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isConfig)
  } catch {
    return []
  }
}

function safeWrite(configs: ModelProviderConfig[]): void {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(configs))
  } catch {
    // Quota exceeded is unrealistic for this small payload; swallow to avoid
    // crashing the UI on weird browser environments.
  }
}

export function loadProviderConfigs(): ModelProviderConfig[] {
  return [...safeRead()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function saveProviderConfig(config: ModelProviderConfig): ModelProviderConfig[] {
  const current = safeRead()
  const filtered = current.filter((c) => c.id !== config.id)
  safeWrite([config, ...filtered])
  return loadProviderConfigs()
}

export function deleteProviderConfig(id: string): ModelProviderConfig[] {
  const current = safeRead()
  safeWrite(current.filter((c) => c.id !== id))
  return loadProviderConfigs()
}

export function clearProviderConfigs(): void {
  if (!isBrowser()) return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function newProviderConfigId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Mask the key for display. Always shows the first 4 and last 4 characters so
 * the user can confirm a key without exposing it to a screen recording.
 */
export function maskKey(key: string): string {
  if (!key) return ""
  if (key.length <= 12) return "•".repeat(key.length)
  return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Named provider slots (Settings UX)
// ---------------------------------------------------------------------------

/**
 * The Settings page exposes a fixed set of named slots — OpenAI, Anthropic,
 * Gemini, and a custom OpenAI-compatible endpoint — so users see the
 * familiar provider names instead of a generic "add provider" form. Each
 * slot maps to a single `ModelProviderConfig` with a stable id, which means
 * the Prompt Playground / Chat Assistant continue to read from the same
 * underlying list.
 */
export const LLM_SLOTS = ["openai", "anthropic", "google", "custom"] as const
export type LlmSlot = (typeof LLM_SLOTS)[number]

export const SLOT_META: Record<
  LlmSlot,
  {
    label: string
    type: ProviderType
    /** Default model name shown in the placeholder. */
    defaultModel: string
    /** Default base URL — only meaningful for openai_compatible-typed slots. */
    defaultBaseUrl?: string
    /** Whether the slot's runner is implemented today. */
    runnerImplemented: boolean
  }
> = {
  openai: {
    label: "OpenAI",
    type: "openai_compatible",
    // gpt-4.1-mini is the Edge Agent AI default for finding explanations
    // (cheap, strong, widely entitled). Settings shows it as the placeholder
    // so a user who hasn't picked an explicit model lands on the same model
    // the server-side default would use.
    defaultModel: "gpt-4.1-mini",
    runnerImplemented: true,
  },
  anthropic: {
    label: "Anthropic",
    type: "anthropic",
    defaultModel: "claude-3-5-sonnet-latest",
    runnerImplemented: true,
  },
  google: {
    label: "Gemini",
    type: "google",
    defaultModel: "gemini-2.0-flash",
    runnerImplemented: true,
  },
  custom: {
    label: "Custom OpenAI-compatible",
    type: "openai_compatible",
    defaultModel: "llama3.1:8b",
    defaultBaseUrl: "http://localhost:11434/v1",
    runnerImplemented: true,
  },
}

export function slotConfigId(slot: LlmSlot): string {
  return `slot-${slot}`
}

/** Find the saved config for a named slot, if the user has filled it in. */
export function getSlotConfig(
  slot: LlmSlot,
  configs: ModelProviderConfig[]
): ModelProviderConfig | undefined {
  const id = slotConfigId(slot)
  return configs.find((c) => c.id === id)
}

/**
 * Pick the provider the chat assistant should default to. Order of
 * preference: OpenAI → Custom (OpenAI-compatible) → Anthropic → Gemini. We
 * skip configs whose runner isn't implemented yet so the default is always
 * usable when possible.
 */
export function pickPrimaryProvider(
  configs: ModelProviderConfig[]
): ModelProviderConfig | null {
  if (configs.length === 0) return null
  const order: LlmSlot[] = ["openai", "custom", "anthropic", "google"]
  for (const slot of order) {
    const c = getSlotConfig(slot, configs)
    if (c && SUPPORTED_PROVIDER_TYPES.includes(c.type)) return c
  }
  // Fall back to the first supported config (e.g. legacy entries from the
  // generic add-form built earlier).
  const supported = configs.find((c) => SUPPORTED_PROVIDER_TYPES.includes(c.type))
  if (supported) return supported
  return configs[0]
}
