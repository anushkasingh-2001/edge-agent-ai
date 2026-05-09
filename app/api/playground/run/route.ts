import { NextResponse } from "next/server"
import { z } from "zod"

/**
 * Server-side proxy for the Prompt Playground.
 *
 * Three providers are wired up: OpenAI-compatible chat completions,
 * Anthropic Messages, and Google Gemini generateContent. The route
 * accepts the API key + (for OpenAI-compat) base URL from the client
 * (read from localStorage), forwards a normalized request, and returns
 * a uniform shape: `{ ok, text, toolCalls, latencyMs, model, ... }`.
 *
 * Important: the route does NOT log the key. It also NEVER stores the
 * key on the server. The browser is the source of truth.
 */

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
})

/**
 * Tool definition the playground can hand to the model. Mirrors the
 * OpenAI function-calling shape so the upstream payload is just a
 * pass-through. Parameters default to an empty object schema, which is
 * fine because the playground only inspects *which* tool the model
 * picks, not the argument shape.
 */
const ToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  parameters: z.record(z.unknown()).optional(),
})

const RunRequestSchema = z.object({
  provider: z.enum(["openai_compatible", "anthropic", "google"]),
  apiKey: z.string().min(1, "apiKey is required"),
  model: z.string().min(1, "model is required"),
  baseUrl: z.string().url().optional(),
  messages: z.array(MessageSchema).min(1, "messages must be non-empty"),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(4096).optional(),
  /**
   * Optional list of tools to expose. When set, the model is allowed
   * (but not forced) to emit `tool_calls`. We surface those back to the
   * caller so the playground can assert which tool got picked.
   */
  tools: z.array(ToolSchema).max(64).optional(),
  /**
   * Tool choice hint. "auto" lets the model decide; "none" forbids
   * tool use; "required" forces the model to pick at least one tool
   * (only used when tools[] is non-empty). Defaults to "auto".
   */
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
})

type RunRequest = z.infer<typeof RunRequestSchema>
type Tool = z.infer<typeof ToolSchema>
type Msg = z.infer<typeof MessageSchema>

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
const ANTHROPIC_API_VERSION = "2023-06-01"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
const REQUEST_TIMEOUT_MS = 30_000

interface RunResult {
  ok: true
  text: string
  toolCalls: { name: string; argumentsJson: string }[]
  finishReason: string | null
  latencyMs: number
  model: string
  promptTokens?: number
  completionTokens?: number
}

interface RunError {
  ok: false
  status: number
  error: string
  latencyMs: number
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const parsed = RunRequestSchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ")
    return NextResponse.json({ error: `Invalid request: ${issues}` }, { status: 400 })
  }

  const req = parsed.data

  // Dispatch to per-provider runner. Each runner returns either a
  // success result (200) or a structured error so we never expose
  // upstream stack traces / headers. We still propagate the upstream
  // status so the UI can distinguish 401 (bad key) from 5xx.
  const result =
    req.provider === "openai_compatible"
      ? await runOpenAI(req)
      : req.provider === "anthropic"
      ? await runAnthropic(req)
      : await runGoogle(req)

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, status: result.status, latencyMs: result.latencyMs },
      { status: result.status >= 400 && result.status < 600 ? result.status : 502 }
    )
  }
  return NextResponse.json(result)
}

/* -------------------------------------------------------------------------- */
/* OpenAI / OpenAI-compatible                                                 */
/* -------------------------------------------------------------------------- */

