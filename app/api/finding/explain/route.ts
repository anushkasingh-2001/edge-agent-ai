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
  /** Test / power-user override. Falls back to process.env.OPENAI_API_KEY. */
  apiKey?: string
  /** Test / power-user override of the OpenAI base URL (for compat servers). */
  baseUrl?: string
  /** Caller's chosen model id (e.g. from Settings → OpenAI slot). Overrides
   * the cost-control default so we don't try to call a gpt-5 model that
   * the user's key may not be entitled to. */
  model?: string
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

  // The body-supplied `apiKey` (when present) came either from the user's
  // browser-stored Settings → OpenAI slot or from a power-user override.
  // It is used ONLY for this request: not logged here, not echoed back in
  // any response, not persisted to the explanation cache (cache keys are
  // content hashes — see `fingerprintFinding`).
  const bodyApiKey = typeof body.apiKey === "string" ? body.apiKey : undefined
  const effectiveKeyForRedaction = bodyApiKey || process.env.OPENAI_API_KEY || ""

  // Caller-chosen model: only honoured when paired with the caller's apiKey
  // (browser Settings flow). When the request relies on the server env key
  // we keep the cost-control default so a stray body field can't redirect
  // billed traffic to an expensive model.
  const bodyModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined
  const modelForCall = bodyApiKey ? bodyModel : undefined

  let payload
  try {
    payload = await explainOneFinding(finding, project, {
      apiKey: bodyApiKey,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: modelForCall,
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
    model_planned: modelForCall ?? pickModel(finding),
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
