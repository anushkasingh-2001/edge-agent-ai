/**
 * Model Router Extension (intelligence-mode aware).
 *
 * The existing `lib/server-model-router.ts` already resolves a concrete
 * model id from (task, tier, provider) and owns the env overrides +
 * escalation ladder. This module is a THIN layer on top that:
 *
 *   1. Maps an intelligence mode + LlmTask + complexity → a concrete
 *      RouteDecision by delegating to the existing `routeModel`.
 *   2. Resolves the per-tier model id for ANY wired provider (so the
 *      cost estimate and Manual selector can show real ids across
 *      OpenAI / Anthropic / Google / custom).
 *   3. Carries the chosen ContextBundle mode + output cap alongside the
 *      model decision so the pipeline has everything in one object.
 *
 * It deliberately does NOT duplicate `routeModel`'s logic — drift would
 * be a bug. It calls it. The only thing it adds is the mode/complexity
 * front-end and the provider-wide tier→id table for display/estimate.
 */

import {
  routeModel,
  escalateTier,
  _resolveModelForTests,
  type ModelTier,
  type ProviderKind,
  type RouteDecision,
  type FixTask,
} from "./server-model-router"
import {
  routeTaskForMode,
  type LlmTask,
  type ManualOverrides,
} from "./intelligence-mode"
import type { IntelligenceMode, ContextBundleMode } from "./context-bundle"

/** LlmTask → the FixTask the underlying router understands. */
function fixTaskFor(task: LlmTask, twoStep: boolean): FixTask {
  switch (task) {
    case "explain":
      return "explanation"
    case "suggest":
      return "suggestion"
    case "root_cause":
      return "patch_plan"
    case "patch":
      return twoStep ? "patch_complex" : "patch_simple"
    case "bulk":
      return "bulk_cluster"
    case "verify":
      return "explanation" // verifier uses the cheap tier
  }
}

export interface ModeRouteDecision extends RouteDecision {
  mode: IntelligenceMode
  llmTask: LlmTask
  bundleMode: ContextBundleMode
  cascade: boolean
  /** The tier to use if the cascade escalates after a failed validation. */
  escalatedTier: ModelTier
  escalatedModel: string
}

export interface ModeRouteContext {
  mode: IntelligenceMode
  task: LlmTask
  complexity: number
  provider: ProviderKind
  privateCodeMode?: boolean
  manual?: ManualOverrides
  /** Force a specific tier (used when re-running after validation fail). */
  forceTier?: ModelTier
}

/**
 * Resolve the full routing decision for a mode + task. Single call the
 * route handlers use; returns the model id, bundle mode, output cap,
 * cascade flag, and the pre-computed escalation target.
 */
export function routeForMode(ctx: ModeRouteContext): ModeRouteDecision {
  const t = routeTaskForMode(ctx.mode, ctx.task, ctx.complexity, ctx.manual)
  const tier = ctx.forceTier ?? t.tier
  const fixTask = fixTaskFor(ctx.task, t.twoStep)

  const decision = routeModel({
    task: fixTask,
    provider: ctx.provider,
    privateCodeMode: ctx.privateCodeMode,
    forceTier: tier,
  })

  // Mode-specific Anthropic upgrade:
  //   Max + coding_flagship → claude-opus-4-7
  // The tier table can only carry one `coding_flagship` model per
  // provider, so Pro stays on Sonnet (the spec's Pro default) and
  // Max bumps to Opus here. Manual mode bypasses this branch because
  // the user-selected model id wins inside the resolver.
  if (
    ctx.provider === "anthropic" &&
    ctx.mode === "max" &&
    tier === "coding_flagship"
  ) {
    decision.model = process.env.EDGE_AGENT_ANTHROPIC_MAX_MODEL ?? "claude-opus-4-7"
  }

  const escTier = escalateTier(tier)
  let escModel = _resolveModelForTests(
    ctx.privateCodeMode ? "custom" : ctx.provider,
    escTier,
  )
  // Same Max+Anthropic upgrade for the escalation target so a cascade
  // never silently drops back from Opus to Sonnet.
  if (
    !ctx.privateCodeMode &&
    ctx.provider === "anthropic" &&
    ctx.mode === "max" &&
    escTier === "coding_flagship"
  ) {
    escModel = process.env.EDGE_AGENT_ANTHROPIC_MAX_MODEL ?? "claude-opus-4-7"
  }

  return {
    ...decision,
    mode: ctx.mode,
    llmTask: ctx.task,
    bundleMode: t.bundleMode,
    cascade: t.cascade,
    twoStep: t.twoStep,
    escalatedTier: escTier,
    escalatedModel: escModel,
  }
}

/**
 * Provider-wide tier→model id table, for the Manual selector + the cost
 * estimate (which needs to price every tier across providers). Pulls
 * from the same source of truth as `routeModel` via the test helper, so
 * env overrides are respected.
 */
export function tierTableForProvider(
  provider: ProviderKind,
): Record<ModelTier, string> {
  return {
    cheap: _resolveModelForTests(provider, "cheap"),
    mid: _resolveModelForTests(provider, "mid"),
    coding_flagship: _resolveModelForTests(provider, "coding_flagship"),
    local: _resolveModelForTests(provider, "local"),
  }
}
