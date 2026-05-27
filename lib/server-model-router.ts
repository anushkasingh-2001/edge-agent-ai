/**
 * Model Router.
 *
 * Generalises the existing `pickModel(finding)` in
 * `lib/server-finding-explanations.ts` (which only tiers explanations by
 * severity) into a task-aware router: it decides the model for
 * explanation / suggestion / patch-plan / patch / bulk work, and applies
 * the escalation rule (start at the task's normal tier; bump only on
 * validation failure for cheap-tier patches).
 *
 * It does NOT pick a provider key — that stays with the user's Settings
 * (`lib/model-keys.ts`). This router only answers "which model id, at
 * which tier". The route handler maps the chosen model onto whichever
 * provider the user has configured.
 *
 * Provider naming
 * ---------------
 * The user-facing provider id type in `lib/model-keys.ts` is
 *   `ProviderType = "openai_compatible" | "anthropic" | "google"`
 * (the scaffold used `"openai"`, which would silently break at runtime).
 * We mirror that here and accept `"custom"` as an alias for an
 * OpenAI-compatible BYOK endpoint (Ollama / vLLM / LiteLLM).
 *
 * Env overrides (per integration brief §4)
 * ----------------------------------------
 *   EDGE_AGENT_FIX_MODEL          → default model for patch_simple /
 *                                   patch_complex / bulk_cluster /
 *                                   patch_plan (overrides `gpt-4.1`).
 *   EDGE_AGENT_FIX_DEEP_MODEL     → optional separate model for the
 *                                   complex/escalated tier; falls back
 *                                   to FIX_MODEL when unset.
 *   EDGE_AGENT_EXPLAINER_MODEL    → already honoured by
 *                                   server-finding-explanations.ts;
 *                                   re-used here so the "explanation"
 *                                   task agrees with what the explain
 *                                   route ships (gpt-4.1-mini).
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

/**
 * Mirrors `ProviderType` in `lib/model-keys.ts` exactly, plus a
 * `"custom"` alias so callers that read the `LlmSlot` namespace
 * (`"openai" | "anthropic" | "google" | "custom"`) don't have to
 * translate. `"openai"` is intentionally NOT a member — use
 * `"openai_compatible"`, which is what the saved provider config
 * actually carries.
 */
export type ProviderKind =
  | "openai_compatible"
  | "anthropic"
  | "google"
  | "custom"

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

/* ------------------------------------------------------------------ *
 *  Defaults & env wiring                                             *
 * ------------------------------------------------------------------ */

function envOr(envKey: string, fallback: string): string {
  const v = (process.env[envKey] ?? "").trim()
  return v || fallback
}

/**
 * Per-provider concrete model id for each tier. Designed so a user
 * with one configured provider still gets a sane choice for every
 * task — even if that provider doesn't have a true "coding flagship",
 * we map to its best available model rather than silently disabling
 * the feature.
 *
 * Tier defaults come from env vars when set, which means a self-hosted
 * deployment can pin the entire fix system to one model by exporting
 * EDGE_AGENT_FIX_MODEL without touching code.
 */
function tierModels(): Record<ProviderKind, Record<ModelTier, string>> {
  const cheap = envOr("EDGE_AGENT_EXPLAINER_MODEL", "gpt-4.1-mini")
  const mid = envOr("EDGE_AGENT_FIX_MODEL", "gpt-4.1")
  const flagship = envOr("EDGE_AGENT_FIX_DEEP_MODEL", mid)
  return {
    openai_compatible: {
      cheap,
      mid,
      coding_flagship: flagship,
      // `local` means "do not egress to a cloud provider". For the
      // openai_compatible slot that's whatever the user pointed
      // baseUrl at (Ollama, vLLM, LiteLLM). We pass through the same
      // cheap model id so the slot's catalog entry still resolves.
      local: cheap,
    },
    anthropic: {
      // Intelligence-mode → model mapping for Anthropic:
      //   Save  (cheap)            → claude-haiku-4-5
      //   Auto  (mid)              → claude-sonnet-4-6
      //   Pro   (coding_flagship)  → claude-sonnet-4-6
      //   Max   (coding_flagship)  → claude-opus-4-7  (overridden in
      //                              routeForMode — see ext layer)
      //   Manual                   → exact user-selected model id.
      //
      // The mode/tier matrix only exposes one `coding_flagship` slot,
      // so Max's claude-opus-4-7 selection lives in the ext layer
      // (lib/server-model-router-ext.ts). Anything that asks for
      // coding_flagship here gets the Sonnet default, matching Pro's
      // expectation; Max post-processes to Opus after routeModel runs.
      cheap: "claude-haiku-4-5",
      mid: "claude-sonnet-4-6",
      coding_flagship: "claude-sonnet-4-6",
      local: "claude-haiku-4-5",
    },
    google: {
      cheap: "gemini-2.5-flash",
      mid: "gemini-2.5-flash",
      coding_flagship: "gemini-2.5-pro",
      local: "gemini-2.5-flash",
    },
    custom: {
      // OpenAI-compatible BYOK (Ollama / vLLM / LiteLLM). Code can
      // stay on the user's machine. Model name is whatever they
      // configured.
      cheap: "qwen2.5-coder:7b",
      mid: "qwen2.5-coder:7b",
      coding_flagship: "qwen2.5-coder:7b",
      local: "qwen2.5-coder:7b",
    },
  }
}

const TASK_TIER: Record<FixTask, ModelTier> = {
  explanation: "cheap", // gpt-4.1-mini (matches /api/finding/explain)
  suggestion: "mid", // gpt-4.1 by default; EDGE_AGENT_FIX_MODEL overrides
  patch_plan: "mid",
  patch_simple: "mid",
  patch_complex: "coding_flagship",
  bulk_cluster: "mid",
}

const TASK_MAX_TOKENS: Record<FixTask, number> = {
  explanation: 700,
  suggestion: 600,
  patch_plan: 800,
  patch_simple: 1500,
  patch_complex: 2500,
  bulk_cluster: 2000,
}

const TIER_ORDER: ModelTier[] = ["cheap", "mid", "coding_flagship"]

/**
 * Bump a tier up one step (used by escalation on validation failure).
 * `local` never escalates — privacy mode must not silently send code
 * to a cloud model just because the cheap local model didn't validate.
 */
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
  const model = tierModels()[provider][tier]

  // Plan-then-diff only for complex patches — gating protects
  // cost/latency.
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

/* ------------------------------------------------------------------ *
 *  Test helpers                                                       *
 * ------------------------------------------------------------------ */

/** @internal Exposed so tests can assert env-driven model selection
 *  without mutating module-level state from other tests. */
export function _resolveModelForTests(
  provider: ProviderKind,
  tier: ModelTier,
): string {
  return tierModels()[provider][tier]
}
