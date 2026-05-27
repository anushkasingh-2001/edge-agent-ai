/**
 * Client-side helper to fetch the AI-personalized finding explanation.
 *
 * Lives in `lib/` (not `components/`) so non-React callers (e.g. a future
 * standalone detail page) can use the same fetch shape.
 *
 * **BYOK-only.** Key resolution order:
 *   1. Explicit `apiKey` passed by the caller (tests / power-users).
 *   2. The user-configured Settings key for the matching provider slot.
 *      Read from `localStorage` via `loadProviderConfigs()`.
 *
 * If neither yields a key, the request still goes out without one and
 * the server returns the canonical "API key not provided. Add your
 * provider key in Settings…" error — there is NO env / hosted fallback
 * in MVP. The scanner's structured `reason` is still rendered via the
 * template fallback so the drawer never goes blank.
 *
 * Important: callers MUST only invoke this when the user opens a finding.
 * Do NOT call it from list-render code; the cost guardrails in the API
 * route still apply but the policy is clearest if the only caller is the
 * drawer/detail open effect.
 */

import type { UiFinding } from "@/lib/scan-report"
import {
  getSlotConfig,
  loadProviderConfigs,
  type ModelProviderConfig,
} from "@/lib/model-keys"

export type ExplanationSource = "ai" | "cached_ai" | "template_fallback" | "unavailable"

export interface AIExplanationResponse {
  /** Always present — populated by AI on success, by the template
   * fallback otherwise. The drawer shows these three sections always. */
  what_detected: string
  why_risky: string
  suggested_fix: string
  /** Only populated when `source` is "template_fallback" or "unavailable".
   * The drawer renders them only in that case so AI-success state shows
   * exactly three sections (what / why / fix). */
  why_may_be_okay?: string
  what_to_verify?: string[]
  confidence_note?: string
  source: ExplanationSource
  model_used: string | null
  cached: boolean
  /** Re-stamped by the route — the client can diff these against the
   * original finding to prove the AI layer did not modify scanner data. */
  finding_id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  model_planned?: string | null
  /** Dev-only diagnostic populated when the AI call failed and we fell
   * back to the template (e.g. "model_http_404"). The server strips this
   * in production builds and always redacts any literal key substring. */
  debug_error?: string
}

