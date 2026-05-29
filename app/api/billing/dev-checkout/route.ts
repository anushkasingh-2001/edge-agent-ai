/**
 * POST /api/billing/dev-checkout  —  DUMMY plan upgrade (no real payment).
 *
 * Instant plan upgrade for testing/staging: the user picks a tier and the
 * subscription row is updated directly in the billing store (Postgres when
 * `DATABASE_URL` is set). No Stripe checkout, webhook, or price IDs.
 *
 * Body:
 *   { tier: "starter" | "pro" | "team" }
 *
 * Enabled when `BILLING_MOCK=1` (including on Vercel production for demo
 * deployments). Real payments use `/api/billing/checkout` when mock is off.
 */

import { NextResponse } from "next/server"
import { assertSession, AuthRequiredError, AuthInvalidError } from "@/lib/server-auth"
import { billingMockEnabled } from "@/lib/server-billing-mock"
import {
  BillingMisconfiguredError,
  ensureBootstrap,
  getAsyncBillingStore,
} from "@/lib/server-billing-bootstrap"
import { PLAN_TIER_LIMITS, type PlanTier } from "@/lib/server-billing-store"

export const dynamic = "force-dynamic"

interface DevCheckoutBody {
  tier?: string
}

function asTier(t: unknown): PlanTier | null {
  if (t === "starter" || t === "pro" || t === "team") return t
  return null
}

export async function POST(req: Request) {
  if (!billingMockEnabled()) {
    return NextResponse.json(
      { error: "Mock billing is disabled. Set BILLING_MOCK=1 or use /api/billing/checkout (Stripe)." },
      { status: 404 },
    )
  }

  let session
  try {
    session = assertSession(req)
  } catch (e) {
    if (e instanceof AuthRequiredError || e instanceof AuthInvalidError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
    }
    throw e
  }

  let body: DevCheckoutBody = {}
  try {
    body = (await req.json()) as DevCheckoutBody
  } catch {
    body = {}
  }

  const tier = asTier(body.tier)
  if (!tier) {
    return NextResponse.json(
      { error: "tier must be one of: starter, pro, team" },
      { status: 400 },
    )
  }

  try {
    await ensureBootstrap()
    const store = getAsyncBillingStore()

    const existing = await store.loadSubscription(session.userId, session.workspaceId)

    // Same tier → idempotent success (useful for UI retries).
    if (existing.subscriptionStatus !== "none" && existing.planTier === tier) {
      return NextResponse.json({
        ok: true,
        mock: true,
        created: false,
        upgraded: false,
        tier: existing.planTier,
        email: existing.email ?? session.email ?? null,
        subscriptionStatus: existing.subscriptionStatus,
        creditsRemaining: Math.max(0, existing.creditsLimit - existing.creditsUsed),
      })
    }

    const sub = await store.upsertSubscription(session.userId, session.workspaceId, {
      email: session.email ?? existing.email,
      planTier: tier,
      creditsLimit: PLAN_TIER_LIMITS[tier].creditsLimit,
      creditsUsed: 0,
      subscriptionStatus: "active",
    })
    return NextResponse.json({
      ok: true,
      mock: true,
      created: existing.subscriptionStatus === "none",
      upgraded: existing.subscriptionStatus !== "none",
      tier: sub.planTier,
      email: sub.email ?? session.email ?? null,
      subscriptionStatus: sub.subscriptionStatus,
      creditsRemaining: Math.max(0, sub.creditsLimit - sub.creditsUsed),
    })
  } catch (e) {
    if (e instanceof BillingMisconfiguredError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
    }
    throw e
  }
}
