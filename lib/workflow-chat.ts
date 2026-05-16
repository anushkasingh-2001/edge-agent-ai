/**
 * Workflow chat — talk to a real LLM about the analyzed repo.
 *
 * Provider abstractions for the "Ask about this repo" feature. Each provider
 * exposes the same `chat()` shape:
 *
 *   chat({ model, system, history, question, signal }) →
 *     { answer, latencyMs, usage? }
 *
 * Keys are read from `process.env` (no UI for keys yet — matches the rest
 * of the app's security model). Each provider returns a clear error string
 * when its key is missing so the UI can surface "set OPENAI_API_KEY" hints.
 *
 * We use plain `fetch` against each provider's REST API to keep the
 * dependency footprint small (no openai/anthropic/google SDKs). All three
 * providers have stable HTTPS endpoints we can hit directly.
 */

import type { WorkflowAnalysis } from "./workflow-types"

/* ------------------------------------------------------------------------- */
/* Types                                                                     */
/* ------------------------------------------------------------------------- */

export type ChatProvider = "openai" | "anthropic" | "gemini"

export type ChatTurn = { role: "user" | "assistant"; content: string }

export type ChatRequest = {
  provider: ChatProvider
  model: string
  question: string
  /** Multi-turn history. We send last N turns; route caps for token safety. */
  history: ChatTurn[]
  /** Pre-built system prompt summarising the workflow. */
  system: string
  /**
   * Per-request API key. The client reads this from the user's Settings page
   * (browser localStorage) and forwards it on every call — the server NEVER
   * persists it. When this is missing we fall back to the matching
   * `process.env.*_API_KEY` so power users can also set keys in `.env.local`.
   */
  apiKey?: string
  /** OpenAI-compatible base URL override (Ollama, Together, Groq, etc.). */
  baseUrl?: string
  /** Aborts the upstream fetch if the API request itself is cancelled. */
  signal?: AbortSignal
}

export type ChatResponse = {
  answer: string
  provider: ChatProvider
  model: string
  latencyMs: number
}

export class ChatProviderError extends Error {
  /** HTTP status to return to the client. 400 = config issue, 502 = upstream. */
  public readonly status: number
  /** Stable code the UI can switch on. */
  public readonly code:
    | "missing_key"
    | "bad_request"
    | "upstream_error"
    | "rate_limited"
    | "timeout"
    | "unknown"

  constructor(
    message: string,
    code: ChatProviderError["code"],
    status: number
  ) {
    super(message)
    this.name = "ChatProviderError"
    this.code = code
    this.status = status
  }
}

/* ------------------------------------------------------------------------- */
/* Catalogue of providers + their default model lists                        */
/* ------------------------------------------------------------------------- */

/**
 * UI-facing catalogue. The "models" list is what populates the dropdown;
 * users can also type a custom model id in the input field on the client
 * side, so this list doesn't need to be exhaustive.
 *
 * IDs verified against each provider's docs as of May 2026.
 */
export const PROVIDER_CATALOGUE: {
  id: ChatProvider
  label: string
  envKey: string
  docsUrl: string
  defaultModel: string
  models: { id: string; label: string; hint?: string }[]
}[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    envKey: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.4-mini",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", hint: "Most capable (slow, expensive)" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", hint: "Balanced — recommended" },
      { id: "gpt-5.4-nano", label: "GPT-5.4 nano", hint: "Fastest, cheapest" },
      { id: "gpt-4o", label: "GPT-4o", hint: "Older but proven" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", hint: "Older fallback" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "Most capable" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "Balanced — recommended" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "Fastest, cheapest" },
    ],
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    envKey: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3-flash",
    models: [
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", hint: "Most capable" },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", hint: "Balanced — recommended" },
      {
        id: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash-Lite",
        hint: "Cheapest, lowest latency",
      },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Older fallback" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Older fallback" },
    ],
  },
]

/* ------------------------------------------------------------------------- */
/* System prompt builder                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Render the workflow analysis into a compact system prompt. The goal is
 * "everything the model needs to answer 95% of repo questions, in <= 12k
 * characters".
 *
 * We *don't* paste full prompt bodies or tool function source — those would
 * blow the token budget. Instead we send names, files, variables, risk
 * tags. If the user needs more depth they can open the relevant file in
 * the IDE.
 */
