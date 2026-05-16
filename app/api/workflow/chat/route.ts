/**
 * POST /api/workflow/chat
 *
 * Talk to a real LLM (OpenAI / Anthropic / Gemini) about the analyzed
 * repository. The renderer also has a deterministic mode for users without
 * any API keys configured — that path doesn't hit this route at all and
 * answers locally from the workflow graph.
 *
 * Why server-side: keeps API keys in `process.env` on the machine running
 * the app (never exposed to the renderer). Matches the same security model
 * as the scanner / git APIs.
 *
 * Request shape:
 *   {
 *     provider: "openai" | "anthropic" | "gemini",
 *     model: string,                     // model id from PROVIDER_CATALOGUE
 *     question: string,                  // current user message
 *     history?: { role, content }[],     // prior turns, capped server-side
 *     analysis: WorkflowAnalysis,        // re-sent each turn for context
 *   }
 *
 * We don't store anything server-side; the client owns the conversation.
 */

import { NextResponse } from "next/server"

import {
  buildWorkflowSystemPrompt,
  ChatProviderError,
  runChat,
  type ChatProvider,
  type ChatTurn,
} from "@/lib/workflow-chat"
import type { WorkflowAnalysis } from "@/lib/workflow-types"

export const dynamic = "force-dynamic"
// Upstream LLMs can take ~30s; allow up to 70s before Next aborts.
export const maxDuration = 70

const KNOWN_PROVIDERS: ChatProvider[] = ["openai", "anthropic", "gemini"]
const MAX_HISTORY_TURNS = 8
const MAX_QUESTION_LENGTH = 4000

type ChatRequestBody = {
  provider?: string
  model?: string
  question?: string
  history?: { role?: string; content?: string }[]
  analysis?: WorkflowAnalysis
  /** Forwarded from the user's Settings localStorage. Never persisted. */
  apiKey?: string
  /** OpenAI-compatible base URL override (e.g. Ollama, Together, Groq). */
  baseUrl?: string
}

export async function POST(request: Request) {
  let body: ChatRequestBody = {}
  try {
    body = (await request.json()) as ChatRequestBody
  } catch {
    return jsonError("Invalid JSON body.", 400)
  }

  // ----- validation -------------------------------------------------------
  if (!body.provider || !KNOWN_PROVIDERS.includes(body.provider as ChatProvider))
    return jsonError(
      `provider must be one of: ${KNOWN_PROVIDERS.join(", ")}`,
      400
    )
  if (!body.model || typeof body.model !== "string" || !body.model.trim())
    return jsonError("model is required.", 400)
  if (
    !body.question ||
    typeof body.question !== "string" ||
    !body.question.trim()
  )
    return jsonError("question is required.", 400)
  if (body.question.length > MAX_QUESTION_LENGTH)
    return jsonError(
      `question is too long (max ${MAX_QUESTION_LENGTH} chars).`,
      400
    )
  if (!body.analysis || typeof body.analysis !== "object")
    return jsonError("analysis (the workflow result) is required.", 400)

  // ----- normalise history ------------------------------------------------
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter(
          (t): t is { role: "user" | "assistant"; content: string } =>
            !!t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content.trim().length > 0
        )
        .slice(-MAX_HISTORY_TURNS)
    : []

  // ----- build system prompt and dispatch --------------------------------
  let system: string
  try {
    system = buildWorkflowSystemPrompt(body.analysis as WorkflowAnalysis)
  } catch (err) {
    return jsonError(
      `Failed to build system prompt: ${
        err instanceof Error ? err.message : String(err)
      }`,
      500
    )
  }

  try {
    const result = await runChat({
      provider: body.provider as ChatProvider,
      model: body.model.trim(),
      question: body.question.trim(),
      history,
      system,
      apiKey:
        typeof body.apiKey === "string" && body.apiKey.trim().length > 0
          ? body.apiKey.trim()
          : undefined,
      baseUrl:
        typeof body.baseUrl === "string" && body.baseUrl.trim().length > 0
          ? body.baseUrl.trim()
          : undefined,
    })
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    })
  } catch (err) {
    if (err instanceof ChatProviderError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      )
    }
    return jsonError(
      err instanceof Error ? err.message : String(err),
      500
    )
  }
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}
