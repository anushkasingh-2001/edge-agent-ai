/**
 * Subscription plans + quota (server-side only).
 *
 * This is the authority for "what is this user allowed to do" — which
 * intelligence modes their plan includes, whether they may use Manual
 * model selection, and how many AI credits remain. It is intentionally
 * a small, pluggable layer: today it reads from env / an in-memory map
 * so the feature works end-to-end; a real deployment swaps
 * `loadSubscription` for a DB/billing lookup without touching callers.
 *
 * NOTHING here is sent to the browser except the derived, safe
 * `PlanSummary` (limits + remaining credits) — never provider keys.
 */

import type { IntelligenceMode } from "./context-bundle"

export type PlanTier = "free" | "pro" | "enterprise"

export interface Subscription {
  userId: string
  workspaceId: string
  tier: PlanTier
  /** Intelligence modes this plan may run. */
  allowedModes: IntelligenceMode[]
  /** May the user pick models per task (Manual mode)? */
  allowManualModelSelection: boolean
  /** AI credit budget for the current period and how much is used. */
  creditsTotal: number
  creditsUsed: number
}

/** Safe, browser-exposable view (no keys, no internal ids beyond plan). */
export interface PlanSummary {
  tier: PlanTier
  allowedModes: IntelligenceMode[]
  allowManualModelSelection: boolean
  creditsTotal: number
  creditsUsed: number
  creditsRemaining: number
}

const ALL_MODES: IntelligenceMode[] = ["save", "auto", "pro", "max", "manual"]

/** Per-tier defaults. A real billing system overrides these. */
const TIER_DEFAULTS: Record<PlanTier, Omit<Subscription, "userId" | "workspaceId" | "creditsUsed">> = {
  free: {
    tier: "free",
    allowedModes: ["save", "auto"],
    allowManualModelSelection: false,
    creditsTotal: 50,
  },
  pro: {
    tier: "pro",
    allowedModes: ["save", "auto", "pro", "max", "manual"],
    // Pro may enter Manual mode but uses curated defaults; per-task model
    // selection is an enterprise capability. This makes the two gates
    // (mode_not_in_plan vs manual_not_in_plan) independently meaningful.
    allowManualModelSelection: false,
    creditsTotal: 2_000,
  },
  enterprise: {
    tier: "enterprise",
    allowedModes: ALL_MODES,
    allowManualModelSelection: true,
    creditsTotal: 100_000,
  },
}

/**
 * In-memory credit ledger keyed by `${userId}:${workspaceId}`. Survives
 * for the process lifetime — a real deployment persists this in the
 * billing DB. Exposed via helpers so routes never touch the map.
 */
const CREDIT_LEDGER = new Map<string, number>()

function ledgerKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`
}

/** Resolve the tier for a user. Env-overridable for local/dev:
 *  EDGE_AGENT_PLAN_TIER = free | pro | enterprise (default: pro). */
function tierFor(_userId: string): PlanTier {
  const env = (process.env.EDGE_AGENT_PLAN_TIER ?? "").trim().toLowerCase()
  if (env === "free" || env === "pro" || env === "enterprise") return env
  return "pro"
}

/**
 * Load the subscription for a user+workspace. Swap this single function
 * for a DB/billing lookup in production; the rest of the system is
 * unchanged.
 */
export function loadSubscription(userId: string, workspaceId: string): Subscription {
  const tier = tierFor(userId)
  const base = TIER_DEFAULTS[tier]
  const used = CREDIT_LEDGER.get(ledgerKey(userId, workspaceId)) ?? 0
  return {
    userId,
    workspaceId,
    tier: base.tier,
    allowedModes: [...base.allowedModes],
    allowManualModelSelection: base.allowManualModelSelection,
    creditsTotal: base.creditsTotal,
    creditsUsed: used,
  }
}

export function planSummary(sub: Subscription): PlanSummary {
  return {
    tier: sub.tier,
    allowedModes: sub.allowedModes,
    allowManualModelSelection: sub.allowManualModelSelection,
    creditsTotal: sub.creditsTotal,
    creditsUsed: sub.creditsUsed,
    creditsRemaining: Math.max(0, sub.creditsTotal - sub.creditsUsed),
  }
}

export function modeAllowed(sub: Subscription, mode: IntelligenceMode): boolean {
  return sub.allowedModes.includes(mode)
}

export interface QuotaCheck {
  ok: boolean
  remaining: number
  reason?: string
}

/** Check whether an estimated credit cost fits the remaining budget. */
export function checkQuota(sub: Subscription, estimatedCredits: number): QuotaCheck {
  const remaining = Math.max(0, sub.creditsTotal - sub.creditsUsed)
  if (estimatedCredits > remaining) {
    return {
      ok: false,
      remaining,
      reason: `quota exceeded: needs ~${estimatedCredits} credits, ${remaining} remaining`,
    }
  }
  return { ok: true, remaining }
}

/** Record credit consumption after a successful model call. */
export function consumeCredits(userId: string, workspaceId: string, credits: number): void {
  const k = ledgerKey(userId, workspaceId)
  CREDIT_LEDGER.set(k, (CREDIT_LEDGER.get(k) ?? 0) + Math.max(0, credits))
}

/** @internal test helper — reset the in-memory ledger. */
export function _resetLedgerForTests(): void {
  CREDIT_LEDGER.clear()
}