export function buildWorkflowSystemPrompt(analysis: WorkflowAnalysis): string {
  const parts: string[] = []

  parts.push(
    `You are a senior software engineer helping answer questions about a specific repository called "${analysis.projectName}".`,
    `Your knowledge of this repo is strictly limited to the structured workflow analysis below. Do NOT invent files, functions, prompts, models, or behaviours that aren't listed.`,
    `If the user asks something the analysis can't answer, say so plainly and point them to the closest related file you do see.`,
    `Cite source files in backticks (e.g. \`src/foo.py\`) whenever possible — every fact you state should be anchored to a file from the analysis.`,
    `Be concise: 3–6 sentences for simple questions, a short bulleted list for "list X" questions, and a small numbered walkthrough for "how does X work" questions.`,
    ""
  )

  parts.push("=== WORKFLOW ANALYSIS ===")
  parts.push(`Project path: ${analysis.projectPath}`)
  parts.push(`Files scanned: ${analysis.stats.filesScanned}`)
  parts.push("")

  // Summary (already markdown — keep as-is for the model).
  if (analysis.summary) {
    parts.push("--- Plain-English summary ---")
    parts.push(analysis.summary)
    parts.push("")
  }

  // Entry points.
  parts.push(`--- Entry points (${analysis.entrypoints.length}) ---`)
  if (analysis.entrypoints.length === 0) parts.push("(none detected)")
  else
    for (const e of analysis.entrypoints) {
      parts.push(`- ${e.reason} — ${e.file}${typeof e.line === "number" ? `:${e.line}` : ""}`)
    }
  parts.push("")

  // Components grouped by type.
  parts.push(`--- Components (${analysis.components.length}) ---`)
  const byType = new Map<string, typeof analysis.components>()
  for (const c of analysis.components) {
    const k = c.type
    const arr = byType.get(k) ?? []
    arr.push(c)
    byType.set(k, arr)
  }
  for (const [type, list] of byType) {
    parts.push(`### ${type} (${list.length})`)
    // Cap at 40 per type to control prompt size.
    const capped = list.slice(0, 40)
    for (const c of capped) {
      const line = typeof c.line === "number" ? `:${c.line}` : ""
      const fw = c.framework ? ` [${c.framework}]` : ""
      const io =
        c.inputs.length > 0 || c.outputs.length > 0
          ? ` (in: ${c.inputs.slice(0, 5).join(", ") || "—"}; out: ${c.outputs.slice(0, 5).join(", ") || "—"})`
          : ""
      parts.push(`- ${c.name} — ${c.file}${line}${fw}${io}`)
    }
    if (list.length > capped.length)
      parts.push(`- (+${list.length - capped.length} more ${type}s omitted)`)
  }
  parts.push("")

  // Prompts.
  parts.push(`--- Prompts (${analysis.prompts.length}) ---`)
  if (analysis.prompts.length === 0) parts.push("(no prompts detected)")
  else {
    const capped = analysis.prompts.slice(0, 30)
    for (const p of capped) {
      const line = typeof p.line === "number" ? `:${p.line}` : ""
      const vars =
        p.variables.length > 0 ? ` — variables: ${p.variables.slice(0, 6).join(", ")}` : ""
      const preview =
        p.contentPreview && p.contentPreview.length > 0
          ? ` — preview: "${truncate(p.contentPreview.replace(/\s+/g, " "), 160)}"`
          : ""
      parts.push(`- ${p.name} — ${p.file}${line}${vars}${preview}`)
    }
    if (analysis.prompts.length > capped.length)
      parts.push(`- (+${analysis.prompts.length - capped.length} more prompts omitted)`)
  }
  parts.push("")

  // Tools — include risk tags so dangerous-tool questions can be answered.
  parts.push(`--- Tools / callable functions (${analysis.tools.length}) ---`)
  if (analysis.tools.length === 0) parts.push("(no tools detected)")
  else {
    const capped = analysis.tools.slice(0, 40)
    for (const t of capped) {
      const line = typeof t.line === "number" ? `:${t.line}` : ""
      const params =
        t.parameters.length > 0 ? ` (${t.parameters.slice(0, 6).join(", ")})` : "()"
      const risks = t.riskTags.length > 0 ? ` ⚠ RISK: ${t.riskTags.join(", ")}` : ""
      const fx =
        t.sideEffects.length > 0
          ? ` — side effects: ${t.sideEffects.slice(0, 3).map((s) => truncate(s, 60)).join("; ")}`
          : ""
      parts.push(`- ${t.name}${params} — ${t.file}${line}${risks}${fx}`)
    }
    if (analysis.tools.length > capped.length)
      parts.push(`- (+${analysis.tools.length - capped.length} more tools omitted)`)
  }
  parts.push("")

  // Model calls.
  parts.push(`--- LLM / model calls (${analysis.modelCalls.length}) ---`)
  if (analysis.modelCalls.length === 0) parts.push("(no LLM calls detected)")
  else
    for (const m of analysis.modelCalls.slice(0, 30)) {
      const line = typeof m.line === "number" ? `:${m.line}` : ""
      parts.push(
        `- ${m.provider}${m.model ? ` (${m.model})` : ""} — ${m.file}${line}`
      )
    }
  parts.push("")

  // MCP / OpenAPI configs.
  if (analysis.mcpConfigs.length > 0 || analysis.openApiSpecs.length > 0) {
    parts.push(
      `--- External integrations (MCP: ${analysis.mcpConfigs.length}, OpenAPI: ${analysis.openApiSpecs.length}) ---`
    )
    for (const m of analysis.mcpConfigs) {
      parts.push(`- MCP config: ${m.file} — servers: ${m.servers.join(", ") || "(none)"}`)
    }
    for (const s of analysis.openApiSpecs) {
      parts.push(
        `- OpenAPI: ${s.file} — ${s.title ?? "(untitled)"}${s.version ? ` v${s.version}` : ""} — ${s.operations.length} operations`
      )
    }
    parts.push("")
  }

  // Edges (data-flow questions need this).
  if (analysis.edges.length > 0) {
    parts.push(`--- Data-flow edges (${analysis.edges.length}) ---`)
    const capped = analysis.edges.slice(0, 60)
    for (const e of capped) {
      parts.push(`- ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}`)
    }
    if (analysis.edges.length > capped.length)
      parts.push(`- (+${analysis.edges.length - capped.length} more edges omitted)`)
    parts.push("")
  }

  return parts.join("\n")
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

/* ------------------------------------------------------------------------- */
/* Provider clients                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Single entry point — dispatches to the right provider based on
 * `req.provider`. Throws `ChatProviderError` on configuration or upstream
 * failure; the route handler turns that into a clean JSON error.
 */
export async function runChat(req: ChatRequest): Promise<ChatResponse> {
  const t0 = Date.now()
  switch (req.provider) {
    case "openai":
      return finalize(req, await chatOpenAI(req), t0)
    case "anthropic":
      return finalize(req, await chatAnthropic(req), t0)
    case "gemini":
      return finalize(req, await chatGemini(req), t0)
    default: {
      const exhaustive: never = req.provider
      throw new ChatProviderError(
        `Unknown provider: ${exhaustive as string}`,
        "bad_request",
        400
      )
    }
  }
}

function finalize(
  req: ChatRequest,
  answer: string,
  t0: number
): ChatResponse {
  return {
    answer: answer.trim(),
    provider: req.provider,
    model: req.model,
    latencyMs: Date.now() - t0,
  }
}

/* ----------------- OpenAI -------------------------------------------------- */

async function chatOpenAI(req: ChatRequest): Promise<string> {
  const key = req.apiKey || process.env.OPENAI_API_KEY
  if (!key) {
    throw new ChatProviderError(
      "No OpenAI API key found. Open Settings → LLM Providers and add your key, or set OPENAI_API_KEY in .env.local.",
      "missing_key",
      400
    )
  }
  const baseUrl = (req.baseUrl?.trim() || "https://api.openai.com/v1").replace(
    /\/+$/,
    ""
  )
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: req.system },
    ...req.history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: req.question },
  ]
  const body = {
    model: req.model,
    messages,
    temperature: 0.2,
  }
  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  const data = await safeJson(res)
  if (!res.ok) {
    const msg =
      (data && (data.error?.message ?? data.error ?? data.message)) ||
      `OpenAI HTTP ${res.status}`
    throw new ChatProviderError(
      typeof msg === "string" ? msg : JSON.stringify(msg),
      res.status === 429 ? "rate_limited" : "upstream_error",
      res.status >= 500 ? 502 : 400
    )
  }
  const text: string | undefined = data?.choices?.[0]?.message?.content
  if (!text) throw new ChatProviderError("OpenAI returned no content.", "upstream_error", 502)
  return text
}

