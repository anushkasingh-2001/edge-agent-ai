/**
 * Patch-generation gateway — the ONE place a local route decides whether a
 * patch is generated in-process (single-origin web/dev) or on the cloud
 * backend (packaged desktop), while ALWAYS keeping file validation + apply
 * + re-scan local.
 *
 * Two modes, chosen by `cloudGenerationActive()`:
 *
 *   LOCAL  (no cloud base configured)
 *     - resolve the hosted provider/key/quota in-process,
 *     - run the patch pipeline against the in-process LLM client,
 *     - debit credits in-process.
 *
 *   CLOUD  (EDGE_AGENT_CLOUD_API_BASE set — i.e. the desktop build)
 *     - build the same redacted ContextBundle / prompt locally,
 *     - relay ONLY the prompt to the cloud generation endpoint with the
 *       user's session Bearer token,
 *     - the cloud runs the resolver (auth/plan/quota/key), calls the model,
 *       and debits credits; it returns patch text + billing metadata,
 *     - the pipeline validates the returned patch in a local temp workspace
 *       and the ROUTE applies it locally + re-scans.
 *
 * In BOTH modes the route receives a `PatchResult` it can apply locally with
 * `applyPatch`. No provider key is ever read on the desktop, sent in a
 * request body, or returned in a response.
 */

import { isCloudSplitEnabled, getCloudApiBase } from "./api-fetch"
import { SESSION_COOKIE_NAME } from "./server-auth"
import {
  resolveAiProviderForRequestAsync,
  recordConsumptionAsync,
} from "./server-ai-provider-resolver"
import { makeCloudCompletionFn } from "./server-completion-transport"
import {
  generatePatchPreview,
  type PatchResult,
} from "./server-patch-pipeline"
import type { PlannerFinding, PlanResult } from "./fix-planner"
import type { IntelligenceMode } from "./context-bundle"
import type { IRNeighborhoodInput } from "./server-context-bundle"
import type { ManualOverrides } from "./intelligence-mode"

/** True when this server should delegate model generation to the cloud
 *  backend instead of calling the model in-process. On the desktop the
 *  Electron main process sets `EDGE_AGENT_CLOUD_API_BASE`; on a single-origin
 *  web deployment nothing is set and generation stays in-process. */
export function cloudGenerationActive(): boolean {
  return isCloudSplitEnabled()
}

/** Extract the user's session token from an incoming local-route request so
 *  it can be forwarded to the cloud generation endpoint. Prefers the
 *  `Authorization: Bearer` header (what apiFetch attaches on desktop) and
 *  falls back to the `__edge_session` cookie for same-origin web. */
export function bearerFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (m && m[1].trim()) return m[1].trim()
  const cookie = req.headers.get("cookie") ?? ""
  if (cookie) {
    for (const part of cookie.split(";")) {
      const idx = part.indexOf("=")
      if (idx === -1) continue
      const name = part.slice(0, idx).trim()
      if (name === SESSION_COOKIE_NAME) {
        const val = part.slice(idx + 1).trim()
        if (val) {
          try {
            return decodeURIComponent(val)
          } catch {
            return val
          }
        }
      }
    }
  }
  return null
}

export interface GatewayArgs {
  /** The incoming local-route request (used to forward the session token). */
  req: Request
  session: { userId: string; workspaceId: string }
  projectPath: string
  finding: PlannerFinding
  plan: PlanResult
  intelligenceMode: IntelligenceMode
  complexity: number
  manualModelSelection?: Record<string, string>
  privateCodeMode?: boolean
  neighborhood?: IRNeighborhoodInput
  /** Resolver task. Single-finding patch routes pass "patch"; the bulk
   *  cluster route passes "bulk". */
  task?: "patch" | "bulk"
  /** Cloud generation endpoint to relay to (desktop mode only). */
  cloudEndpoint?: string
}

/** A pre-generation block (auth/plan/quota/key) the route should surface as
 *  a top-level error with the mapped HTTP status. */
export interface GatewayBlock {
  code: string
  reason: string
  upgrade?: boolean
  remaining?: number
  needed?: number
  status: number
}

export interface GatewayResult {
  /** True when generation ran (the preview may still be a refusal). */
  ok: boolean
  preview?: PatchResult
  creditsUsed: number
  quotaRemaining: number | null
  model?: string
  provider?: string
  /** Set when generation was blocked before any model call. */
  blocked?: GatewayBlock
}

const DEFAULT_CLOUD_ENDPOINT = "/api/cloud/finding/patch-generate"

/** Resolver error codes that should be surfaced as a top-level block (rather
 *  than swallowed into a per-finding refusal). */
const BLOCKING_CODES = new Set([
  "not_authenticated",
  "quota_exceeded",
  "mode_not_in_plan",
  "manual_not_in_plan",
  "missing_hosted_key",
  "billing_db_unconfigured",
  "byok_not_supported",
  "task_not_allowed_in_mode",
])

