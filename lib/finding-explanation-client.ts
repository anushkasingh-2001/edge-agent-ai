/**
 * Client-side helper to fetch the AI-personalized finding explanation.
 *
 * Lives in `lib/` (not `components/`) so non-React callers can use the
 * same fetch shape.
 *
 * **Hosted-only contract.**
 *
 * The browser NEVER sends an `apiKey` / `baseUrl` / `provider` field.
 * Hosted AI credentials live server-side; the resolver picks them up
 * from env. The wire format here is intentionally minimal: project +
 * finding + intelligence mode + optional manual model selection.
 *
 * If hosted AI is temporarily unavailable (operator misconfig) or
 * quota is exhausted, the server returns a structured response the
 * drawer renders gracefully (template fallback for missing key,
 * upgrade prompt for plan/quota issues).
 *
 * Callers MUST only invoke this when the user opens a finding. Do NOT
 * call it from list-render code.
 */

import type { UiFinding } from "@/lib/scan-report"
import { apiFetch } from "@/lib/api-fetch"

export type ExplanationSource = "ai" | "cached_ai" | "template_fallback" | "unavailable"

export interface AIExplanationResponse {
  what_detected: string
  why_risky: string
  suggested_fix: string
  why_may_be_okay?: string
  what_to_verify?: string[]
  confidence_note?: string
  source: ExplanationSource
  model_used: string | null
  cached: boolean
  finding_id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  model_planned?: string | null
  /** Hosted contract metadata (never an apiKey). */
  apiKeySource?: "hosted"
  provider?: string
  creditsUsed?: number
  quotaRemaining?: number
  debug_error?: string
}

export interface ExplanationRequest {
  projectPath: string
  projectName?: string | null
  projectType?: string | null
  finding: UiFinding
  /** Optional source snippet for richer prompts. Caller trims to ≤10 lines. */
  codeSnippet?: string
  /** Intelligence mode, forwarded so the explainer model tier follows
   *  the selected mode (Save→cheap, Pro/Max→deep). */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Manual-mode per-task model picks. `manualModelSelection` is the
   *  canonical name; `manualModels` is the legacy alias accepted by
   *  older server builds. */
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  signal?: AbortSignal
}

/**
 * Hit the /api/finding/explain endpoint. Returns the parsed response
 * on 2xx. On non-2xx, throws an Error whose `.message` is the
 * server-provided error string when available.
 *
 * The request body NEVER carries `apiKey` / `baseUrl` / `provider`.
 * Hosted AI is included in the user's plan; the server resolves the
 * credential from env.
 */
export async function fetchFindingExplanation(req: ExplanationRequest): Promise<AIExplanationResponse> {
  const body = {
    projectPath: req.projectPath,
    projectName: req.projectName ?? null,
    projectType: req.projectType ?? null,
    // Hosted contract: omit any apiKey/baseUrl/provider/aiProviderMode
    // entirely. The server defaults to hosted.
    intelligenceMode: req.intelligenceMode,
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

  const res = await apiFetch("/api/finding/explain", {
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
