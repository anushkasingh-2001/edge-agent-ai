/**
 * Shared hosted-LLM caller for scan-time intelligence.
 *
 * Scope (per the scan-modes brief): OpenAI + Anthropic only. Gemini is
 * intentionally NOT required here. Provider selection is env-driven and
 * keyless calls are impossible — if no provider key is configured the
 * caller returns `{ ok: false, error: "no_provider" }` and the
 * orchestrator skips AI gracefully (deterministic findings still ship).
 *
 * Model IDs are NEVER hardcoded permanently. They come from
 * env-overridable defaults (spec section G):
 *
 *   EDGE_AGENT_ANTHROPIC_CHEAP_MODEL            (default claude-haiku-4-5)
 *   EDGE_AGENT_ANTHROPIC_MID_MODEL              (default claude-sonnet-4-6)
 *   EDGE_AGENT_ANTHROPIC_STRONG_MODEL           (default claude-sonnet-4-6)
 *   EDGE_AGENT_ANTHROPIC_EXHAUSTIVE_JUDGE_MODEL (default claude-opus-4-8)
 *   EDGE_AGENT_OPENAI_CHEAP_MODEL               (default gpt-5.4-mini)
 *   EDGE_AGENT_OPENAI_ULTRA_CHEAP_MODEL         (default gpt-5.4-nano)
 *   EDGE_AGENT_OPENAI_MID_MODEL                 (default gpt-5.4)
 *   EDGE_AGENT_OPENAI_STRONG_MODEL              (default gpt-5.5)
 *
 * This module does NOT meter credits — scan-time AI uses the configured
 * server provider key directly (billing is explicitly out of scope for
 * the scan-modes work). The single network call lives behind an
 * injectable fetch seam so tests are fully deterministic.
 */
import type { ScanTier } from "./scan-intelligence/mode-policy"

export type ScanProvider = "openai" | "anthropic"

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com/v1"
const ANTHROPIC_VERSION = "2023-06-01"
const DEFAULT_TIMEOUT_MS = 45_000

function envOr(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

/** Resolve a concrete model id for a provider + logical tier. */
export function resolveScanModel(provider: ScanProvider, tier: ScanTier): string {
  if (provider === "anthropic") {
    switch (tier) {
      case "cheap":
        return envOr("EDGE_AGENT_ANTHROPIC_CHEAP_MODEL", "claude-haiku-4-5")
      case "mid":
        return envOr("EDGE_AGENT_ANTHROPIC_MID_MODEL", "claude-sonnet-4-6")
      case "strong":
        return envOr("EDGE_AGENT_ANTHROPIC_STRONG_MODEL", "claude-sonnet-4-6")
      case "judge":
        return envOr(
          "EDGE_AGENT_ANTHROPIC_EXHAUSTIVE_JUDGE_MODEL",
          "claude-opus-4-8",
        )
    }
  }
  // OpenAI. No dedicated judge env var in the spec — the strong model
  // doubles as the judge so we never hardcode a separate id.
  switch (tier) {
    case "cheap":
      return envOr("EDGE_AGENT_OPENAI_CHEAP_MODEL", "gpt-5.4-mini")
    case "mid":
      return envOr("EDGE_AGENT_OPENAI_MID_MODEL", "gpt-5.4")
    case "strong":
      return envOr("EDGE_AGENT_OPENAI_STRONG_MODEL", "gpt-5.5")
    case "judge":
      return envOr("EDGE_AGENT_OPENAI_STRONG_MODEL", "gpt-5.5")
  }
}

export interface ResolvedScanProvider {
  provider: ScanProvider
  apiKey: string
  baseUrl: string
}

function resolveOpenAi(): ResolvedScanProvider | null {
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").trim()
  if (!openaiKey) return null
  return {
    provider: "openai",
    apiKey: openaiKey,
    baseUrl: envOr("EDGE_AGENT_HOSTED_OPENAI_BASE_URL", DEFAULT_OPENAI_BASE),
  }
}

function resolveAnthropic(): ResolvedScanProvider | null {
  const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? "").trim()
  if (!anthropicKey) return null
  return {
    provider: "anthropic",
    apiKey: anthropicKey,
    baseUrl: envOr("EDGE_AGENT_HOSTED_ANTHROPIC_BASE_URL", DEFAULT_ANTHROPIC_BASE),
  }
}

