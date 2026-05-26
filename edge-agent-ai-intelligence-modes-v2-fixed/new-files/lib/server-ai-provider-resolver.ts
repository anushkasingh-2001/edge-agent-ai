/**
 * resolveAiProviderForRequest — the ONE place that decides which model
 * runs, with which key, for any AI task in any mode.
 *
 * It composes the existing pieces:
 *   - intelligence-mode policy + complexity routing (routeForMode)
 *   - subscription plan + quota (server-subscription)
 *   - cost/credit estimate (server-cost-controller)
 *
 * Two provider modes:
 *   - "hosted": the backend uses Edge Agent AI's own server-side keys
 *     (from env, NEVER sent to the browser). The user provides no key.
 *   - "byok":   the request/Settings key is used, only when explicitly
 *     selected. Keys are never logged, cached, or echoed.
 *
 * Manual mode fix in this v2 bundle:
 *   - the UI now sends real model ids like "anthropic:claude-sonnet-4-5..."
 *   - the resolver accepts those model ids end-to-end
 *   - tier strings (cheap/mid/coding_flagship/local) are still accepted
 *     for tests and power users
 */

import { routeForMode } from "./server-model-router-ext"
import type { ModelTier, ProviderKind } from "./server-model-router"
import type { IntelligenceMode } from "./context-bundle"
import type { LlmTask, ManualOverrides } from "./intelligence-mode"
import { MODE_POLICIES } from "./intelligence-mode"
import {
  loadSubscription,
  modeAllowed,
  checkQuota,
  consumeCredits,
  type Subscription,
} from "./server-subscription"
import { priceFor } from "./server-cost-controller"
import { BUNDLE_INPUT_TOKEN_CAP } from "./context-bundle"

export type AiProviderMode = "hosted" | "byok"
export type ManualModelSelection = Record<string, string>

export interface ResolveArgs {
  userId: string
  workspaceId: string
  aiProviderMode: AiProviderMode
  intelligenceMode: IntelligenceMode
  task: LlmTask
  /** Manual mode per-task model ids, e.g. { patch: "anthropic:claude-sonnet-4-5..." }. */
  manualModelSelection?: ManualModelSelection | null
  /** Optional complexity inputs for Auto routing. */
  complexity?: number
  /** BYOK only: the caller-supplied key + base URL + provider. */
  byokApiKey?: string | null
  byokBaseUrl?: string | null
  byokProvider?: ProviderKind
  /** Rough token estimate for the credit/cost estimate. */
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
}

export type ResolveResult =
  | {
      ok: true
      provider: ProviderKind
      model: string
      apiKeySource: AiProviderMode
      /** Server-side key for the model call. NEVER send to the client —
       *  use redactForClient() on any response object. */
      apiKey: string | null
      baseUrl: string | null
      bundleMode: string
      twoStep: boolean
      quotaStatus: { remaining: number; total: number }
      estimatedCredits: number
      estimatedCostUsd: number
    }
  | {
      ok: false
      /** Why the request was blocked (shown to the user). */
      reason: string
      /** Machine code so the UI can render upgrade vs quota vs auth. */
      code:
        | "mode_not_in_plan"
        | "manual_not_in_plan"
        | "quota_exceeded"
        | "missing_byok_key"
        | "missing_hosted_key"
        | "task_not_allowed_in_mode"
      /** For upgrade prompts. */
      upgrade?: boolean
      quotaStatus?: { remaining: number; total: number }
    }

/** USD→credits conversion. 1 credit = $0.001 by default (1000 credits/$). */
const USD_PER_CREDIT = Number(process.env.EDGE_AGENT_USD_PER_CREDIT ?? "0.001")

const TIER_VALUES = new Set<ModelTier>(["cheap", "mid", "coding_flagship", "local"])

const TASK_ALIASES: Record<LlmTask, string[]> = {
  explain: ["explain", "explanation"],
  root_cause: ["root_cause", "rootCause", "root-cause"],
  suggest: ["suggest", "suggestion"],
  patch: ["patch", "patch_generation", "patchGeneration"],
  bulk: ["bulk", "bulk_fix", "bulkFix"],
  verify: ["verify", "verifier"],
}

