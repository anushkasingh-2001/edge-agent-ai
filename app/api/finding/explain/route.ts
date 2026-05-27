/**
 * POST /api/finding/explain
 *
 * Returns an AI-personalized explanation for ONE finding.
 *
 * Behaviour (enforced here + in lib/server-finding-explanations.ts):
 *   - One finding per request. No batch endpoints; no auto-explain of unopened
 *     findings. The drawer triggers this route exactly when the user opens a
 *     finding row.
 *   - Cache-first: a fingerprint hit at `.edgeagent/cache/explanations.json`
 *     short-circuits to `source: "cached_ai"` without contacting the model.
 *   - Template fallback: when the API key is missing or the model call fails
 *     / times out, we return the scanner's deterministic structured `reason`
 *     under `source: "template_fallback"` so the UI degrades gracefully.
 *   - Severity / category / file / line / evidence / rule_id are NEVER taken
 *     from the model. The route only returns the model's free-text fields,
 *     and the scanner's data flows through unchanged in the response envelope.
 *   - Per-process session cap (20 calls) protects users from runaway costs.
 *   - Validates the project path against the same allow-root the scan route
 *     uses; refuses to touch paths outside it.
 */

import path from "node:path"
import { NextResponse } from "next/server"
import { resolveAiProviderForRequest } from "@/lib/server-ai-provider-resolver"

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
  /** REQUIRED for any AI call. BYOK-only — there is no env fallback.
   *  Sourced from the user's Settings → provider slot in the browser. */
  apiKey?: string
  /** OpenAI-compatible base URL override (Together / Groq / local). */
  baseUrl?: string
  /** Caller's chosen model id from Settings. */
  model?: string
  /** Intelligence mode (save/auto/pro/max/manual). Forwarded to the
   *  resolver (key/provider/model selection) and to ``explainOneFinding``
   *  (model tier per mode). The scanner-owned fields
   *  (severity/category/file/line/evidence) are NEVER taken from the
   *  model regardless of mode. */
  intelligenceMode?: "save" | "auto" | "pro" | "max" | "manual"
  /** Retained on the wire for backward-compat. Treated as "byok"
   *  regardless of value post-MVP — there is no hosted path. */
  aiProviderMode?: "hosted" | "byok"
  /** Manual-mode per-task model picks. The canonical name is
   *  ``manualModelSelection``; ``manualModels`` is accepted as a
   *  backward-compatible alias so older clients still work. */
  manualModelSelection?: Record<string, string>
  manualModels?: Record<string, string>
  /** Caller's chosen provider kind (defaults to openai_compatible). */
  provider?: "openai_compatible" | "anthropic" | "google" | "custom"
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

  // The body-supplied `apiKey` is the user's Settings key. BYOK-only:
  // there is NO env / hosted fallback. The key is used ONLY for this
  // request — not logged, not echoed, not persisted to the explanation
  // cache (cache keys are content hashes — see `fingerprintFinding`).
  const bodyApiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
  const effectiveKeyForRedaction = bodyApiKey

  const bodyModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined

  // ---- BYOK resolution + plan eligibility ---------------------------
  // The resolver enforces plan limits and gates Save/Manual modes
  // BEFORE the model call, then returns the (provider, model, key,
  // base URL) tuple to use upstream. There is no hosted path.
  const intelligenceMode = body.intelligenceMode ?? "auto"
  const aiProviderMode = "byok" as const
  // Normalise the manual map so callers that sent only the legacy
  // ``manualModels`` name still influence the Manual route. Both
  // names mean the same thing on the wire.
  const manualPicksForResolver: Record<string, string> | undefined =
    (body.manualModelSelection && typeof body.manualModelSelection === "object"
      ? (body.manualModelSelection as Record<string, string>)
      : undefined) ??
    (body.manualModels && typeof body.manualModels === "object"
      ? (body.manualModels as Record<string, string>)
      : undefined)

  const resolution = resolveAiProviderForRequest({
    userId: "local-user",
    workspaceId: "local-workspace",
    aiProviderMode,
    intelligenceMode,
    task: "explain",
    manualModelSelection: manualPicksForResolver,
    byokApiKey: bodyApiKey || null,
    byokBaseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
    byokProvider: body.provider,
  })
  if (!resolution.ok) {
    // For missing/invalid key we ALSO return a template_fallback
    // payload so the drawer can still render the scanner's structured
    // reason alongside the CTA. Other refusals (mode_not_in_plan,
    // task_not_allowed_in_mode) return a plain error so the UI can
    // show the upgrade prompt without misleading "AI explanation"
    // framing.
    if (resolution.code === "missing_api_key" || resolution.code === "invalid_api_key") {
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
    return NextResponse.json(
      { error: resolution.reason, code: resolution.code, upgrade: resolution.upgrade ?? false },
      { status: 403 },
    )
  }
  const resolvedApiKey: string = resolution.apiKey
  const resolvedBaseUrl: string | undefined = resolution.baseUrl ?? undefined
  const resolvedModel: string = bodyModel ?? resolution.model

  let payload
  try {
    // Normalise the manual-model picks: ``manualModelSelection`` is the
    // v2 canonical name; ``manualModels`` is the legacy name from the
    // Step-1 wiring. Either is accepted; the explainer sees one map.
    const manualPicks =
      (body.manualModelSelection && typeof body.manualModelSelection === "object"
        ? body.manualModelSelection
        : undefined) ??
      (body.manualModels && typeof body.manualModels === "object"
        ? body.manualModels
        : undefined)

    payload = await explainOneFinding(finding, project, {
      // The Hosted/BYOK resolver above already chose the provider key,
      // base URL, and a concrete model id. Forward those — that's how
      // Hosted plans avoid leaking the server key to the client.
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      model: resolvedModel,
      // Forward the mode + manual map so the explainer tiering / per-task
      // selection still applies when the resolver didn't override.
      intelligenceMode:
        typeof body.intelligenceMode === "string" ? body.intelligenceMode : undefined,
      manualModels: manualPicks,
    })
  } catch (e) {
    // Defensive: never let an unexpected error block the UI — fall back so
    // the panel still shows the scanner's structured reason.
    const fallback = buildTemplateFallback(finding, "template_fallback")
    // Sanitise debug output before sending it to the client. The key must
    // not appear in error messages even in dev mode.
    const rawErr = String((e as Error)?.message ?? e)
    const safeErr = redactKey(rawErr, effectiveKeyForRedaction)
    return NextResponse.json({
      ...fallback,
      // Echo the static scanner identity so the client can verify nothing
      // about the finding itself was mutated by the AI layer.
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

  // No credit accounting in BYOK-only MVP — the user's upstream
  // provider bills them directly. recordConsumption is intentionally
  // a no-op (kept on the resolver's public surface so the API
  // signature stays stable if hosted is re-introduced later).

  return NextResponse.json({
    ...payload,
    // Re-stamp the scanner-owned fields from the validated input so any
    // client that diffs against the original finding can prove the AI
    // layer didn't tamper with them.
    finding_id: finding.finding_id,
    rule_id: finding.rule_id,
    severity: finding.severity,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    model_planned: bodyModel ?? pickModel(finding),
    // explainOneFinding sets `debug_error` only in non-prod and only when
    // the AI failed; in prod we strip it as belt-and-braces.
    debug_error:
      process.env.NODE_ENV === "production"
        ? undefined
        : payload.debug_error
          ? redactKey(payload.debug_error, effectiveKeyForRedaction)
          : undefined,
  })
}