/**
 * Pick a configured provider, honouring a preference order.
 *
 * `prefer` lets the orchestrator route by mode:
 *   - Deep / Exhaustive prefer Anthropic (stronger strong/judge tiers)
 *     when ANTHROPIC_API_KEY is set, falling back to OpenAI.
 *   - Lite / Balanced stay cheap-first and prefer OpenAI, falling back to
 *     Anthropic.
 *
 * Returns null when neither key is set — the caller skips AI gracefully.
 */
export function resolveScanProvider(
  prefer: ScanProvider = "openai",
): ResolvedScanProvider | null {
  const order: ScanProvider[] =
    prefer === "anthropic" ? ["anthropic", "openai"] : ["openai", "anthropic"]
  for (const p of order) {
    const resolved = p === "anthropic" ? resolveAnthropic() : resolveOpenAi()
    if (resolved) return resolved
  }
  return null
}

export interface ScanLlmRequest {
  provider: ScanProvider
  apiKey: string
  baseUrl: string
  model: string
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export type ScanLlmResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string }

/** Redact anything resembling the key before it lands in an error. */
function redactKey(input: string, key: string | undefined): string {
  if (!key) return input
  return input.split(key).join("[redacted-key]")
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await _fetcher(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractOpenAiText(json: unknown): string {
  if (!json || typeof json !== "object") return ""
  const choices = (json as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const msg = (choices[0] as Record<string, unknown>)?.message as
    | Record<string, unknown>
    | undefined
  if (!msg) return ""
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
  }
  return ""
}

function extractAnthropicText(json: unknown): string {
  if (!json || typeof json !== "object") return ""
  const content = (json as Record<string, unknown>).content
  if (!Array.isArray(content)) return ""
  return content
    .map((p) => {
      const part = p as Record<string, unknown>
      return typeof part.text === "string" ? part.text : ""
    })
    .join("")
}

/**
 * One JSON round-trip to OpenAI (`/chat/completions`) or Anthropic
 * (`/v1/messages`). Returns the raw assistant text; the caller parses
 * JSON. Errors are returned, never thrown, and never contain the key.
 */
export async function callScanLlm(req: ScanLlmRequest): Promise<ScanLlmResult> {
  if (!req.apiKey) return { ok: false, error: "missing_api_key" }
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let url: string
  let headers: Record<string, string>
  let body: Record<string, unknown>

  if (req.provider === "anthropic") {
    url = `${req.baseUrl.replace(/\/+$/, "")}/messages`
    headers = {
      "Content-Type": "application/json",
      "x-api-key": req.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    }
    body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1500,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }
    // `temperature` is deprecated on the newest judge models (e.g.
    // claude-opus-4-8 rejects ANY temperature). Only send it when a caller
    // explicitly asks; otherwise use the model default.
    if (req.temperature !== undefined) body.temperature = req.temperature
  } else {
    url = `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${req.apiKey}`,
    }
    body = {
      model: req.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }
    // OpenAI's gpt-5 family rejects `max_tokens` (requires
    // `max_completion_tokens`) and only accepts the default temperature
    // (omitting `temperature` keeps us compatible across gpt-4o/4.1/5.x).
    // Older models still accept `max_completion_tokens`, so this is safe.
    if (req.maxTokens) body.max_completion_tokens = req.maxTokens
  }

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs,
    )
  } catch (e) {
    const msg = redactKey(e instanceof Error ? e.message : String(e), req.apiKey)
    return { ok: false, error: `network_error: ${msg}` }
  }

  if (!resp.ok) {
    try {
      await resp.text()
    } catch {
      /* ignore — never echo provider error bodies (may reflect auth header). */
    }
    return { ok: false, error: `model_http_${resp.status}` }
  }

  let json: unknown
  try {
    json = await resp.json()
  } catch (e) {
    return {
      ok: false,
      error: `bad_response_json: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  const text =
    req.provider === "anthropic" ? extractAnthropicText(json) : extractOpenAiText(json)
  if (!text) return { ok: false, error: "empty_model_reply" }
  return { ok: true, text, model: req.model }
}

/* ------------------------------------------------------------------ *
 *  Test seam                                                          *
 * ------------------------------------------------------------------ */

type Fetcher = typeof fetch
let _fetcher: Fetcher = ((input, init) =>
  globalThis.fetch(input as RequestInfo | URL, init)) as Fetcher

/** @internal Override the underlying fetch for tests. Returns prev. */
export function _setScanFetcherForTests(next: Fetcher | null): Fetcher {
  const prev = _fetcher
  _fetcher = (next ??
    ((input, init) => globalThis.fetch(input as RequestInfo | URL, init))) as Fetcher
  return prev
}
