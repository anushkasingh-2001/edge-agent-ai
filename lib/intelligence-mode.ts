/**
 * Intelligence Mode — the single policy layer for the five modes.
 *
 *   1. save    Deterministic + Explain. LLM only explains an opened
 *              finding. No LLM finding-truth, no LLM patch by default.
 *   2. auto    Smart routing. Scanner first; LLM only when it adds
 *              value; cheap→strong cascade; escalate on validation fail.
 *   3. pro     Stronger model + larger graph neighborhood, single shot.
 *   4. max     Best model; plan→patch→validate(parse/test/re-scan).
 *   5. manual  Per-task model selection; all guardrails still enforced.
 *
 * This module decides WHAT a mode is allowed to do and HOW heavy the
 * context/model should be. It never calls a model itself — it produces
 * a `ModePolicy` + `TaskRouting` that the route handlers + pipeline
 * consume. The scanner remains the sole source of finding truth.
 */

import type { IntelligenceMode, ContextBundleMode } from "./context-bundle"
import { bundleModeFor } from "./context-bundle"
import type { ModelTier, ProviderKind } from "./server-model-router"

export type LlmTask =
  | "explain"
  | "root_cause"
  | "suggest"
  | "patch"
  | "bulk"
  | "verify"

/** What a mode permits. Enforced in the route handlers. */
export interface ModePolicy {
  mode: IntelligenceMode
  /** May the LLM be used for explanation at all? (all modes: yes) */
  allowExplain: boolean
  /** May the LLM generate a patch automatically? save = false. */
  allowPatchGeneration: boolean
  /** Use plan-then-patch (two-phase)? max = true. */
  planThenPatch: boolean
  /** Run sandbox parse/test/re-scan validation before marking fixed? */
  validateInSandbox: boolean
  /** Escalate model tier on validation failure? */
  escalateOnFailure: boolean
  /** Default tier for explanation. */
  explainTier: ModelTier
  /** Default tier for root-cause reasoning / suggestion. */
  reasonTier: ModelTier
  /** Default tier for patch generation. */
  patchTier: ModelTier
  /** Hard ceiling: never auto-apply; user must click. (all modes: true) */
  neverAutoApply: true
}

export const MODE_POLICIES: Record<IntelligenceMode, ModePolicy> = {
  save: {
    mode: "save",
    allowExplain: true,
    allowPatchGeneration: false, // suggestions/templates only
    planThenPatch: false,
    validateInSandbox: true, // even template fixes re-scan
    escalateOnFailure: false,
    explainTier: "cheap",
    reasonTier: "cheap",
    patchTier: "cheap",
    neverAutoApply: true,
  },
  auto: {
    mode: "auto",
    allowExplain: true,
    allowPatchGeneration: true,
    planThenPatch: false, // upgraded per-finding by complexity
    validateInSandbox: true,
    escalateOnFailure: true,
    explainTier: "cheap",
    reasonTier: "mid",
    patchTier: "mid",
    neverAutoApply: true,
  },
  pro: {
    mode: "pro",
    allowExplain: true,
    allowPatchGeneration: true,
    planThenPatch: false,
    validateInSandbox: true,
    escalateOnFailure: true,
    explainTier: "mid",
    reasonTier: "coding_flagship",
    patchTier: "coding_flagship",
    neverAutoApply: true,
  },
  max: {
    mode: "max",
    allowExplain: true,
    allowPatchGeneration: true,
    planThenPatch: true,
    validateInSandbox: true,
    escalateOnFailure: true,
    explainTier: "mid",
    reasonTier: "coding_flagship",
    patchTier: "coding_flagship",
    neverAutoApply: true,
  },
  manual: {
    mode: "manual",
    allowExplain: true,
    allowPatchGeneration: true,
    planThenPatch: false, // user can request via per-task choice
    validateInSandbox: true, // never disabled by user
    escalateOnFailure: false, // manual = user controls the model
    explainTier: "cheap",
    reasonTier: "mid",
    patchTier: "coding_flagship",
    neverAutoApply: true,
  },
}

/* ------------------------------------------------------------------ *
 *  Complexity scoring (drives Auto's cheap→strong decision)          *
 * ------------------------------------------------------------------ */

export interface ComplexityInput {
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  /** distinct files on the evidence path. */
  evidencePathFiles?: number
  /** number of hops on the evidence path. */
  evidencePathLen?: number
  /** sink kind from IR if available. */
  sinkKind?: string
  /** callers within 2 hops, if known. */
  callerCount?: number
  /** a guard exists on SOME but not all paths. */
  partialGuard?: boolean
  crossLanguage?: boolean
}

const CRITICAL_RULES = new Set([
  "llm-codegen-to-exec",
  "cypher-injection-from-llm-or-user",
  "user-input-dangerous-code",
  "config-controlled-file-read",
  "env-proxy-mutation",
])

const HEAVY_SINK_KINDS = new Set(["code_exec", "cypher", "env_mutation"])

