/**
 * Model Router (NEW FILE → lib/server-model-router.ts)
 *
 * Generalizes the existing `pickModel(finding)` in
 * `lib/server-finding-explanations.ts` (which only tiers explanations by
 * severity) into a task-aware router: it decides the model for
 * explanation / suggestion / patch-plan / patch / bulk work, and applies
 * the escalation rule (start one tier down, bump only on validation
 * failure).
 *
 * It does NOT pick a provider key — that stays with the user's Settings
 * (`lib/model-keys.ts`, getSlotConfig / pickPrimaryProvider). This router
 * only answers "which model id, at which tier". The route handler maps the
 * chosen tier onto whichever provider the user has configured.
 *
 * BYOK reality: the user may only have ONE provider configured. So the
 * router expresses choices as *tiers*, and `resolveModelId` maps a tier to
 * a concrete model within the user's chosen provider, degrading gracefully
 * (if they only gave us OpenAI, "coding flagship" resolves to gpt-4.1, not
 * Claude).
 */

import type { FixClass } from "./fix-planner"

export type FixTask =
  | "explanation"
  | "suggestion"
  | "patch_plan"
  | "patch_simple"
  | "patch_complex"
  | "bulk_cluster"

/** Abstract capability tier, independent of provider. */
export type ModelTier = "cheap" | "mid" | "coding_flagship" | "local"

export type ProviderKind = "openai" | "anthropic" | "google" | "custom"

export interface RouteDecision {
  task: FixTask
  tier: ModelTier
  /** Concrete model id to send, resolved against the user's provider. */
  model: string
  /** Suggested output cap (cost/latency guard). */
  maxTokens: number
  /** Whether this task should use plan-then-diff (two calls). */
  twoStep: boolean
}

/**
 * Per-provider concrete model for each tier. Mirrors lib/model-catalog.ts.
 * If a provider lacks a true "coding flagship" we fall back to its best.
 */
const TIER_MODELS: Record<ProviderKind, Record<ModelTier, string>> = {
  openai: {
    cheap: "gpt-4.1-nano",
    mid: "gpt-4.1-mini",
    coding_flagship: "gpt-4.1",
    local: "gpt-4.1-nano",
  },
  anthropic: {
    cheap: "claude-3-5-haiku-latest",
    mid: "claude-3-5-haiku-latest",
    coding_flagship: "claude-sonnet-4-5-20250929",
    local: "claude-3-5-haiku-latest",
  },
  google: {
    cheap: "gemini-2.5-flash",
    mid: "gemini-2.5-flash",
    coding_flagship: "gemini-2.5-pro",
    local: "gemini-2.5-flash",
  },
  custom: {
    // Local / OpenAI-compatible (Ollama, vLLM). Code never egresses.
    cheap: "qwen2.5-coder:7b",
    mid: "qwen2.5-coder:7b",
    coding_flagship: "qwen2.5-coder:7b",
    local: "qwen2.5-coder:7b",
  },
}

const TASK_TIER: Record<FixTask, ModelTier> = {
  explanation: "cheap",
  suggestion: "mid",
  patch_plan: "mid",
  patch_simple: "mid",
  patch_complex: "coding_flagship",
  bulk_cluster: "mid",
}

const TASK_MAX_TOKENS: Record<FixTask, number> = {
  explanation: 700,
  suggestion: 600,
  patch_plan: 800,
  patch_simple: 1200,
  patch_complex: 2000,
  bulk_cluster: 2000,
}

const TIER_ORDER: ModelTier[] = ["cheap", "mid", "coding_flagship"]

/** Bump a tier up one step (used by escalation). `local` never escalates —
 *  privacy mode must not silently send code to a cloud model. */
export function escalateTier(tier: ModelTier): ModelTier {
  if (tier === "local") return "local"
  const i = TIER_ORDER.indexOf(tier)
  return i < 0 || i === TIER_ORDER.length - 1 ? "coding_flagship" : TIER_ORDER[i + 1]
}

export interface RouteContext {
  task: FixTask
  fixClass?: FixClass
  /** User's configured provider for this run. */
  provider: ProviderKind
  /** Org/privacy toggle: force local, never egress code. */
  privateCodeMode?: boolean
  /** When escalating after a failed validation, the new tier to use. */
  forceTier?: ModelTier
}

/** Choose tier + concrete model + budgets for a task. */
export function routeModel(ctx: RouteContext): RouteDecision {
  let tier: ModelTier = ctx.forceTier ?? TASK_TIER[ctx.task]

  // A complex fix class overrides a soft task tier.
  if (ctx.fixClass === "llm_complex_patch" && tier !== "coding_flagship") {
    tier = "coding_flagship"
  }

  // Privacy mode pins everything to local, regardless of task.
  if (ctx.privateCodeMode) tier = "local"

  const provider = ctx.privateCodeMode ? "custom" : ctx.provider
  const model = TIER_MODELS[provider][tier]

  // Plan-then-diff only for complex patches — gating protects cost/latency.
  const twoStep =
    ctx.task === "patch_complex" || ctx.fixClass === "llm_complex_patch"

  return {
    task: ctx.task,
    tier,
    model,
    maxTokens: TASK_MAX_TOKENS[ctx.task],
    twoStep,
  }
}

/** Map a planner FixClass onto the patch task it should run as. */
export function taskForFixClass(fixClass: FixClass): FixTask | null {
  switch (fixClass) {
    case "llm_simple_patch":
      return "patch_simple"
    case "llm_complex_patch":
      return "patch_complex"
    // template_fix / scanner_rule_fix consume NO model.
    // cannot_fix_safely / needs_user_decision never reach the router.
    default:
      return null
  }
}