function statusForCode(code: string): number {
  switch (code) {
    case "not_authenticated":
      return 401
    case "quota_exceeded":
      return 402
    case "missing_hosted_key":
    case "billing_db_unconfigured":
    case "provider_unavailable":
      return 503
    case "byok_not_supported":
      return 400
    default:
      return 403
  }
}

export async function generateFindingPatch(args: GatewayArgs): Promise<GatewayResult> {
  const task = args.task ?? "patch"

  /* ----------------------------- CLOUD ----------------------------- */
  if (cloudGenerationActive()) {
    let creditsUsed = 0
    let quotaRemaining: number | null = null
    let blocked: GatewayBlock | undefined
    let lastModel: string | undefined

    const token = bearerFromRequest(args.req)
    const generate = makeCloudCompletionFn({
      baseUrl: getCloudApiBase(),
      token,
      endpoint: args.cloudEndpoint ?? DEFAULT_CLOUD_ENDPOINT,
      onMeta: (m) => {
        creditsUsed += m.creditsUsed
        quotaRemaining = m.quotaRemaining
      },
      onError: (e) => {
        // Capture the FIRST plan/quota/auth block so the route can return a
        // precise status. Transient/upstream errors fall through and become
        // an ordinary patch refusal.
        if (!blocked && BLOCKING_CODES.has(e.code)) {
          blocked = {
            code: e.code,
            reason: e.reason,
            upgrade: e.upgrade,
            remaining: e.remaining,
            needed: e.needed,
            status: e.status || statusForCode(e.code),
          }
        }
      },
    })

    const preview = await generatePatchPreview({
      projectPath: args.projectPath,
      finding: args.finding,
      plan: args.plan,
      // No local provider/key — the cloud owns the key. `generate` makes the
      // pipeline skip the in-process provider guard entirely.
      provider: "openai_compatible",
      apiKey: null,
      baseUrl: null,
      generate,
      privateCodeMode: !!args.privateCodeMode,
      intelligenceMode: args.intelligenceMode,
      complexity: args.complexity,
      manualModels: args.manualModelSelection as ManualOverrides | undefined,
      neighborhood: args.neighborhood,
    })

    const pv = preview as { modelUsed?: string | null }
    if (typeof pv.modelUsed === "string") lastModel = pv.modelUsed

    if (blocked) {
      return { ok: false, creditsUsed, quotaRemaining, blocked }
    }
    return {
      ok: true,
      preview,
      creditsUsed,
      quotaRemaining,
      model: lastModel,
      provider: "hosted",
    }
  }

  /* ----------------------------- LOCAL ----------------------------- */
  const resolution = await resolveAiProviderForRequestAsync({
    userId: args.session.userId,
    workspaceId: args.session.workspaceId,
    intelligenceMode: args.intelligenceMode,
    task,
    complexity: args.complexity,
    manualModelSelection: args.manualModelSelection ?? null,
  })
  if (!resolution.ok) {
    return {
      ok: false,
      creditsUsed: 0,
      quotaRemaining: null,
      blocked: {
        code: resolution.code,
        reason: resolution.reason,
        upgrade: resolution.upgrade,
        remaining: resolution.remaining,
        needed: resolution.needed,
        status: statusForCode(resolution.code),
      },
    }
  }

  const preview = await generatePatchPreview({
    projectPath: args.projectPath,
    finding: args.finding,
    plan: args.plan,
    provider: resolution.provider,
    apiKey: resolution.apiKey,
    baseUrl: resolution.baseUrl ?? null,
    privateCodeMode: !!args.privateCodeMode,
    intelligenceMode: args.intelligenceMode,
    complexity: args.complexity,
    manualModels: args.manualModelSelection as ManualOverrides | undefined,
    forceModel: resolution.model,
    forceTwoStep: resolution.twoStep,
    neighborhood: args.neighborhood,
  })

  const refused = "refused" in preview && (preview as { refused?: boolean }).refused === true
  let creditsUsed = 0
  if (!refused) {
    creditsUsed = await recordConsumptionAsync({
      userId: args.session.userId,
      workspaceId: args.session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: resolution.estimatedCredits,
      requestId: resolution.requestId,
      status: "success",
      task: String(task),
      intelligenceMode: args.intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
    })
  } else if (resolution.requestId) {
    await recordConsumptionAsync({
      userId: args.session.userId,
      workspaceId: args.session.workspaceId,
      apiKeySource: "hosted",
      estimatedCredits: 0,
      requestId: resolution.requestId,
      status: "failed",
      task: String(task),
      intelligenceMode: args.intelligenceMode,
      model: resolution.model,
      provider: resolution.provider,
      errorClass: "refused",
    })
  }

  return {
    ok: true,
    preview,
    creditsUsed,
    quotaRemaining: resolution.quotaStatus.remaining,
    model: resolution.model,
    provider: resolution.provider,
  }
}