/** 0..1 complexity score. >0.65 ⇒ strong model directly; <0.30 ⇒ cheap. */
export function scoreComplexity(input: ComplexityInput): number {
  const pathLenNorm = Math.min(1, (input.evidencePathLen ?? 1) / 5)
  const callerNorm = Math.min(1, (input.callerCount ?? 0) / 6)
  const crossFile = (input.evidencePathFiles ?? 1) > 1 ? 1 : 0
  const crossLang = input.crossLanguage ? 1 : 0
  const heavySink = input.sinkKind && HEAVY_SINK_KINDS.has(input.sinkKind) ? 1 : 0
  const critical = CRITICAL_RULES.has(input.rule_id) ? 1 : 0
  const partial = input.partialGuard ? 1 : 0

  const score =
    0.2 * pathLenNorm +
    0.2 * crossFile +
    0.15 * crossLang +
    0.15 * heavySink +
    0.1 * callerNorm +
    0.1 * partial +
    0.1 * critical

  return Math.max(0, Math.min(1, Number(score.toFixed(4))))
}

export type ComplexityBucket = "cheap" | "cascade" | "strong"

export function complexityBucket(score: number): ComplexityBucket {
  if (score < 0.3) return "cheap"
  if (score <= 0.65) return "cascade"
  return "strong"
}

/* ------------------------------------------------------------------ *
 *  Per-task routing under a mode                                     *
 * ------------------------------------------------------------------ */

export interface TaskRouting {
  task: LlmTask
  bundleMode: ContextBundleMode
  tier: ModelTier
  /** For Auto cascade: start cheap, allow one escalation. */
  cascade: boolean
  /** Two-phase plan→patch for this task? */
  twoStep: boolean
}

/** Manual mode lets the user pin a tier per task. */
export interface ManualOverrides {
  explain?: ModelTier
  root_cause?: ModelTier
  suggest?: ModelTier
  patch?: ModelTier
  bulk?: ModelTier
  verify?: ModelTier
}

export function routeTaskForMode(
  mode: IntelligenceMode,
  task: LlmTask,
  complexity: number,
  manual?: ManualOverrides,
): TaskRouting {
  const policy = MODE_POLICIES[mode]
  const bundleTask =
    task === "explain"
      ? "explain"
      : task === "patch" || task === "bulk"
        ? "patch"
        : task === "root_cause"
          ? "root_cause"
          : "suggest"
  const bundleMode = bundleModeFor(mode, bundleTask as never)

  // Manual: honour the user's per-task tier, fall back to mode defaults.
  if (mode === "manual" && manual) {
    const tier =
      manual[task] ??
      (task === "explain"
        ? policy.explainTier
        : task === "patch" || task === "bulk"
          ? policy.patchTier
          : policy.reasonTier)
    return { task, bundleMode, tier, cascade: false, twoStep: false }
  }

  // Auto: complexity decides tier + whether to cascade.
  if (mode === "auto") {
    const bucket = complexityBucket(complexity)
    if (task === "explain") {
      return {
        task,
        bundleMode,
        tier: bucket === "strong" ? "mid" : "cheap",
        cascade: bucket === "cascade",
        twoStep: false,
      }
    }
    if (task === "patch") {
      return {
        task,
        bundleMode,
        tier: bucket === "strong" ? "coding_flagship" : "mid",
        cascade: true,
        twoStep: bucket === "strong",
      }
    }
    return {
      task,
      bundleMode,
      tier: bucket === "cheap" ? "cheap" : "mid",
      cascade: bucket === "cascade",
      twoStep: false,
    }
  }

  // Pro / Max / Save: fixed tiers from the policy.
  const tier =
    task === "explain"
      ? policy.explainTier
      : task === "patch" || task === "bulk"
        ? policy.patchTier
        : policy.reasonTier
  return {
    task,
    bundleMode,
    tier,
    cascade: false,
    twoStep: mode === "max" && (task === "patch" || task === "root_cause"),
  }
}

/* ------------------------------------------------------------------ *
 *  Guardrail assertions (server-side, mode-independent)              *
 * ------------------------------------------------------------------ */

export interface GuardrailViolation {
  ok: false
  reason: string
}
export type GuardrailCheck = { ok: true } | GuardrailViolation

/**
 * Hard guardrails that hold for EVERY mode including Manual:
 *   - patch generation requires the mode to allow it (Save refuses).
 *   - secrets rule never goes to an LLM (deterministic template only).
 *   - validation is never skippable by the user.
 */
export function enforceGuardrails(args: {
  mode: IntelligenceMode
  task: LlmTask
  ruleId: string
}): GuardrailCheck {
  const policy = MODE_POLICIES[args.mode]
  if ((args.task === "patch" || args.task === "bulk") && !policy.allowPatchGeneration) {
    return {
      ok: false,
      reason: `mode '${args.mode}' does not generate patches; use templates/suggestions or switch mode`,
    }
  }
  if (args.ruleId === "secrets" && args.task !== "explain") {
    return {
      ok: false,
      reason: "secrets findings use the deterministic env-var template; no LLM round-trip",
    }
  }
  return { ok: true }
}

/** Provider-agnostic: map a mode to its default provider preference order
 *  (the route resolves the actual configured provider key). */
export function providerPreferenceFor(mode: IntelligenceMode): ProviderKind[] {
  // Max prefers a coding flagship; others are provider-neutral and use
  // whatever the user configured. Order is a hint only.
  if (mode === "max" || mode === "pro") {
    return ["anthropic", "openai_compatible", "google", "custom"]
  }
  return ["openai_compatible", "anthropic", "google", "custom"]
}
