/**
 * POST /api/byok/test
 *
 * Lightweight validator for the user's BYOK provider key. The Settings
 * page "Test key" button calls this with the form's current
 * provider/apiKey/baseUrl/model so the user gets immediate feedback
 * instead of waiting until the first explain/fix request.
 *
 * Behaviour:
 *   - Performs a single low-token, low-cost upstream call (chat
 *     completion / messages / generateContent) with the user's key.
 *   - Classifies the upstream response into:
 *       - "ok"               : 2xx
 *       - "invalid_api_key"  : 401/403 or upstream "invalid API key"
 *       - "model_unavailable": 404 or "model not found"
 *       - "network"          : timeout / DNS / unreachable
 *       - "other"            : everything else
 *   - Returns 200 in every case; the body's `ok` flag tells the UI
 *     what happened. The key is never logged or echoed back.
 *
 * The route is deliberately unauthenticated (local-only dev tool)
 * and forwards the caller's key in a single outbound request only.
 */

import { NextResponse } from "next/server"
import { BYOK_MESSAGES, classifyUpstreamFailure } from "@/lib/server-ai-provider-resolver"

export const dynamic = "force-dynamic"
export const maxDuration = 30

type ProviderKind = "openai_compatible" | "anthropic" | "google" | "custom"

interface TestBody {
  provider?: ProviderKind
  apiKey?: string
  baseUrl?: string
  model?: string
}

type TestOutcome =
  | {
      ok: true
      provider: ProviderKind
      model: string
      /** Non-fatal note (e.g. "key works but billing not enabled"). */
      warning?: string
    }
  | {
      ok: false
      code:
        | "missing_api_key"
        | "invalid_api_key"
        | "model_unavailable"
        | "billing_required"
        | "network"
        | "other"
      message: string
      /** Verbatim upstream error body so the UI can show the real
       *  provider message instead of a generic string. */
      upstream?: string
    }

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function testOpenAICompatible(
  apiKey: string,
  model: string,
  baseUrl: string | undefined,
): Promise<TestOutcome> {
  const base = (baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")
  let res: Response
  try {
    res = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    })
  } catch (e) {
    return { ok: false, code: "network", message: `Network error: ${(e as Error).message}` }
  }
  if (res.ok) return { ok: true, provider: "openai_compatible", model }
  let text = ""
  try {
    text = await res.text()
  } catch { /* ignore */ }
  const cls = classifyUpstreamFailure(res.status, text)
  if (cls.code === "invalid_api_key" || cls.code === "model_unavailable") {
    return { ok: false, code: cls.code, message: BYOK_MESSAGES.invalid }
  }
  return { ok: false, code: "other", message: `HTTP ${res.status}` }
}

/**
 * Anthropic-specific test. MUST use the Messages API (not OpenAI's
 * /v1/chat/completions). The real Anthropic error body is surfaced
 * verbatim to the UI so the user sees the actual upstream reason
 * (e.g. "credit balance is too low") instead of a generic line.
 */
