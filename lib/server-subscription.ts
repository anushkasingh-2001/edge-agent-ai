/**
 * Subscription plans + quota (server-side only).
 *
 * Backed by `lib/server-billing-store` for persistence. This module
 * remains the authority for plan entitlements (allowed modes, manual
 * model access) — pure data over `BillingStore` records.
 *
 * Wire contract: NOTHING here is sent to the browser except the
 * derived, safe `PlanSummary` (limits + remaining credits + allowed
 * modes). No provider keys, no Stripe ids.
 */

import type { IntelligenceMode } from "./context-bundle"
import {
  getBillingStore,
  PLAN_TIER_LIMITS,
  type CreditUsageRecord,
  type PlanTier,
  type SubscriptionRecord,
} from "./server-billing-store"

export type { PlanTier }

export interface Subscription {
  userId: string
  workspaceId: string
  tier: PlanTier
  allowedModes: IntelligenceMode[]
  allowManualModelSelection: boolean
  creditsTotal: number
  creditsUsed: number
  subscriptionStatus: SubscriptionRecord["subscriptionStatus"]
  billingPeriodEnd: string
}

export interface PlanSummary {
  tier: PlanTier
  allowedModes: IntelligenceMode[]
  allowManualModelSelection: boolean
  creditsTotal: number
  creditsUsed: number
  creditsRemaining: number
  subscriptionStatus: SubscriptionRecord["subscriptionStatus"]
  billingPeriodEnd: string
}

/** Every analysis mode (wire IDs). The user sees
 *  Lite/Balanced/Deep/Exhaustive/Custom; the IDs below stay stable. */
const ALL_MODES: IntelligenceMode[] = ["save", "auto", "pro", "max", "manual"]

/** Per-tier entitlements. Stripe webhook → planTier → these flags.
 *
 *  Mode ACCESS is tier-gated (login + subscription decide which AI modes a
 *  user can run):
 *    - free / starter : Lite + Balanced
 *    - pro            : Lite + Balanced + Deep
 *    - team / max     : all modes + Custom (manual model selection)
 *    - enterprise     : all modes + Custom
 *
 *  `team` is the wire name for the highest "Max" tier; `team` and
 *  `enterprise` both grant Max-tier access. Manual model selection is
 *  reserved for Max-tier (team/enterprise). */
export const PLAN_ENTITLEMENTS: Record<
  PlanTier,
  { allowedModes: IntelligenceMode[]; allowManualModelSelection: boolean }
> = {
  free: { allowedModes: ["save", "auto"], allowManualModelSelection: false },
  starter: { allowedModes: ["save", "auto"], allowManualModelSelection: false },
  pro: { allowedModes: ["save", "auto", "pro"], allowManualModelSelection: false },
  team: { allowedModes: [...ALL_MODES], allowManualModelSelection: true },
  enterprise: { allowedModes: [...ALL_MODES], allowManualModelSelection: true },
}

function entitlementsFor(record: SubscriptionRecord): {
  allowedModes: IntelligenceMode[]
  allowManualModelSelection: boolean
} {
  return PLAN_ENTITLEMENTS[record.planTier] ?? PLAN_ENTITLEMENTS.free
}

function toSubscription(record: SubscriptionRecord): Subscription {
  const ent = entitlementsFor(record)
  return {
    userId: record.userId,
    workspaceId: record.workspaceId,
    tier: record.planTier,
    allowedModes: [...ent.allowedModes],
    allowManualModelSelection: ent.allowManualModelSelection,
    creditsTotal: record.creditsLimit,
    creditsUsed: record.creditsUsed,
    subscriptionStatus: record.subscriptionStatus,
    billingPeriodEnd: record.billingPeriodEnd,
  }
}

export function loadSubscription(userId: string, workspaceId: string): Subscription {
  const record = getBillingStore().loadSubscription(userId, workspaceId)
  return toSubscription(record)
}

export function planSummary(sub: Subscription): PlanSummary {
  return {
    tier: sub.tier,
    allowedModes: sub.allowedModes,
    allowManualModelSelection: sub.allowManualModelSelection,
    creditsTotal: sub.creditsTotal,
    creditsUsed: sub.creditsUsed,
    creditsRemaining: Math.max(0, sub.creditsTotal - sub.creditsUsed),
    subscriptionStatus: sub.subscriptionStatus,
    billingPeriodEnd: sub.billingPeriodEnd,
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

/**
 * Atomic check-and-consume. Routes call this AFTER a successful
 * upstream model call. Writes both the subscription delta and an
 * append-only usage row.
 */
export function consumeCreditsAtomic(args: {
  userId: string
  workspaceId: string
  credits: number
  usage: Omit<
    CreditUsageRecord,
    "id" | "createdAt" | "actualCredits" | "userId" | "workspaceId"
  >
}): { creditsUsed: number; record: CreditUsageRecord } {
  return getBillingStore().consume({
    userId: args.userId,
    workspaceId: args.workspaceId,
    credits: args.credits,
    usage: {
      ...args.usage,
      userId: args.userId,
      workspaceId: args.workspaceId,
      actualCredits: args.credits,
    },
  })
}

/** Legacy thin wrapper: debit credits without an explicit usage row.
 *  Kept for back-compat with the original resolver signature. */
export function consumeCredits(userId: string, workspaceId: string, credits: number): void {
  if (!userId || !workspaceId || credits <= 0) return
  getBillingStore().consume({
    userId,
    workspaceId,
    credits,
    usage: {
      userId,
      workspaceId,
      task: "legacy",
      intelligenceMode: "legacy",
      model: "legacy",
      provider: "legacy",
      estimatedCredits: credits,
      actualCredits: credits,
      requestId: "legacy",
    },
  })
}

/** @internal test helper — reset the persistent store. */
export function _resetLedgerForTests(): void {
  getBillingStore()._resetForTests()
}

export { PLAN_TIER_LIMITS }
