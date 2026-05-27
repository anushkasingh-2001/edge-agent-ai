/**
 * resolveAiProviderForRequest — the ONE place that decides which model
 * runs, with which key, for any AI task in any mode.
 *
 * **MVP contract (BYOK-only).**
 *
 * As of the BYOK-only simplification this resolver:
 *   - REQUIRES a caller-supplied API key. There is no hosted/managed
 *     key path, no `process.env.*_API_KEY` fallback, no default cloud
 *     credentials. If the caller doesn't pass `byokApiKey`, the result
 *     is `{ ok: false, code: "missing_api_key" }`.
 *   - Records ZERO credits. Billing is whatever the user's provider
 *     bills them directly; the app never debits an internal balance.
 *   - Still composes the existing decision pieces:
 *       - intelligence-mode policy + complexity routing (routeForMode)
 *       - subscription plan + manual-mode gate (server-subscription) —
 *         used only for plan eligibility (`modeAllowed` /
 *         `allowManualModelSelection`); quota/credit checks are gone.
 *
 * Manual mode:
 *   - The UI sends real model ids like "anthropic:claude-sonnet-4-5-…".
 *   - The resolver parses those end-to-end.
 *   - Tier strings (cheap/mid/coding_flagship/local) are still accepted
 *     for tests and power users.
 *
 * Reading these enums:
 *   - `aiProviderMode` is kept on the type so older callers still
 *     compile, but only `"byok"` produces an `ok: true` result. The
 *     legacy `"hosted"` value is treated identically to a missing key
 *     and returns `missing_api_key` so there is no silent fallback.
 */

import { routeForMode } from "./server-model-router-ext"
import type { ModelTier, ProviderKind } from "./server-model-router"
import type { IntelligenceMode } from "./context-bundle"
import type { LlmTask, ManualOverrides } from "./intelligence-mode"
import { MODE_POLICIES } from "./intelligence-mode"
import {
  loadSubscription,
  modeAllowed,
  type Subscription,
} from "./server-subscription"
import { priceFor } from "./server-cost-controller"
import { BUNDLE_INPUT_TOKEN_CAP } from "./context-bundle"

// Re-exported from the shared schema module so the server-side
// resolver and the client toggle component agree on the wire enum.
export type { AiProviderMode } from "./context-bundle"
import type { AiProviderMode } from "./context-bundle"
export type ManualModelSelection = Record<string, string>

export interface ResolveArgs {
  userId: string
  workspaceId: string
  /** Retained on the type for legacy callers. Only `"byok"` succeeds;
   *  `"hosted"` is treated the same as a missing key. */
  aiProviderMode: AiProviderMode
  intelligenceMode: IntelligenceMode
  task: LlmTask
  /** Manual mode per-task model ids, e.g. { patch: "anthropic:claude-sonnet-4-5..." }. */
  manualModelSelection?: ManualModelSelection | null
  /** Optional complexity inputs for Auto routing. */
  complexity?: number
  /** Caller-supplied BYOK API key. REQUIRED — there is no env fallback. */
  byokApiKey?: string | null
  /** Optional OpenAI-compatible base URL override. */
  byokBaseUrl?: string | null
  /** Caller-supplied provider kind (when omitted we derive from the
   *  Manual map; otherwise default to openai_compatible). */
  byokProvider?: ProviderKind
  /** Rough token estimate for the per-request cost echo. */
  estimatedInputTokens?: number
  estimatedOutputTokens?: number
}

export type ResolveResult =
  | {
      ok: true
      provider: ProviderKind
      model: string
      /** Always `"byok"` post-MVP — the only `ok: true` shape. */
      apiKeySource: "byok"
      /** Server-side key for the model call. NEVER send to the client —
       *  use redactForClient() on any response object. */
      apiKey: string
      baseUrl: string | null
      bundleMode: string
      twoStep: boolean
      /** Held at zero post-MVP: the app does not own a credit balance. */
      quotaStatus: { remaining: number; total: number }
      /** Held at zero — see quotaStatus. Retained on the type so older
       *  callers compile without a refactor. */
      estimatedCredits: number
      /** Best-effort cost echo so the UI can display "≈ $X for this
       *  call". Informational only; the user is billed by their own
       *  provider, not by us. */
      estimatedCostUsd: number
    }
  | {
      ok: false
      /** Plain-English reason suitable for end-user display. */
      reason: string
      /** Machine code so the UI can branch render. */
      code:
        | "mode_not_in_plan"
        | "manual_not_in_plan"
        | "missing_api_key"
        | "invalid_api_key"
        | "task_not_allowed_in_mode"
      /** For upgrade prompts. */
      upgrade?: boolean
    }

const TIER_VALUES = new Set<ModelTier>(["cheap", "mid", "coding_flagship", "local"])

