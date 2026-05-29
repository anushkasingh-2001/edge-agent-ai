/**
 * Cloud patch/fix GENERATION handler (hosted-only).
 *
 * Mounted at three thin routes:
 *   - /api/cloud/finding/patch-generate
 *   - /api/cloud/findings/fix-generate
 *   - /api/cloud/findings/fix-filtered-generate
 *
 * Contract
 * --------
 * This endpoint generates patch/diff TEXT and nothing else. It:
 *   - authenticates the session (401 if missing/invalid),
 *   - rejects any BYOK-era key fields in the body (apiKey/baseUrl/…),
 *   - runs the hosted resolver (plan → quota → server key); a quota failure
 *     returns `quota_exceeded` (402) BEFORE any model call,
 *   - calls the model with the SERVER-side key (from process.env),
 *   - debits credits ONLY after a successful generation,
 *   - returns the raw model text + redacted billing metadata.
 *
 * It NEVER:
 *   - reads or writes the user's local files (it only ever sees prompt text
 *     the desktop already built + redacted),
 *   - returns a provider apiKey or baseUrl,
 *   - accepts a caller-supplied key (BYOK is gone).
 *
 * Local file application, validation, backup and re-scan all happen on the
 * desktop's local server — see lib/server-patch-generation-gateway.ts.
 */

import { NextResponse } from "next/server"

import {
  assertHostedRequest,
  RouteGuardError,
} from "./server-route-guards"
import {
  resolveAiProviderForRequestAsync,
  recordConsumptionAsync,
  classifyUpstreamFailure,
} from "./server-ai-provider-resolver"
import { callLlm, assertOpenAICompatible } from "./server-llm-client"
import { cloudCorsHeaders, cloudPreflightResponse } from "./server-cloud-cors"
import type { IntelligenceMode } from "./context-bundle"
import type { LlmTask } from "./intelligence-mode"

interface GenBody {
  system?: unknown
  user?: unknown
  json?: unknown
  maxTokens?: unknown
  model?: unknown
  intelligenceMode?: unknown
  task?: unknown
  temperature?: unknown
  complexity?: unknown
  manualModelSelection?: unknown
}

/** Map the wire task label to a resolver `LlmTask`. "plan" is the first leg
 *  of a two-step patch and gates identically to "patch". */
function resolverTask(task: unknown): LlmTask {
  switch (task) {
    case "bulk":
      return "bulk"
    case "patch":
    case "plan":
    default:
      return "patch"
  }
}

function jsonWithCors(
  body: Record<string, unknown>,
  status: number,
  cors: Record<string, string>,
): Response {
  return NextResponse.json(body, { status, headers: cors })
}

/** OPTIONS preflight for the cloud generation routes. */
export function handleCloudGeneratePreflight(req: Request): Response {
  return cloudPreflightResponse(req)
}

export async function handleCloudGenerate(req: Request): Promise<Response> {
  const cors = cloudCorsHeaders(req)

  let body: GenBody = {}
  try {
    body = (await req.json()) as GenBody
  } catch {
    return jsonWithCors({ error: "invalid JSON body" }, 400, cors)
  }

  // Auth + BYOK-field rejection. assertHostedRequest throws 400 if the body
  // carries apiKey/baseUrl/providerKey/etc., and 401 if unauthenticated.
  let session
  try {
    session = assertHostedRequest(req, body as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return jsonWithCors(e.body, e.status, cors)
    }
    throw e
  }

  const system = typeof body.system === "string" ? body.system : null
  const user = typeof body.user === "string" ? body.user : null
  if (!system || !user) {
    return jsonWithCors(
      { error: "system and user prompt text are required", code: "bad_request" },
      400,
      cors,
    )
  }

  const intelligenceMode = (typeof body.intelligenceMode === "string"
    ? body.intelligenceMode
    : "auto") as IntelligenceMode
  const task = resolverTask(body.task)
  const complexity = typeof body.complexity === "number" ? body.complexity : 0
  const manualModelSelection =
    body.manualModelSelection && typeof body.manualModelSelection === "object"
      ? (body.manualModelSelection as Record<string, string>)
      : null

  // ---- Resolver: auth → plan → quota → server key (BEFORE the model call).
  const resolution = await resolveAiProviderForRequestAsync({
    userId: session.userId,
    workspaceId: session.workspaceId,
    intelligenceMode,
    task,
    complexity,
    manualModelSelection,
  })
  if (!resolution.ok) {
    const status =
      resolution.code === "not_authenticated"
        ? 401
        : resolution.code === "quota_exceeded"
          ? 402
          : resolution.code === "missing_hosted_key" || resolution.code === "billing_db_unconfigured"
            ? 503
            : 403
    return jsonWithCors(
      {
        error: resolution.reason,
        code: resolution.code,
        upgrade: resolution.upgrade ?? false,
        remaining: resolution.remaining,
        needed: resolution.needed,
      },
      status,
      cors,
    )
  }

  // Provider guard: this client is OpenAI-compatible only. The resolver
  // produced the key; confirm it's usable through callLlm before spending.
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
      task: String(task),
      intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
      blockReason: guard.error,
    })
    return jsonWithCors(
      { error: "Hosted model is not reachable on this server.", code: "provider_unavailable" },
      503,
      cors,
    )
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : resolution.model
  const maxTokens =
    typeof body.maxTokens === "number" && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 1500
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.1

  // ---- Model call with the SERVER key. The key never leaves this process.
  const llm = await callLlm({
    model,
    apiKey: guard.config.apiKey,
    baseUrl: guard.config.baseUrl,
    system,
    user,
    json: body.json !== false,
    temperature,
    maxTokens,
  })

  if (!llm.ok) {
    const cls = classifyUpstreamFailure(0, llm.error)
    await recordConsumptionAsync({
      userId: session.userId,
      workspaceId: session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: 0,
      requestId: resolution.requestId,
      status: "failed",
      task: String(task),
      intelligenceMode,
      model,
      provider: resolution.provider,
      errorClass: cls.code,
    })
    return jsonWithCors({ error: cls.reason, code: cls.code }, 502, cors)
  }

  // ---- Success: debit credits, then return the text + redacted metadata.
  const creditsUsed = await recordConsumptionAsync({
    userId: session.userId,
    workspaceId: session.workspaceId,
    apiKeySource: "hosted",
    estimatedCredits: resolution.estimatedCredits,
    requestId: resolution.requestId,
    status: "success",
    task: String(task),
    intelligenceMode,
    model,
    provider: resolution.provider,
  })

  // Response intentionally OMITS apiKey/baseUrl. Hosted contract.
  return jsonWithCors(
    {
      ok: true,
      text: llm.text,
      model,
      apiKeySource: "hosted",
      creditsUsed,
      quotaRemaining: resolution.quotaStatus.remaining,
    },
    200,
    cors,
  )
}