/* ----------------- Anthropic ---------------------------------------------- */

async function chatAnthropic(req: ChatRequest): Promise<string> {
  const key = req.apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) {
    throw new ChatProviderError(
      "No Anthropic API key found. Open Settings → LLM Providers and add your key, or set ANTHROPIC_API_KEY in .env.local.",
      "missing_key",
      400
    )
  }
  const messages = [
    ...req.history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: req.question },
  ]
  const body = {
    model: req.model,
    max_tokens: 2048,
    system: req.system,
    messages,
    temperature: 0.2,
  }
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  const data = await safeJson(res)
  if (!res.ok) {
    const msg =
      (data && (data.error?.message ?? data.error ?? data.message)) ||
      `Anthropic HTTP ${res.status}`
    throw new ChatProviderError(
      typeof msg === "string" ? msg : JSON.stringify(msg),
      res.status === 429 ? "rate_limited" : "upstream_error",
      res.status >= 500 ? 502 : 400
    )
  }
  // Anthropic returns { content: [{ type: "text", text: "..." }, ...] }
  const blocks: { type?: string; text?: string }[] = data?.content ?? []
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
  if (!text)
    throw new ChatProviderError("Anthropic returned no text content.", "upstream_error", 502)
  return text
}

/* ----------------- Gemini -------------------------------------------------- */

