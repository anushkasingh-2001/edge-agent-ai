/**
 * Model selection metadata (browser-side).
 *
 * Hosted-only contract: this module USED to manage user-supplied
 * provider API keys + base URLs in localStorage. Those have been
 * removed entirely. The browser:
 *
 *   - NEVER stores an `apiKey`.
 *   - NEVER stores a `baseUrl`.
 *   - NEVER sends a provider key on the wire.
 *
 * The only browser-side state that survives is:
 *   - Manual-mode model-id picks (per task slot). These are plain
 *     strings like `"claude-sonnet-4-6"` — not credentials.
 *   - The Anthropic stale-id migration helper, kept so any residual
 *     legacy localStorage data (from older BYOK builds) gets cleaned
 *     up gracefully on next boot.
 *
 * `purgeLegacyProviderKeys()` wipes any pre-hosted localStorage
 * entries on startup. Call it once from the top-level layout client
 * mount so users upgrading from BYOK builds don't carry stale secrets.
 */

export const PROVIDER_TYPES = ["openai_compatible", "anthropic", "google"] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  google: "Google",
}

export const SUPPORTED_PROVIDER_TYPES: ProviderType[] = [
  "openai_compatible",
  "anthropic",
  "google",
]

/** Legacy storage keys (provider configs + migration notices). */
const STORAGE_KEY = "edge-agent-ai.modelKeys"
const MIGRATION_NOTICE_KEY = "edge-agent-ai.modelKeys.migrationNotices"

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

// ---------------------------------------------------------------------------
// Anthropic legacy-model migration (kept — pure model-id rewrite, no secrets)
// ---------------------------------------------------------------------------

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6"

const ANTHROPIC_LEGACY_TO_CURRENT: Record<string, string> = {
  "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-6",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
  "claude-3-5-sonnet-20240620": "claude-sonnet-4-6",
  "claude-3-sonnet-20240229": "claude-sonnet-4-6",
  "claude-3-opus-20240229": "claude-opus-4-7",
  "claude-3-opus-latest": "claude-opus-4-7",
  "claude-3-haiku-20240307": "claude-haiku-4-5",
  "claude-3-5-haiku-latest": "claude-haiku-4-5",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "claude-opus-4-1-20250805": "claude-opus-4-7",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-6",
}

const ANTHROPIC_CURRENT_MODELS = new Set<string>([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
])

export function migrateAnthropicModel(model: string): {
  migrated: boolean
  oldModel: string
  newModel: string
} {
  const trimmed = (model ?? "").trim()
  if (!trimmed) {
    return { migrated: false, oldModel: trimmed, newModel: trimmed }
  }
  if (ANTHROPIC_CURRENT_MODELS.has(trimmed)) {
    return { migrated: false, oldModel: trimmed, newModel: trimmed }
  }
  const explicit = ANTHROPIC_LEGACY_TO_CURRENT[trimmed]
  if (explicit) {
    return { migrated: true, oldModel: trimmed, newModel: explicit }
  }
  if (/^claude[-_]/i.test(trimmed)) {
    return { migrated: true, oldModel: trimmed, newModel: ANTHROPIC_DEFAULT_MODEL }
  }
  return { migrated: false, oldModel: trimmed, newModel: trimmed }
}

export interface MigrationNotice {
  slot: LlmSlot
  oldModel: string
  newModel: string
  at: string
}

function readMigrationNotices(): MigrationNotice[] {
  if (!isBrowser()) return []
  try {
    const raw = window.localStorage.getItem(MIGRATION_NOTICE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (n): n is MigrationNotice =>
        !!n &&
        typeof n === "object" &&
        typeof (n as MigrationNotice).slot === "string" &&
        typeof (n as MigrationNotice).oldModel === "string" &&
        typeof (n as MigrationNotice).newModel === "string",
    )
  } catch {
    return []
  }
}

function writeMigrationNotices(notices: MigrationNotice[]): void {
  if (!isBrowser()) return
  try {
    if (notices.length === 0) {
      window.localStorage.removeItem(MIGRATION_NOTICE_KEY)
    } else {
      window.localStorage.setItem(MIGRATION_NOTICE_KEY, JSON.stringify(notices))
    }
  } catch { /* ignore quota */ }
}

export function consumeMigrationNotices(): MigrationNotice[] {
  const notices = readMigrationNotices()
  if (notices.length > 0) writeMigrationNotices([])
  return notices
}

// ---------------------------------------------------------------------------
// Legacy-key purge — wipes pre-hosted localStorage entries on startup
// ---------------------------------------------------------------------------

/**
 * Wipe any provider keys / base URLs left over from the BYOK era. On
 * first run after the hosted-only upgrade, this surfaces ONE migration
 * notice per stale Anthropic entry so the user sees "your saved
 * Anthropic model was updated…" and then drops the entire localStorage
 * slot so no apiKey survives on disk.
 *
 * Safe to call repeatedly: no-op after the slot is empty.
 */
export function purgeLegacyProviderKeys(): { purged: boolean; noticesAdded: number } {
  if (!isBrowser()) return { purged: false, noticesAdded: 0 }
  let raw: string | null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return { purged: false, noticesAdded: 0 }
  }
  if (!raw) return { purged: false, noticesAdded: 0 }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt — just drop it.
    try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
    return { purged: true, noticesAdded: 0 }
  }

  let noticesAdded = 0
  if (Array.isArray(parsed)) {
    const now = new Date().toISOString()
    const newNotices: MigrationNotice[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (e.type === "anthropic" && typeof e.model === "string") {
        const m = migrateAnthropicModel(e.model)
        if (m.migrated) {
          newNotices.push({ slot: "anthropic", oldModel: m.oldModel, newModel: m.newModel, at: now })
        }
      }
    }
    if (newNotices.length > 0) {
      const merged = [...readMigrationNotices(), ...newNotices]
      writeMigrationNotices(merged)
      noticesAdded = newNotices.length
    }
  }

  // Drop the entire slot. Anything that USED to live here (apiKey,
  // baseUrl, provider configs) is gone for good — the hosted contract
  // does not need any of it.
  try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
  return { purged: true, noticesAdded }
}

// ---------------------------------------------------------------------------
// Named provider slots — kept for the Manual-mode model picker UI
// ---------------------------------------------------------------------------

/**
 * The Settings page no longer renders these slots (no key fields), but
 * the Manual-mode model picker in the scan/findings toolbars still uses
 * the slot identity to organise the model dropdown. The constants are
 * pure presentational metadata — no secrets, no localStorage.
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
    defaultModel: "gpt-4.1-mini",
    runnerImplemented: true,
  },
  anthropic: {
    label: "Anthropic",
    type: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    runnerImplemented: true,
  },
  google: {
    label: "Gemini",
    type: "google",
    defaultModel: "gemini-2.0-flash",
    runnerImplemented: true,
  },
  custom: {
    label: "Custom",
    type: "openai_compatible",
    defaultModel: "llama3.1:8b",
    defaultBaseUrl: "http://localhost:11434/v1",
    runnerImplemented: true,
  },
}
