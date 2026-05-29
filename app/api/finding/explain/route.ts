/**
 * POST /api/finding/explain
 *
 * Returns an AI-personalized explanation for ONE finding.
 *
 * Hosted-only contract (post BYOK-removal):
 *   - The route NEVER reads `apiKey` / `baseUrl` / `provider` from the
 *     request body. Even if a legacy client still sends them, they
 *     are silently ignored — never forwarded upstream, never logged,
 *     never echoed.
 *   - The provider credential comes from server env / secret manager
 *     via `resolveAiProviderForRequest`. The result of the resolver is
 *     passed through `redactForClient` before any echo; the public
 *     response never includes `apiKey`.
 *   - Authentication is asserted via `assertSession()`. Anonymous AI
 *     calls return `not_authenticated`.
 *   - Plan + per-mode + quota gates run BEFORE the upstream call.
 *     Credits are debited via `recordConsumption` only after a
 *     successful explanation (not on cache hits, not on template
 *     fallback).
 *
 * Behaviour:
 *   - One finding per request. The drawer triggers this route exactly
 *     when the user opens a finding row.
 *   - Cache-first: a fingerprint hit short-circuits to
 *     `source: "cached_ai"` without contacting the model.
 *   - Template fallback when hosted AI is unavailable (operator
 *     misconfig) or when the model call fails — so the UI degrades.
 *   - Severity / category / file / line / evidence / rule_id are NEVER
 *     taken from the model. The model's free-text fields flow through;
 *     scanner-owned fields are re-stamped from the validated input.
 */

import path from "node:path"
import { NextResponse } from "next/server"
import {
  resolveAiProviderForRequestAsync as resolveAiProviderForRequest,
  recordConsumptionAsync,
} from "@/lib/server-ai-provider-resolver"
import {
  assertHostedRequest,
  RouteGuardError,
} from "@/lib/server-route-guards"

import {
  ExplanationError,
  buildTemplateFallback,
  explainOneFinding,
  pickModel,
  resolveAndValidateProjectPath,
  _redactKeyForTests as redactKey,
  type FindingInput,
  type ProjectContext,
} from "@/lib/server-finding-explanations"

export const dynamic = "force-dynamic"
export const maxDuration = 60

interface RouteBody {
  projectPath?: string
  projectName?: string | null
  projectType?: string | null
  finding?: Partial<FindingInput> & {
    code_snippet?: string
    line?: number | string
  }
  /** Intelligence mode (save/auto/pro/max/manual). Forwarded to the
   *  resolver. Defaults to "auto". */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Wire-level value retained for backward compat. Always treated as
   *  hosted; the resolver is hosted-only. */
  aiProviderMode?: "hosted" | "byok"
  /** Manual-mode per-task model picks. The canonical name is
   *  ``manualModelSelection``; ``manualModels`` is accepted as a
   *  backward-compatible alias so older clients still work. */
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
}

function clampCodeSnippet(input: unknown): string {
  if (typeof input !== "string") return ""
  const lines = input.split(/\r?\n/).slice(0, 10) // hard cap at 10 lines
  return lines.join("\n").slice(0, 2_000) // and 2 KB total — keeps prompt small
}

function validateFinding(raw: RouteBody["finding"]): FindingInput {
  if (!raw || typeof raw !== "object") {
    throw new ExplanationError("`finding` is required.", 400)
  }
  const finding_id = typeof raw.finding_id === "string" && raw.finding_id.trim() ? raw.finding_id.trim() : null
  const rule_id = typeof raw.rule_id === "string" && raw.rule_id.trim() ? raw.rule_id.trim() : null
  const severity = raw.severity
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category : "Uncategorized"
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled finding"
  const file = typeof raw.file === "string" && raw.file.trim() ? raw.file : null
  const lineNum = typeof raw.line === "number" ? raw.line : typeof raw.line === "string" ? Number.parseInt(raw.line, 10) : NaN

  if (!finding_id) throw new ExplanationError("`finding.finding_id` is required.", 400)
  if (!rule_id) throw new ExplanationError("`finding.rule_id` is required.", 400)
  if (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low") {
    throw new ExplanationError("`finding.severity` must be critical|high|medium|low.", 400)
  }
  if (!file) throw new ExplanationError("`finding.file` is required.", 400)
  if (!Number.isFinite(lineNum)) throw new ExplanationError("`finding.line` must be a number.", 400)

  return {
    finding_id,
    rule_id,
    severity,
    category,
    title,
    file,
    line: lineNum,
    agent: typeof raw.agent === "string" ? raw.agent : "unknown",
    reason: typeof raw.reason === "string" ? raw.reason : "",
    suggested_fix: typeof raw.suggested_fix === "string" ? raw.suggested_fix : "",
    evidence: typeof raw.evidence === "string" ? raw.evidence : "",
    code_snippet: clampCodeSnippet(raw.code_snippet),
    evidence_path: Array.isArray(raw.evidence_path) ? raw.evidence_path : undefined,
    confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
    agent_reachable: typeof raw.agent_reachable === "boolean" ? raw.agent_reachable : undefined,
  }
}

