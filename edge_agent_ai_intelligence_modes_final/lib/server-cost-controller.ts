/**
 * Cost Controller.
 *
 * Two jobs:
 *   1. Estimate the cost of an operation BEFORE it runs (per-finding or
 *      per-bulk), so the UI can show "Fix all 47 → ~6 calls, ~$0.18"
 *      and the user can confirm.
 *   2. Enforce a per-scan spend cap so a runaway loop can't bill the
 *      user. The cap is configurable via env; default is conservative.
 *
 * Pricing lives here as a small table keyed by model id. It is
 * intentionally approximate (USD per 1k tokens) and easy to update; the
 * estimate is a guide, not a billing source of truth. Unknown models
 * fall back to a mid-tier price so we never under-warn.
 */

import type { ModelTier, ProviderKind } from "./server-model-router"

export interface ModelPrice {
  inputPer1k: number
  outputPer1k: number
}

/**
 * Approximate USD/1k tokens. Keep in sync with model-catalog.ts ids.
 * These are deliberately rounded; update as providers change pricing.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-4.1": { inputPer1k: 0.002, outputPer1k: 0.008 },
  "gpt-4.1-mini": { inputPer1k: 0.0004, outputPer1k: 0.0016 },
  "gpt-4.1-nano": { inputPer1k: 0.0001, outputPer1k: 0.0004 },
  "o4-mini": { inputPer1k: 0.0011, outputPer1k: 0.0044 },
  "o3-mini": { inputPer1k: 0.0011, outputPer1k: 0.0044 },
  // Anthropic
  "claude-opus-4-1-20250805": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "claude-sonnet-4-5-20250929": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-3-7-sonnet-latest": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-3-5-sonnet-latest": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-3-5-haiku-latest": { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // Google
  "gemini-2.5-pro": { inputPer1k: 0.00125, outputPer1k: 0.01 },
  "gemini-2.5-flash": { inputPer1k: 0.0003, outputPer1k: 0.0025 },
  "gemini-2.0-flash": { inputPer1k: 0.0001, outputPer1k: 0.0004 },
}

const FALLBACK_PRICE: ModelPrice = { inputPer1k: 0.002, outputPer1k: 0.008 }
const LOCAL_PRICE: ModelPrice = { inputPer1k: 0, outputPer1k: 0 }

export function priceFor(modelId: string, provider?: ProviderKind): ModelPrice {
  if (provider === "custom") return LOCAL_PRICE // local/BYOK — treat as free
  return MODEL_PRICING[modelId] ?? FALLBACK_PRICE
}

export interface CallEstimate {
  model: string
  tier: ModelTier
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function estimateCall(args: {
  model: string
  tier: ModelTier
  inputTokens: number
  outputTokens: number
  provider?: ProviderKind
}): CallEstimate {
  const price = priceFor(args.model, args.provider)
  const costUsd =
    (args.inputTokens / 1000) * price.inputPer1k +
    (args.outputTokens / 1000) * price.outputPer1k
  return {
    model: args.model,
    tier: args.tier,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd: Number(costUsd.toFixed(5)),
  }
}

export interface BatchEstimate {
  totalCalls: number
  callsByTier: Record<string, number>
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsdLow: number
  estimatedCostUsdHigh: number
}

export function summarizeBatch(calls: CallEstimate[]): BatchEstimate {
  const byTier: Record<string, number> = {}
  let inTok = 0
  let outTok = 0
  let cost = 0
  for (const c of calls) {
    byTier[c.tier] = (byTier[c.tier] ?? 0) + 1
    inTok += c.inputTokens
    outTok += c.outputTokens
    cost += c.costUsd
  }
  return {
    totalCalls: calls.length,
    callsByTier: byTier,
    estimatedInputTokens: inTok,
    estimatedOutputTokens: outTok,
    estimatedCostUsdLow: Number((cost * 0.8).toFixed(4)),
    estimatedCostUsdHigh: Number((cost * 1.3).toFixed(4)),
  }
}

/* ------------------------------------------------------------------ *
 *  Spend cap                                                          *
 * ------------------------------------------------------------------ */

export function perScanBudgetUsd(): number {
  const v = Number(process.env.EDGE_AGENT_MAX_SCAN_USD ?? "")
  return Number.isFinite(v) && v > 0 ? v : 2.0 // conservative default
}

export interface BudgetCheck {
  ok: boolean
  budgetUsd: number
  estimatedUsd: number
  reason?: string
}

export function checkBudget(estimatedUsd: number): BudgetCheck {
  const budget = perScanBudgetUsd()
  if (estimatedUsd > budget) {
    return {
      ok: false,
      budgetUsd: budget,
      estimatedUsd,
      reason: `estimated $${estimatedUsd.toFixed(
        2,
      )} exceeds per-scan cap $${budget.toFixed(2)} (set EDGE_AGENT_MAX_SCAN_USD to raise)`,
    }
  }
  return { ok: true, budgetUsd: budget, estimatedUsd }
}