async function testAnthropic(apiKey: string, model: string): Promise<TestOutcome> {
  let res: Response
  try {
    res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Say OK only" }],
      }),
    })
  } catch (e) {
    return { ok: false, code: "network", message: `Network error: ${(e as Error).message}` }
  }

  // Anthropic returns a useful error body for almost every failure
  // mode; grab it once and reuse for classification + UI surfacing.
  let bodyText = ""
  try {
    bodyText = await res.text()
  } catch { /* ignore */ }

  if (res.ok) return { ok: true, provider: "anthropic", model }

  // Try to extract the structured `{ error: { type, message } }`
  // Anthropic emits — fall back to the raw text otherwise.
  type AnthropicErrorBody = { error?: { type?: string; message?: string } }
  let parsed: AnthropicErrorBody | null = null
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as AnthropicErrorBody) : null
  } catch { /* not JSON */ }
  const upstreamMsg =
    parsed?.error?.message?.trim() || bodyText.trim() || `HTTP ${res.status}`
  const upstreamType = parsed?.error?.type ?? ""

  const lower = upstreamMsg.toLowerCase()
  // Anthropic's "credit balance is too low" / "spend limit" wording
  // — the key is technically valid but the account has no usable
  // billing headroom. Treat this as a billing-required failure so
  // the UI can show the exact message and the canonical next step
  // ("enable billing / increase the limit") rather than the
  // generic "API key invalid" line which would be misleading.
  if (
    upstreamType === "invalid_request_error" &&
    (lower.includes("credit") || lower.includes("spend limit") || lower.includes("billing"))
  ) {
    return {
      ok: false,
      code: "billing_required",
      message:
        "Anthropic API key works, but billing/credits or spend limit may not be enabled. " +
        `Anthropic says: ${upstreamMsg}`,
      upstream: upstreamMsg,
    }
  }

  // 401 / authentication_error → invalid key.
  if (res.status === 401 || upstreamType === "authentication_error") {
    return {
      ok: false,
      code: "invalid_api_key",
      message: `Anthropic rejected the key: ${upstreamMsg}`,
      upstream: upstreamMsg,
    }
  }
  // 403 / permission_error.
  if (res.status === 403 || upstreamType === "permission_error") {
    return {
      ok: false,
      code: "invalid_api_key",
      message: `Anthropic refused this key for the requested model: ${upstreamMsg}`,
      upstream: upstreamMsg,
    }
  }
  // 404 / model_not_found.
  if (res.status === 404 || upstreamType === "not_found_error" || lower.includes("model")) {
    return {
      ok: false,
      code: "model_unavailable",
      message: `Anthropic doesn't recognise the model id: ${upstreamMsg}`,
      upstream: upstreamMsg,
    }
  }

  // Anything else — surface the real Anthropic body so the user
  // sees the actual reason rather than a generic line. We
  // intentionally do NOT collapse to the canonical INVALID-key
  // string here; the spec is to show the upstream message.
  return {
    ok: false,
    code: "other",
    message: `Anthropic HTTP ${res.status}: ${upstreamMsg}`,
    upstream: upstreamMsg,
  }
}

async function testGemini(apiKey: string, model: string): Promise<TestOutcome> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`
  let res: Response
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 },
      }),
    })
  } catch (e) {
    return { ok: false, code: "network", message: `Network error: ${(e as Error).message}` }
  }
  if (res.ok) return { ok: true, provider: "google", model }
  let text = ""
  try {
    text = await res.text()
  } catch { /* ignore */ }
  const cls = classifyUpstreamFailure(res.status, text)
  if (cls.code === "invalid_api_key" || cls.code === "model_unavailable") {
    return { ok: false, code: cls.code, message: BYOK_MESSAGES.invalid }
  }
  return { ok: false, code: "other", message: `HTTP ${res.status}` }
}

export async function POST(req: Request) {
  let body: TestBody
  try {
    body = (await req.json()) as TestBody
  } catch {
    return NextResponse.json(
      { ok: false, code: "other", message: "Invalid JSON body." },
      { status: 400 },
    )
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, code: "missing_api_key", message: BYOK_MESSAGES.missing },
      { status: 200 },
    )
  }
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : null
  if (!model) {
    return NextResponse.json(
      { ok: false, code: "other", message: "Model id is required." },
      { status: 200 },
    )
  }
  const provider: ProviderKind = body.provider ?? "openai_compatible"
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || undefined : undefined

  let outcome: TestOutcome
  switch (provider) {
    case "anthropic":
      outcome = await testAnthropic(apiKey, model)
      break
    case "google":
      outcome = await testGemini(apiKey, model)
      break
    case "openai_compatible":
    case "custom":
    default:
      outcome = await testOpenAICompatible(apiKey, model, baseUrl)
      break
  }
  return NextResponse.json(outcome, { status: 200 })
}