function usdToCredits(usd: number): number {
  if (!Number.isFinite(USD_PER_CREDIT) || USD_PER_CREDIT <= 0) return Math.ceil(usd * 1000)
  return Math.ceil(usd / USD_PER_CREDIT)
}

function providerKindFromSlot(slot: string | undefined): ProviderKind | null {
  switch (slot) {
    case "openai":
    case "openai_compatible":
      return "openai_compatible"
    case "anthropic":
      return "anthropic"
    case "google":
      return "google"
    case "custom":
      return "custom"
    default:
      return null
  }
}

function providerSlotFromKind(provider: ProviderKind): string {
  return provider === "openai_compatible" ? "openai" : provider
}

function selectedManualValue(selection: ManualModelSelection | null | undefined, task: LlmTask): string | undefined {
  if (!selection) return undefined
  for (const key of TASK_ALIASES[task]) {
    const value = selection[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function parseManualSelection(value: string | undefined):
  | { kind: "none" }
  | { kind: "tier"; tier: ModelTier }
  | { kind: "model"; provider: ProviderKind | null; model: string } {
  if (!value) return { kind: "none" }
  if (TIER_VALUES.has(value as ModelTier)) return { kind: "tier", tier: value as ModelTier }

  const colon = value.indexOf(":")
  if (colon > 0) {
    const slot = value.slice(0, colon)
    const model = value.slice(colon + 1).trim()
    if (model) return { kind: "model", provider: providerKindFromSlot(slot), model }
  }
  return { kind: "model", provider: null, model: value }
}

function manualTierOverrides(selection: ManualModelSelection | null | undefined): ManualOverrides | undefined {
  if (!selection) return undefined
  const out: ManualOverrides = {}
  for (const task of Object.keys(TASK_ALIASES) as LlmTask[]) {
    const parsed = parseManualSelection(selectedManualValue(selection, task))
    if (parsed.kind === "tier") out[task] = parsed.tier
  }
  return Object.keys(out).length ? out : undefined
}

/** Hosted server-side key for a provider. Reads env ONLY (never client). */
function hostedKeyFor(provider: ProviderKind): { apiKey: string | null; baseUrl: string | null } {
  switch (provider) {
    case "anthropic":
      return { apiKey: process.env.EDGE_AGENT_HOSTED_ANTHROPIC_KEY ?? null, baseUrl: process.env.EDGE_AGENT_HOSTED_ANTHROPIC_BASE ?? null }
    case "google":
      return { apiKey: process.env.EDGE_AGENT_HOSTED_GOOGLE_KEY ?? null, baseUrl: process.env.EDGE_AGENT_HOSTED_GOOGLE_BASE ?? null }
    case "openai_compatible":
    case "custom":
    default:
      return {
        apiKey: process.env.EDGE_AGENT_HOSTED_OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? null,
        baseUrl: process.env.EDGE_AGENT_HOSTED_OPENAI_BASE ?? null,
      }
  }
}

/** Which provider hosted mode should use for a given mode. */
function hostedProviderFor(_mode: IntelligenceMode): ProviderKind {
  const env = (process.env.EDGE_AGENT_HOSTED_PROVIDER ?? "").trim()
  const provider = providerKindFromSlot(env)
  return provider ?? "openai_compatible"
}

/**
 * Pure decision + plan/quota enforcement; does NOT call a model. Routes call
 * this, then (on ok) call the model and finally `recordConsumption()` with
 * the actual or estimated cost.
 */
export function resolveAiProviderForRequest(args: ResolveArgs): ResolveResult {
  const sub: Subscription = loadSubscription(args.userId, args.workspaceId)

  if (!modeAllowed(sub, args.intelligenceMode)) {
    return {
      ok: false,
      code: "mode_not_in_plan",
      upgrade: true,
      reason: `Your ${sub.tier} plan does not include ${args.intelligenceMode.toUpperCase()} mode. Upgrade to use it.`,
      quotaStatus: { remaining: Math.max(0, sub.creditsTotal - sub.creditsUsed), total: sub.creditsTotal },
    }
  }

  if (args.intelligenceMode === "manual" && !sub.allowManualModelSelection) {
    return {
      ok: false,
      code: "manual_not_in_plan",
      upgrade: true,
      reason: `Manual model selection is not available on the ${sub.tier} plan. Upgrade to choose models per task.`,
    }
  }

  const policy = MODE_POLICIES[args.intelligenceMode]
  if ((args.task === "patch" || args.task === "bulk") && !policy.allowPatchGeneration) {
    return {
      ok: false,
      code: "task_not_allowed_in_mode",
      reason: `${args.intelligenceMode.toUpperCase()} mode does not generate patches; it provides deterministic suggestions only.`,
    }
  }

  const manual = args.intelligenceMode === "manual"
    ? parseManualSelection(selectedManualValue(args.manualModelSelection, args.task))
    : { kind: "none" as const }

  let provider: ProviderKind
  let apiKey: string | null
  let baseUrl: string | null

  if (args.aiProviderMode === "byok") {
    if (!args.byokApiKey) {
      return { ok: false, code: "missing_byok_key", reason: "BYOK selected but no API key was provided." }
    }
    provider = args.byokProvider ?? (manual.kind === "model" && manual.provider ? manual.provider : "openai_compatible")
    apiKey = args.byokApiKey
    baseUrl = args.byokBaseUrl ?? null
  } else {
    provider = manual.kind === "model" && manual.provider ? manual.provider : hostedProviderFor(args.intelligenceMode)
    const hosted = hostedKeyFor(provider)
    apiKey = hosted.apiKey
    baseUrl = hosted.baseUrl
    if (!apiKey) {
      return {
        ok: false,
        code: "missing_hosted_key",
        reason: `Hosted AI is not configured for ${providerSlotFromKind(provider)}. Add a server-side hosted key or switch to BYOK.`,
      }
    }
  }

  const decision = routeForMode({
    mode: args.intelligenceMode,
    task: args.task,
    complexity: typeof args.complexity === "number" ? args.complexity : 0,
    provider,
    manual: manualTierOverrides(args.manualModelSelection),
  })

  const selectedModel = manual.kind === "model" ? manual.model : decision.model

  const price = priceFor(selectedModel, provider)
  const inTok = args.estimatedInputTokens ?? BUNDLE_INPUT_TOKEN_CAP[decision.bundleMode]
  const outTok = args.estimatedOutputTokens ?? decision.maxTokens
  const estimatedCostUsd = (inTok / 1000) * price.inputPer1k + (outTok / 1000) * price.outputPer1k
  const estimatedCredits = usdToCredits(estimatedCostUsd)

  if (args.aiProviderMode === "hosted") {
    const q = checkQuota(sub, estimatedCredits)
    if (!q.ok) {
      return {
        ok: false,
        code: "quota_exceeded",
        reason: q.reason ?? "AI credit quota exceeded.",
        quotaStatus: { remaining: q.remaining, total: sub.creditsTotal },
      }
    }
  }

  return {
    ok: true,
    provider,
    model: selectedModel,
    apiKeySource: args.aiProviderMode,
    apiKey,
    baseUrl,
    bundleMode: decision.bundleMode,
    twoStep: decision.twoStep,
    quotaStatus: { remaining: Math.max(0, sub.creditsTotal - sub.creditsUsed), total: sub.creditsTotal },
    estimatedCredits,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(5)),
  }
}

/** Record actual consumption after a successful hosted model call. */
export function recordConsumption(args: {
  userId: string
  workspaceId: string
  apiKeySource: AiProviderMode
  actualCostUsd: number
}): number {
  if (args.apiKeySource !== "hosted") return 0
  const credits = usdToCredits(args.actualCostUsd)
  consumeCredits(args.userId, args.workspaceId, credits)
  return credits
}

/** Strip secret fields from a resolve result before it goes into an API response. */
export function redactForClient(
  r: Extract<ResolveResult, { ok: true }>,
): Omit<Extract<ResolveResult, { ok: true }>, "apiKey" | "baseUrl"> & { apiKey: null; baseUrl: null } {
  return { ...r, apiKey: null, baseUrl: null }
}