async function chatGemini(req: ChatRequest): Promise<string> {
  const key =
    req.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!key) {
    throw new ChatProviderError(
      "No Gemini API key found. Open Settings → LLM Providers and add your key, or set GEMINI_API_KEY in .env.local.",
      "missing_key",
      400
    )
  }
  // Gemini uses `model` in the URL path and `user`/`model` roles (not "assistant").
  const contents = [
    ...req.history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    { role: "user", parts: [{ text: req.question }] },
  ]
  const body = {
    contents,
    systemInstruction: { parts: [{ text: req.system }] },
    generationConfig: { temperature: 0.2 },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(key)}`
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  const data = await safeJson(res)
  if (!res.ok) {
    const msg =
      (data && (data.error?.message ?? data.error ?? data.message)) ||
      `Gemini HTTP ${res.status}`
    throw new ChatProviderError(
      typeof msg === "string" ? msg : JSON.stringify(msg),
      res.status === 429 ? "rate_limited" : "upstream_error",
      res.status >= 500 ? 502 : 400
    )
  }
  // Gemini: { candidates: [{ content: { parts: [{ text: "..." }, ...] } }] }
  const parts: { text?: string }[] =
    data?.candidates?.[0]?.content?.parts ?? []
  const text = parts.map((p) => p.text ?? "").join("\n")
  if (!text)
    throw new ChatProviderError("Gemini returned no text content.", "upstream_error", 502)
  return text
}

/* ------------------------------------------------------------------------- */
/* Fetch helpers                                                             */
/* ------------------------------------------------------------------------- */

/**
 * `fetch` with a built-in 60s timeout. LLM calls can stall — without this
 * the dev server's response would hang until the upstream times out
 * (often 5+ minutes for Anthropic).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  // Chain caller's signal into ours so caller can still cancel.
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new ChatProviderError(
        "The provider took longer than 60s to respond.",
        "timeout",
        504
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