export interface ExplanationRequest {
  projectPath: string
  projectName?: string | null
  projectType?: string | null
  finding: UiFinding
  /** Optional source snippet for richer prompts. Caller trims to ≤10 lines. */
  codeSnippet?: string
  /** Caller-supplied OpenAI key. When omitted, the helper first tries the
   * server env (via the route's own fallback) and then the browser-stored
   * Settings → OpenAI slot. */
  apiKey?: string | null
  /** Caller-supplied base URL. When omitted, the helper inherits the
   * baseUrl saved alongside the OpenAI slot (used for OpenAI-compatible
   * endpoints like Together / Groq / local Ollama). */
  baseUrl?: string | null
  /** Caller-supplied model id. Honoured by the server only when paired
   * with a caller-supplied apiKey (i.e. the browser-settings flow). */
  model?: string | null
  /** Intelligence mode, forwarded so the explainer model tier follows
   *  the selected mode (Save→cheap, Pro/Max→deep). */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Hosted (server-side key) vs BYOK (caller-supplied). */
  aiProviderMode?: "hosted" | "byok"
  /** Manual-mode per-task model picks. ``manualModelSelection`` is the
   *  v2 canonical name; ``manualModels`` is the Step-1 legacy alias. */
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Find an OpenAI-compatible provider config the user has saved in Settings.
 *
 * Strategy (matches Prompt Playground's default-provider logic):
 *   * Prefer the dedicated "openai" slot.
 *   * Fall back to the "custom" slot when it's an OpenAI-compatible config
 *     (Ollama / Together / Groq via baseUrl).
 *
 * Returns `null` when no key is configured, when called server-side, or
 * when the saved key is empty. The Anthropic / Gemini slots are skipped
 * intentionally — the explain route only speaks the OpenAI chat-completions
 * dialect today.
 */
export function getBrowserOpenAIKey(): {
  apiKey: string
  baseUrl?: string
  model?: string
} | null {
  if (typeof window === "undefined") return null
  let configs: ModelProviderConfig[]
  try {
    configs = loadProviderConfigs()
  } catch {
    return null
  }
  const openai = getSlotConfig("openai", configs)
  if (openai?.apiKey?.trim()) {
    return {
      apiKey: openai.apiKey.trim(),
      baseUrl: openai.baseUrl?.trim() || undefined,
      model: openai.model?.trim() || undefined,
    }
  }
  const custom = getSlotConfig("custom", configs)
  if (custom?.apiKey?.trim() && custom.type === "openai_compatible") {
    return {
      apiKey: custom.apiKey.trim(),
      baseUrl: custom.baseUrl?.trim() || undefined,
      model: custom.model?.trim() || undefined,
    }
  }
  return null
}

/**
 * Hit the /api/finding/explain endpoint. Returns the parsed response on 2xx.
 * On non-2xx, throws an Error whose `.message` is the server-provided error
 * string when available.
 */
export async function fetchFindingExplanation(req: ExplanationRequest): Promise<AIExplanationResponse> {
  // Resolve the browser-stored Settings key ONLY if the caller didn't
  // pass one explicitly. When neither path yields a key we send no
  // `apiKey` field and the server returns the canonical
  // `missing_api_key` error — there is NO env / hosted fallback in
  // MVP. The key is attached to this single fetch and never persisted
  // by either side; the model field is forwarded so the server uses
  // the user's Settings choice instead of the cost-control default.
  const browser = req.apiKey ? null : getBrowserOpenAIKey()
  const apiKey = req.apiKey ?? browser?.apiKey ?? undefined
  const baseUrl = req.baseUrl ?? browser?.baseUrl ?? undefined
  const model = req.model ?? browser?.model ?? undefined

  const body = {
    projectPath: req.projectPath,
    projectName: req.projectName ?? null,
    projectType: req.projectType ?? null,
    apiKey,
    baseUrl,
    model,
    intelligenceMode: req.intelligenceMode,
    aiProviderMode: req.aiProviderMode,
    // Send both names so older and newer server builds both accept it.
    manualModelSelection: req.manualModelSelection ?? req.manualModels,
    manualModels: req.manualModelSelection ?? req.manualModels,
    finding: {
      finding_id: req.finding.scannerFindingId ?? String(req.finding.id),
      rule_id: req.finding.ruleId ?? "unknown",
      severity: req.finding.severity,
      category: req.finding.category,
      title: req.finding.title,
      file: req.finding.file,
      line: req.finding.line,
      agent: req.finding.agent,
      reason: req.finding.reason,
      suggested_fix: req.finding.suggestedFix,
      evidence: req.finding.evidence,
      code_snippet: clampSnippet(req.codeSnippet ?? req.finding.code),
      evidence_path: req.finding.evidencePath ?? [],
      agent_reachable: !isPresenceWarning(req.finding.category),
    },
  }

  const res = await fetch("/api/finding/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    let detail = ""
    try {
      const j = (await res.json()) as { error?: string }
      detail = j?.error ?? ""
    } catch {
      /* swallow */
    }
    throw new Error(detail || `Explanation request failed: HTTP ${res.status}`)
  }
  return (await res.json()) as AIExplanationResponse
}

function clampSnippet(input: string | undefined): string {
  if (!input) return ""
  const lines = input.split(/\r?\n/).slice(0, 10)
  return lines.join("\n").slice(0, 2_000)
}

/** Mirror of the server-side category check; used to set agent_reachable. */
export function isPresenceWarning(category: string): boolean {
  const c = (category || "").toLowerCase()
  return c.includes("presence warning") || c === "dangerous code present"
}

/** Human-readable badge label for the explanation source. */
export function explanationSourceBadge(source: ExplanationSource): string {
  switch (source) {
    case "ai":
      return "AI explanation"
    case "cached_ai":
      return "Cached AI explanation"
    case "template_fallback":
      return "Template fallback"
    case "unavailable":
      return "Template fallback"
  }
}

export function explanationSourceTone(source: ExplanationSource): "ai" | "fallback" {
  return source === "ai" || source === "cached_ai" ? "ai" : "fallback"
}
