/**
 * POST /api/billing/checkout
 *
 * Creates a Stripe Checkout session for the authenticated user and
 * returns its hosted URL. The frontend redirects the user there;
 * Stripe handles card entry, and on completion fires the
 * `checkout.session.completed` webhook → plan upgrade.
 *
 * Body:
 *   { tier: "starter" | "pro" | "team" }
 *
 * Hosted-only contract: no provider API keys are touched on this path,
 * ever. The route only requires a session and a server-side Stripe
 * secret.
 */

import { NextResponse } from "next/server"
import { assertHostedRequest, RouteGuardError } from "@/lib/server-route-guards"
import {
  priceForTier,
  stripeRequest,
  StripeError,
} from "@/lib/server-stripe"
import {
  assertStripeBillingConfigured,
  StripeConfigError,
} from "@/lib/server-stripe-config"
import type { PlanTier } from "@/lib/server-billing-store"
import {
  BillingMisconfiguredError,
  ensureBootstrap,
  getAsyncBillingStore,
} from "@/lib/server-billing-bootstrap"
import { isPaidEligible, EMAIL_UNVERIFIED_MESSAGE } from "@/lib/server-email-verification"

export const dynamic = "force-dynamic"

interface CheckoutBody {
  tier?: string
  successUrl?: string
  cancelUrl?: string
}

function asTier(t: unknown): PlanTier | null {
  if (t === "starter" || t === "pro" || t === "team") return t
  return null
}

export async function POST(req: Request) {
  let body: CheckoutBody = {}
  try {
    body = (await req.json()) as CheckoutBody
  } catch {
    body = {}
  }

  let session
  try {
    session = assertHostedRequest(req, body as unknown as Record<string, unknown>)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
  }

  // Paid upgrades require a verified email (enforced in production only).
  if (!isPaidEligible(session)) {
    return NextResponse.json(
      { error: EMAIL_UNVERIFIED_MESSAGE, code: "email_unverified" },
      { status: 403 },
    )
  }

  try {
    assertStripeBillingConfigured()
  } catch (e) {
    if (e instanceof StripeConfigError) {
      return NextResponse.json(
        { error: e.message, code: e.code, missing: e.missing },
        { status: e.status },
      )
    }
    throw e
  }

  const tier = asTier(body.tier)
  if (!tier) {
    return NextResponse.json(
      { error: "tier must be one of: starter, pro, team" },
      { status: 400 },
    )
  }
  const price = priceForTier(tier)
  if (!price) {
    return NextResponse.json(
      { error: `Stripe price for tier "${tier}" is not configured on this server.` },
      { status: 500 },
    )
  }

  try {
    await ensureBootstrap()
  } catch {
    /* surfaced below if loadSubscription throws */
  }
  const store = getAsyncBillingStore()
  let sub
  try {
    sub = await store.loadSubscription(session.userId, session.workspaceId)
  } catch (e) {
    if (e instanceof BillingMisconfiguredError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status },
      )
    }
    throw e
  }

  const successUrl =
    body.successUrl ?? process.env.NEXT_PUBLIC_BILLING_SUCCESS_URL ?? "https://localhost/billing/success"
  const cancelUrl =
    body.cancelUrl ?? process.env.NEXT_PUBLIC_BILLING_CANCEL_URL ?? "https://localhost/billing/cancel"

  try {
    const checkout = await stripeRequest<{ id: string; url: string }>("/checkout/sessions", {
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: `${session.userId}:${session.workspaceId}`,
      customer: sub.stripeCustomerId,
      customer_email: !sub.stripeCustomerId ? session.email : undefined,
      "line_items[0][price]": price,
      "line_items[0][quantity]": 1,
      "metadata[userId]": session.userId,
      "metadata[workspaceId]": session.workspaceId,
      "metadata[planTier]": tier,
    })
    return NextResponse.json({
      url: checkout.url,
      sessionId: checkout.id,
      tier,
    })
  } catch (e) {
    if (e instanceof StripeError) {
      return NextResponse.json(
        { error: e.message, code: e.type },
        { status: e.status },
      )
    }
    return NextResponse.json(
      { error: "Failed to create Stripe Checkout session." },
      { status: 502 },
    )
  }
}
