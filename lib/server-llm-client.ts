/**
 * Shared LLM client.
 *
 * Why this exists
 * ---------------
 * `lib/server-finding-explanations.ts` already contains a private
 * `callOpenAI()` that talks to an OpenAI-compatible `/chat/completions`
 * endpoint. The Fix Planner, model router, and patch pipeline all need
 * the SAME call mechanism, so rather than copy-paste it we extract one
 * tiny, shared caller that mirrors the existing pattern exactly:
 *
 *   - Bearer auth, key never echoed in errors.
 *   - `response_format: json_object` when we want structured output.
 *   - Low temperature (patch work must be deterministic-ish).
 *   - Hard timeout via AbortController.
 *
 * Provider scope (per integration brief §9)
 * -----------------------------------------
 * This client is INTENTIONALLY OpenAI-compatible only. We deliberately
 * do NOT silently route Anthropic or Google models through here — that
 * would either (a) hit a 404 because the request shape doesn't match
 * the provider's API, or (b) leak the user's Anthropic/Google key into
 * a wrong-provider call. The route layer is responsible for translating
 * Anthropic/Google provider configs into an OpenAI-compatible baseUrl
 * (LiteLLM, the official Anthropic OpenAI-compat shim, etc.) BEFORE
 * calling this client, or for short-circuiting to "template fallback"
 * when no OpenAI-compatible endpoint is configured. The `assertOpenAI
 * Compatible` helper below is the type-level + runtime guard that
 * enforces this contract — callers wire it into their config-parsing
 * path so the failure mode is a clear error message, not a mystery 404.
 *
 * This file deliberately has NO product logic. It is the single network
 * seam every AI fix feature funnels through, which also makes it the
 * one place to add retries, logging, and per-call cost accounting
 * later.
 */

import type { ProviderKind } from "./server-model-router"

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
const DEFAULT_TIMEOUT_MS = 45_000

export interface LlmCallOptions {
  /** Resolved model id (e.g. "gpt-4.1-mini"). Comes from the router. */
  model: string
  /** Provider key. BYOK — never falls back to a hardcoded key. */
  apiKey: string
  /** OpenAI-compatible base URL. Defaults to OpenAI; override for
   *  compat servers (Ollama, vLLM, LiteLLM, Anthropic OpenAI-compat). */
  baseUrl?: string | null
  /** System prompt. */
  system: string
  /** User prompt. */
  user: string
  /** Force structured JSON output. Default true for fix work. */
  json?: boolean
  /** 0–1. Default 0.1 — patch generation should be near-deterministic. */
  temperature?: number
  /** Cap worst-case output. Patches rarely need > 1500 tokens. */
  maxTokens?: number
  timeoutMs?: number
}

export type LlmResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string }

/* ------------------------------------------------------------------ *
 *  Provider guard                                                     *
 * ------------------------------------------------------------------ */

export interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl: string | null
}

/**
 * Guard: only `openai_compatible` and `custom` (OSS / OpenAI-compat
 * BYOK) talk through this client. Returns either a config you can pass
 * straight to `callLlm`, or an error message the caller can surface
 * verbatim. Never throws — the fix pipeline turns the error into a
 * `cannot_fix_safely` outcome with the reason, which is much friendlier
 * than a 500.
 *
 * For `anthropic` / `google` providers we require an explicit
 * `compatBaseUrl` (i.e. the user has set up a LiteLLM proxy or similar).
 * Without that, we refuse to call rather than pretend it works.
 */
export function assertOpenAICompatible(args: {
  provider: ProviderKind
  apiKey: string | undefined | null
  baseUrl: string | undefined | null
}):
  | { ok: true; config: OpenAICompatibleConfig }
  | { ok: false; error: string } {
  if (!args.apiKey) {
    return { ok: false, error: "missing_api_key" }
  }
  if (args.provider === "openai_compatible" || args.provider === "custom") {
    return {
      ok: true,
      config: { apiKey: args.apiKey, baseUrl: args.baseUrl ?? null },
    }
  }
  // Anthropic / Google: require an explicit OpenAI-compat base URL.
  // We don't ship a native client for these in the fix path because the
  // request shape differs (Anthropic Messages API, Gemini generateContent),
  // and getting it wrong silently is worse than refusing.
  if (!args.baseUrl) {
    return {
      ok: false,
      error: `provider_${args.provider}_requires_openai_compatible_baseUrl`,
    }
  }
  return {
    ok: true,
    config: { apiKey: args.apiKey, baseUrl: args.baseUrl },
  }
}

/* ------------------------------------------------------------------ *
 *  Wire                                                               *
 * ------------------------------------------------------------------ */

/** Redact anything resembling the key before it can land in an error. */
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

function extractAssistantText(json: unknown): string {
  if (!json || typeof json !== "object") return ""
  const choices = (json as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const first = choices[0] as Record<string, unknown>
  const msg = first?.message as Record<string, unknown> | undefined
  if (!msg) return ""
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
  }
  return ""
}

/**
 * One round-trip to an OpenAI-compatible chat endpoint. Returns the raw
 * assistant text (the caller parses JSON or extracts a diff). Errors
 * are returned, never thrown, and never contain the API key.
 */
export async function callLlm(opts: LlmCallOptions): Promise<LlmResult> {
  if (!opts.apiKey) return { ok: false, error: "missing_api_key" }

  const baseUrl = (opts.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, "")
  const url = `${baseUrl}/chat/completions`

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.1,
  }
  if (opts.json !== false) body.response_format = { type: "json_object" }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (e) {
    const msg = redactKey(e instanceof Error ? e.message : String(e), opts.apiKey)
    return { ok: false, error: `network_error: ${msg}` }
  }

  if (!resp.ok) {
    // Do not echo provider error bodies — some compat servers reflect
    // the request (with the Authorization header) back in the error.
    try {
      await resp.text()
    } catch {
      /* ignore */
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

  const text = extractAssistantText(json)
  if (!text) return { ok: false, error: "empty_model_reply" }
  return { ok: true, text, model: opts.model }
}

/** Safe JSON parse for model replies that *should* be a JSON object but
 *  may arrive fenced in ```json ... ``` despite response_format. */
export function parseJsonReply<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const start = cleaned.indexOf("{")
    const end = cleaned.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

/* ------------------------------------------------------------------ *
 *  Test seam                                                          *
 * ------------------------------------------------------------------ */

type Fetcher = typeof fetch
let _fetcher: Fetcher = ((input, init) =>
  globalThis.fetch(input as RequestInfo | URL, init)) as Fetcher

/** @internal Override the underlying fetch for tests. */
export function _setFetcherForTests(next: Fetcher | null): Fetcher {
  const prev = _fetcher
  _fetcher = (next ??
    ((input, init) => globalThis.fetch(input as RequestInfo | URL, init))) as Fetcher
  return prev
}