async function runOpenAI(req: RunRequest): Promise<RunResult | RunError> {
  const trimmedBase = (req.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "")
  const url = `${trimmedBase}/chat/completions`
  const startedAt = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const upstream = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 1024,
        stream: false,
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: {
                  name: t.name,
                  description: t.description ?? "",
                  parameters: t.parameters ?? {
                    type: "object",
                    properties: {},
                  },
                },
              })),
              tool_choice: req.toolChoice ?? "auto",
            }
          : {}),
      }),
    })
    const latencyMs = Date.now() - startedAt
    const text = await upstream.text()
    if (!upstream.ok) {
      return upstreamErr(upstream.status, text, latencyMs)
    }

    type UpstreamToolCall = {
      id?: string
      type?: string
      function?: { name?: string; arguments?: string }
    }
    type UpstreamBody = {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: UpstreamToolCall[] }
        finish_reason?: string
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
      model?: string
    }
    let body: UpstreamBody
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, status: 502, error: "Upstream returned non-JSON response.", latencyMs }
    }

    const choice = body.choices?.[0]
    const content = choice?.message?.content ?? ""
    const toolCalls =
      (choice?.message?.tool_calls ?? [])
        .filter((c) => c.type === "function" && c.function?.name)
        .map((c) => ({
          name: c.function?.name as string,
          argumentsJson: c.function?.arguments ?? "",
        }))

    return {
      ok: true,
      text: content,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      latencyMs,
      model: body.model ?? req.model,
      promptTokens: body.usage?.prompt_tokens,
      completionTokens: body.usage?.completion_tokens,
    }
  } catch (e) {
    const latencyMs = Date.now() - startedAt
    if (ac.signal.aborted) {
      return { ok: false, status: 504, error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms.`, latencyMs }
    }
    const msg = e instanceof Error ? e.message : "Unknown error"
    return { ok: false, status: 502, error: `Network error: ${msg}`, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Anthropic Messages                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Anthropic uses a slightly different shape:
 *   - `system` is a top-level string, not part of `messages`.
 *   - Tools are `{ name, description, input_schema }` (no "type":"function" wrapper).
 *   - Tool calls come back as `content[]` blocks with `type: "tool_use"`.
 *   - `tool_choice` accepts `{ type: "auto" | "any" | "tool" | "none" }`.
 */
async function runAnthropic(req: RunRequest): Promise<RunResult | RunError> {
  // Pull out the (single) system message; Anthropic doesn't accept
  // role:"system" inside `messages`. We collapse multiple system
  // messages into one with newline separators to match common usage.
  const systems = req.messages.filter((m) => m.role === "system").map((m) => m.content)
  const conv = req.messages.filter((m) => m.role !== "system")
  if (conv.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Anthropic requires at least one user/assistant message.",
      latencyMs: 0,
    }
  }

  const startedAt = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const upstream = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": req.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        ...(systems.length > 0 ? { system: systems.join("\n") } : {}),
        messages: conv.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description ?? "",
                input_schema:
                  (t.parameters as Record<string, unknown> | undefined) ?? {
                    type: "object",
                    properties: {},
                  },
              })),
              tool_choice:
                req.toolChoice === "none"
                  ? { type: "none" as const }
                  : req.toolChoice === "required"
                  ? { type: "any" as const }
                  : { type: "auto" as const },
            }
          : {}),
      }),
    })
    const latencyMs = Date.now() - startedAt
    const text = await upstream.text()
    if (!upstream.ok) {
      return upstreamErr(upstream.status, text, latencyMs)
    }

    type AnthropicBlock =
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    type AnthropicBody = {
      content?: AnthropicBlock[]
      stop_reason?: string
      model?: string
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    let body: AnthropicBody
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, status: 502, error: "Anthropic returned non-JSON response.", latencyMs }
    }

    const blocks = body.content ?? []
    const textOut = blocks
      .filter((b): b is Extract<AnthropicBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
    const toolCalls = blocks
      .filter((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({
        name: b.name,
        argumentsJson: safeJsonStringify(b.input),
      }))

    return {
      ok: true,
      text: textOut,
      toolCalls,
      finishReason: body.stop_reason ?? null,
      latencyMs,
      model: body.model ?? req.model,
      promptTokens: body.usage?.input_tokens,
      completionTokens: body.usage?.output_tokens,
    }
  } catch (e) {
    const latencyMs = Date.now() - startedAt
    if (ac.signal.aborted) {
      return { ok: false, status: 504, error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms.`, latencyMs }
    }
    const msg = e instanceof Error ? e.message : "Unknown error"
    return { ok: false, status: 502, error: `Network error: ${msg}`, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Google Gemini                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Google Generative Language API. URL contains the model id and the
 * key as a query param. Schema:
 *   - `contents`: chat-style messages with `role` ("user" | "model")
 *     and `parts: [{text}]`.
 *   - `systemInstruction.parts: [{text}]` — separate from contents.
 *   - Function declarations: `tools: [{ functionDeclarations: [...] }]`.
 *   - Response: `candidates[0].content.parts[]` — each is a `{text}`
 *     or `{functionCall: {name, args}}`.
 */
async function runGoogle(req: RunRequest): Promise<RunResult | RunError> {
  const systems = req.messages.filter((m) => m.role === "system").map((m) => m.content)
  const conv = req.messages.filter((m) => m.role !== "system")
  if (conv.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Gemini requires at least one user/model message.",
      latencyMs: 0,
    }
  }

  // Map our role -> Gemini's: "user" stays, "assistant" becomes "model".
  const contents = conv.map((m: Msg) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  const url =
    `${GEMINI_BASE_URL}/${encodeURIComponent(req.model)}:generateContent` +
    `?key=${encodeURIComponent(req.apiKey)}`

  const startedAt = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const upstream = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        ...(systems.length > 0
          ? { systemInstruction: { parts: [{ text: systems.join("\n") }] } }
          : {}),
        generationConfig: {
          temperature: req.temperature ?? 0,
          maxOutputTokens: req.maxTokens ?? 1024,
        },
        ...(req.tools && req.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map((t: Tool) => ({
                    name: t.name,
                    description: t.description ?? "",
                    parameters:
                      (t.parameters as Record<string, unknown> | undefined) ?? {
                        type: "object",
                        properties: {},
                      },
                  })),
                },
              ],
              toolConfig: {
                functionCallingConfig: {
                  mode:
                    req.toolChoice === "none"
                      ? "NONE"
                      : req.toolChoice === "required"
                      ? "ANY"
                      : "AUTO",
                },
              },
            }
          : {}),
      }),
    })
    const latencyMs = Date.now() - startedAt
    const text = await upstream.text()
    if (!upstream.ok) {
      return upstreamErr(upstream.status, text, latencyMs)
    }

    type GeminiPart =
      | { text: string }
      | { functionCall: { name: string; args?: unknown } }
    type GeminiBody = {
      candidates?: Array<{
        content?: { parts?: GeminiPart[]; role?: string }
        finishReason?: string
      }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
      }
      modelVersion?: string
    }
    let body: GeminiBody
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, status: 502, error: "Gemini returned non-JSON response.", latencyMs }
    }

    const cand = body.candidates?.[0]
    const parts = cand?.content?.parts ?? []
    const textOut = parts
      .filter((p): p is { text: string } => "text" in p && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
    const toolCalls = parts
      .filter(
        (p): p is { functionCall: { name: string; args?: unknown } } =>
          "functionCall" in p && !!p.functionCall?.name
      )
      .map((p) => ({
        name: p.functionCall.name,
        argumentsJson: safeJsonStringify(p.functionCall.args ?? {}),
      }))

    return {
      ok: true,
      text: textOut,
      toolCalls,
      finishReason: cand?.finishReason ?? null,
      latencyMs,
      model: body.modelVersion ?? req.model,
      promptTokens: body.usageMetadata?.promptTokenCount,
      completionTokens: body.usageMetadata?.candidatesTokenCount,
    }
  } catch (e) {
    const latencyMs = Date.now() - startedAt
    if (ac.signal.aborted) {
      return { ok: false, status: 504, error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms.`, latencyMs }
    }
    const msg = e instanceof Error ? e.message : "Unknown error"
    return { ok: false, status: 502, error: `Network error: ${msg}`, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function upstreamErr(status: number, text: string, latencyMs: number): RunError {
  // Truncate the upstream body so a verbose 401 page can't blow up the
  // playground UI. Keep enough bytes to actually be useful for debugging.
  const truncated = text.slice(0, 500)
  return {
    ok: false,
    status,
    error: `Upstream returned ${status}: ${truncated || "(empty body)"}`,
    latencyMs,
  }
}

function safeJsonStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v)
  } catch {
    return ""
  }
}