export async function POST(req: Request) {
  let body: RouteBody
  try {
    body = (await req.json()) as RouteBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  // Authenticated user is REQUIRED for any AI call. The guard also
  // rejects any incoming BYOK-era field (apiKey/baseUrl/providerKey)
  // with 400 so a misbehaving client can't silently send secrets.
  let session
  try {
    session = assertHostedRequest(req, body as unknown as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
  }

  let resolved: string
  try {
    resolved = resolveAndValidateProjectPath(body.projectPath).resolved
  } catch (e) {
    if (e instanceof ExplanationError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: "projectPath validation failed." }, { status: 400 })
  }

  let finding: FindingInput
  try {
    finding = validateFinding(body.finding)
  } catch (e) {
    if (e instanceof ExplanationError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    return NextResponse.json({ error: "finding validation failed." }, { status: 400 })
  }

  const project: ProjectContext = {
    resolvedProjectPath: resolved,
    projectName: body.projectName ?? path.basename(resolved),
    projectType: body.projectType ?? null,
  }

  // ---- Hosted resolution + plan + quota ----
  // The resolver enforces auth identity, plan eligibility (modes +
  // manual gate), quota (estimated credit cost vs remaining), and
  // hands back the server-managed provider/key/model tuple to use
  // upstream. The body NEVER carries an apiKey — anything sent by a
  // legacy client is intentionally not read here.
  const intelligenceMode = body.intelligenceMode ?? "auto"
  const manualPicksForResolver: Record<string, string> | undefined =
    (body.manualModelSelection && typeof body.manualModelSelection === "object"
      ? (body.manualModelSelection as Record<string, string>)
      : undefined) ??
    (body.manualModels && typeof body.manualModels === "object"
      ? (body.manualModels as Record<string, string>)
      : undefined)

  const resolution = await resolveAiProviderForRequest({
    userId: session.userId,
    workspaceId: session.workspaceId,
    intelligenceMode,
    task: "explain",
    manualModelSelection: manualPicksForResolver,
  })

  if (!resolution.ok) {
    // For missing_hosted_key (operator misconfig) we still want the UI
    // to show the scanner's structured reason — so we return a
    // template_fallback envelope. Plan/quota refusals bubble up as
    // structured errors so the UI can show "upgrade" CTA.
    if (resolution.code === "missing_hosted_key") {
      const fallback = buildTemplateFallback(finding, "template_fallback")
      return NextResponse.json({
        ...fallback,
        finding_id: finding.finding_id,
        rule_id: finding.rule_id,
        severity: finding.severity,
        category: finding.category,
        file: finding.file,
        line: finding.line,
        model_planned: pickModel(finding),
        error: resolution.reason,
        code: resolution.code,
      })
    }
    const httpStatus =
      resolution.code === "not_authenticated" ? 401 :
      resolution.code === "quota_exceeded" ? 402 :
      resolution.code === "task_not_allowed_in_mode" ? 200 :
      403
    return NextResponse.json(
      {
        error: resolution.reason,
        code: resolution.code,
        upgrade: resolution.upgrade ?? false,
        remaining: resolution.remaining,
        needed: resolution.needed,
      },
      { status: httpStatus },
    )
  }

  // Server-side credentials. NEVER include `resolution.apiKey` in the
  // response. The constant below is in-process only.
  const resolvedApiKey: string = resolution.apiKey
  const resolvedBaseUrl: string | undefined = resolution.baseUrl ?? undefined
  const resolvedModel: string = resolution.model

  let payload
  let aiSucceeded = false
  try {
    const manualPicks =
      (body.manualModelSelection && typeof body.manualModelSelection === "object"
        ? body.manualModelSelection
        : undefined) ??
      (body.manualModels && typeof body.manualModels === "object"
        ? body.manualModels
        : undefined)

    payload = await explainOneFinding(finding, project, {
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      model: resolvedModel,
      intelligenceMode:
        typeof body.intelligenceMode === "string" ? body.intelligenceMode : undefined,
      manualModels: manualPicks,
    })
    aiSucceeded = payload?.source === "ai" || payload?.source === "cached_ai" || false
  } catch (e) {
    const fallback = buildTemplateFallback(finding, "template_fallback")
    const rawErr = String((e as Error)?.message ?? e)
    // Use a benign placeholder for redaction; we want NO chance of the
    // server key leaking into client error strings.
    const safeErr = redactKey(rawErr, resolvedApiKey)
    return NextResponse.json({
      ...fallback,
      finding_id: finding.finding_id,
      rule_id: finding.rule_id,
      severity: finding.severity,
      category: finding.category,
      file: finding.file,
      line: finding.line,
      debug_error: process.env.NODE_ENV === "production" ? undefined : safeErr,
      model_planned: pickModel(finding),
    })
  }

  // Debit credits ONLY on a successful AI call (not cache hits, not
  // template fallback). The resolver already reserved the cost so the
  // ledger debit matches what the quota check saw.
  if (aiSucceeded && payload?.source === "ai") {
    await recordConsumptionAsync({
      userId: session.userId,
      workspaceId: session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: resolution.estimatedCredits,
      requestId: resolution.requestId,
      status: "success",
      task: "explain",
      intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
    })
  } else if (resolution.requestId) {
    await recordConsumptionAsync({
      userId: session.userId,
      workspaceId: session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: 0,
      requestId: resolution.requestId,
      status: "failed",
      task: "explain",
      intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
      errorClass: payload?.source ?? "no_ai",
    })
  }

  return NextResponse.json({
    ...payload,
    finding_id: finding.finding_id,
    rule_id: finding.rule_id,
    severity: finding.severity,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    model_planned: resolvedModel,
    // Hosted contract metadata the UI may surface (no key).
    apiKeySource: "hosted" as const,
    provider: resolution.provider,
    creditsUsed: aiSucceeded && payload?.source === "ai" ? resolution.estimatedCredits : 0,
    quotaRemaining: resolution.quotaStatus.remaining,
    debug_error:
      process.env.NODE_ENV === "production"
        ? undefined
        : payload.debug_error
          ? redactKey(payload.debug_error, resolvedApiKey)
          : undefined,
  })
}
