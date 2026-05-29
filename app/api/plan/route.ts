/**
 * GET /api/plan
 *
 * Returns the SAFE, browser-exposable view of the caller's subscription:
 * tier, which intelligence modes are allowed, whether manual model
 * selection is permitted, and remaining AI credits. No provider keys,
 * ever.
 *
 * Anonymous callers (no session) get a "Free" preview so unauthenticated
 * pages can still surface the plan banner. AI routes still reject
 * anonymous calls via `assertHostedRequest`.
 */

import { NextResponse } from "next/server"
import { getOptionalSession } from "@/lib/server-auth"
import { planSummary } from "@/lib/server-subscription"
import {
  BillingMisconfiguredError,
  ensureBootstrap,
  getAsyncBillingStore,
  getBillingBackendTag,
} from "@/lib/server-billing-bootstrap"
import {
  hostedProviderReadiness,
  stripeReadiness,
} from "@/lib/server-stripe-config"
import { billingMockEnabled } from "@/lib/server-billing-mock"
import { PLAN_ENTITLEMENTS } from "@/lib/server-subscription"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = getOptionalSession(req)
  const stripeOk = stripeReadiness().ok
  const hostedOk = hostedProviderReadiness().ok
  const mockBilling = billingMockEnabled()
  const boot = await ensureBootstrap()
  const backend = getBillingBackendTag()

  const capabilities = {
    stripeReady: stripeOk,
    hostedReady: hostedOk,
    billingBackend: backend,
    billingReady: boot.ok,
    billingMock: mockBilling,
  }

  if (!session) {
    return NextResponse.json({
      plan: {
        tier: "free",
        allowedModes: PLAN_ENTITLEMENTS.free.allowedModes,
        allowManualModelSelection: false,
        creditsTotal: 50,
        creditsUsed: 0,
        creditsRemaining: 50,
        subscriptionStatus: "none",
        billingPeriodEnd: null,
      },
      authenticated: false,
      capabilities,
    })
  }

  try {
    const sub = await getAsyncBillingStore().loadSubscription(
      session.userId,
      session.workspaceId,
    )
    const entitlement = PLAN_ENTITLEMENTS[sub.planTier] ?? PLAN_ENTITLEMENTS.free
    return NextResponse.json({
      plan: {
        ...planSummary({
          userId: sub.userId,
          workspaceId: sub.workspaceId,
          tier: sub.planTier,
          allowedModes: [...entitlement.allowedModes],
          allowManualModelSelection: entitlement.allowManualModelSelection,
          creditsTotal: sub.creditsLimit,
          creditsUsed: sub.creditsUsed,
          subscriptionStatus: sub.subscriptionStatus,
          billingPeriodEnd: sub.billingPeriodEnd,
        }),
      },
      authenticated: true,
      userId: session.userId,
      workspaceId: session.workspaceId,
      email: session.email ?? null,
      authSource: session.authSource,
      capabilities,
    })
  } catch (e) {
    if (e instanceof BillingMisconfiguredError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      )
    }
    throw e
  }
}