const TASK_ALIASES: Record<LlmTask, string[]> = {
  explain: ["explain", "explanation"],
  root_cause: ["root_cause", "rootCause", "root-cause"],
  suggest: ["suggest", "suggestion"],
  patch: ["patch", "patch_generation", "patchGeneration"],
  bulk: ["bulk", "bulk_fix", "bulkFix"],
  verify: ["verify", "verifier"],
}

const MISSING_KEY_MESSAGE =
  "API key not provided. Add your provider key in Settings to use AI explanations and fixes."

const INVALID_KEY_MESSAGE =
  "API key is invalid or the selected model is not available. Check your Settings and try again."

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

/**
 * Pure decision + plan-eligibility enforcement; does NOT call a model.
 * Returns the resolved (provider, model, key, base URL) the caller
 * must then forward to the actual upstream client.
 */
export function resolveAiProviderForRequest(args: ResolveArgs): ResolveResult {
  const sub: Subscription = loadSubscription(args.userId, args.workspaceId)

  // Plan eligibility for the selected intelligence mode. This is a
  // local invariant (everyone is on the same single plan today) but
  // we keep the gate so a future multi-tier deployment doesn't have
  // to re-thread it through every caller.
  if (!modeAllowed(sub, args.intelligenceMode)) {
    return {
      ok: false,
      code: "mode_not_in_plan",
      upgrade: true,
      reason: `Your ${sub.tier} plan does not include ${args.intelligenceMode.toUpperCase()} mode. Upgrade to use it.`,
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

  // BYOK-only: a caller-provided key is the ONLY acceptable credential.
  // We deliberately do not look at process.env keys here. Returning
  // a structured `missing_api_key` lets the routes surface the canonical
  // "Add your provider key in Settings…" message rather than silently
  // serving a template fallback or worse, billing a hidden default key.
  const callerKey = typeof args.byokApiKey === "string" ? args.byokApiKey.trim() : ""
  if (!callerKey) {
    return {
      ok: false,
      code: "missing_api_key",
      reason: MISSING_KEY_MESSAGE,
    }
  }

  const manual = args.intelligenceMode === "manual"
    ? parseManualSelection(selectedManualValue(args.manualModelSelection, args.task))
    : { kind: "none" as const }

  const provider: ProviderKind =
    args.byokProvider ??
    (manual.kind === "model" && manual.provider ? manual.provider : "openai_compatible")

  const baseUrl = typeof args.byokBaseUrl === "string" && args.byokBaseUrl.trim()
    ? args.byokBaseUrl.trim()
    : null

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

  return {
    ok: true,
    provider,
    model: selectedModel,
    apiKeySource: "byok",
    apiKey: callerKey,
    baseUrl,
    bundleMode: decision.bundleMode,
    twoStep: decision.twoStep,
    // The app doesn't own a credit balance. Held at zero so legacy
    // response shape is preserved without misleading the UI.
    quotaStatus: { remaining: 0, total: 0 },
    estimatedCredits: 0,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(5)),
  }
}

/**
 * No-op consumption recorder.
 *
 * Kept on the public surface so existing API routes don't need
 * structural edits, but no credits are ever debited. The user's
 * upstream provider bills them directly.
 */
export function recordConsumption(_args: {
  userId: string
  workspaceId: string
  apiKeySource: AiProviderMode | "byok"
  actualCostUsd: number
}): number {
  return 0
}

/**
 * Classify an upstream provider error as `invalid_api_key` /
 * `model_unavailable` / other. Routes call this when the upstream
 * client surfaces a 4xx so the user sees the canonical message.
 */
export function classifyUpstreamFailure(status: number, message?: string):
  | { code: "invalid_api_key"; reason: string }
  | { code: "model_unavailable"; reason: string }
  | { code: "other"; reason: string } {
  const text = (message ?? "").toLowerCase()
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|unauthorized/.test(text)) {
    return { code: "invalid_api_key", reason: INVALID_KEY_MESSAGE }
  }
  if (status === 404 || /model.*not.*found|no such model|model_not_found/.test(text)) {
    return { code: "model_unavailable", reason: INVALID_KEY_MESSAGE }
  }
  return { code: "other", reason: message ?? "Upstream model call failed." }
}

/** Strip secret fields from a resolve result before it goes into an API response. */
export function redactForClient(
  r: Extract<ResolveResult, { ok: true }>,
): Omit<Extract<ResolveResult, { ok: true }>, "apiKey" | "baseUrl"> & { apiKey: null; baseUrl: null } {
  return { ...r, apiKey: null, baseUrl: null }
}

// Messages exported so routes and tests can reference the canonical
// strings without re-declaring them.
export const BYOK_MESSAGES = {
  missing: MISSING_KEY_MESSAGE,
  invalid: INVALID_KEY_MESSAGE,
} as const
