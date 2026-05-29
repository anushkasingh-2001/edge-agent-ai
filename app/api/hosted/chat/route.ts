/**
 * POST /api/hosted/chat
 *
 * Hosted chat assistant endpoint. Used by `ChatAssistant`, the prompt
 * playground (`/api/hosted/playground`), and the workflow chat
 * (`/api/hosted/workflow`). All three are thin wrappers over the same
 * hosted contract:
 *
 *   1. `assertHostedRequest` — auth + reject BYOK fields.
 *   2. `resolveAiProviderForRequest` — plan/quota/credit + provider.
 *   3. `callLlm` — server-side upstream model call.
 *   4. `recordConsumption` — debit credits + close audit row.
 *
 * Request body:
 *   {
 *     intelligenceMode?: "save"|"auto"|"pro"|"max"|"manual",
 *     manualModelSelection?: { explain?: string },
 *     messages: [{ role: "user"|"assistant"|"system", content: string }, ...],
 *     systemPrompt?: string,
 *     task?: "explain" | "playground" | "workflow",
 *   }
 *
 * Response (success):
 *   {
 *     reply: string,
 *     model: string,
 *     provider: ProviderKind,
 *     apiKeySource: "hosted",
 *     creditsUsed: number,
 *     quotaRemaining: number,
 *   }
 *
 * Response NEVER contains apiKey/baseUrl.
 */

import { NextResponse } from "next/server"
import { assertHostedRequest, RouteGuardError } from "@/lib/server-route-guards"
import {
  resolveAiProviderForRequestAsync as resolveAiProviderForRequest,
  recordConsumptionAsync,
  classifyUpstreamFailure,
  redactForClient,
} from "@/lib/server-ai-provider-resolver"
import { callLlm, assertOpenAICompatible } from "@/lib/server-llm-client"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type ChatRole = "user" | "assistant" | "system"
interface ChatMessage {
  role: ChatRole
  content: string
}

interface ChatBody {
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  messages?: ChatMessage[]
  systemPrompt?: string
  task?: "explain" | "playground" | "workflow"
}

function validateMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatMessage[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const m = r as Record<string, unknown>
    const role = m.role
    const content = m.content
    if (role !== "user" && role !== "assistant" && role !== "system") continue
    if (typeof content !== "string") continue
    if (content.length === 0) continue
    out.push({ role, content: content.slice(0, 8000) })
  }
  return out.length > 0 ? out : null
}

function buildPrompts(messages: ChatMessage[], systemPrompt: string | undefined): {
  system: string
  user: string
} {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content)
  const sys = [systemPrompt?.trim(), ...systems]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n")
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n")
  return {
    system:
      sys ||
      "You are Edge Agent AI, a helpful, concise software assistant. Answer the user's question directly. Decline if it requires running code on their machine.",
    user: turns || "(empty conversation)",
  }
}

export async function POST(req: Request) {
  let body: ChatBody = {}
  try {
    body = (await req.json()) as ChatBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  let session
  try {
    session = assertHostedRequest(req, body as unknown as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
  }

  const messages = validateMessages(body.messages)
  if (!messages) {
    return NextResponse.json(
      { error: "messages must be a non-empty array of {role, content}." },
      { status: 400 },
    )
  }

  const intelligenceMode = body.intelligenceMode ?? "auto"
  const task = body.task ?? "explain"
  const manualPicks =
    body.manualModelSelection ??
    (body.manualModels && typeof body.manualModels === "object" ? body.manualModels : undefined)

  const resolution = await resolveAiProviderForRequest({
    userId: session.userId,
    workspaceId: session.workspaceId,
    intelligenceMode,
    task: "explain",
    complexity: 0.5,
    manualModelSelection: manualPicks,
    emailVerified: session.emailVerified,
  })
  if (!resolution.ok) {
    const status =
      resolution.code === "not_authenticated"
        ? 401
        : resolution.code === "email_unverified"
          ? 403
          : 402
    return NextResponse.json(
      {
        error: resolution.reason,
        code: resolution.code,
        upgrade: "upgrade" in resolution ? resolution.upgrade : false,
      },
      { status },
    )
  }

  const guard = assertOpenAICompatible({
    provider: resolution.provider,
    apiKey: resolution.apiKey,
    baseUrl: resolution.baseUrl,
  })
  if (!guard.ok) {
    await recordConsumptionAsync({
      userId: session.userId,
      workspaceId: session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: 0,
      requestId: resolution.requestId,
      status: "blocked",
      blockReason: guard.error,
      task,
      intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
    })
    return NextResponse.json(
      { error: "Hosted model is not OpenAI-compatible on this server.", code: guard.error },
      { status: 502 },
    )
  }

  const prompts = buildPrompts(messages, body.systemPrompt)
  const result = await callLlm({
    model: resolution.model,
    apiKey: guard.config.apiKey,
    baseUrl: guard.config.baseUrl,
    system: prompts.system,
    user: prompts.user,
    json: false,
    temperature: 0.2,
    maxTokens: 800,
  })

  if (!result.ok) {
    const cls = classifyUpstreamFailure(0, result.error)
    await recordConsumptionAsync({
      userId: session.userId,
      workspaceId: session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: 0,
      requestId: resolution.requestId,
      status: "failed",
      errorClass: cls.code,
      task,
      intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
    })
    return NextResponse.json({ error: cls.reason, code: cls.code }, { status: 502 })
  }

  const creditsUsed = await recordConsumptionAsync({
    userId: session.userId,
    workspaceId: session.workspaceId,
    apiKeySource: "hosted",
    estimatedCredits: resolution.estimatedCredits,
    requestId: resolution.requestId,
    status: "success",
    task,
    intelligenceMode,
    model: resolution.model,
    provider: resolution.provider,
  })

  const safe = redactForClient(resolution)
  return NextResponse.json({
    reply: result.text,
    model: safe.model,
    provider: safe.provider,
    apiKeySource: "hosted",
    creditsUsed,
    quotaRemaining: Math.max(0, safe.quotaStatus.remaining),
  })
}
