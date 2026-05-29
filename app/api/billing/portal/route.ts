/**
 * POST /api/billing/portal
 *
 * Mints a Stripe Customer Portal link for the authenticated user so
 * they can manage payment methods, view invoices, and cancel their
 * subscription. The portal is hosted by Stripe — no provider keys
 * ever touch the client.
 */

import { NextResponse } from "next/server"
import { assertHostedRequest, RouteGuardError } from "@/lib/server-route-guards"
import { stripeRequest, StripeError } from "@/lib/server-stripe"
import {
  assertStripeBillingConfigured,
  StripeConfigError,
} from "@/lib/server-stripe-config"
import {
  BillingMisconfiguredError,
  ensureBootstrap,
  getAsyncBillingStore,
} from "@/lib/server-billing-bootstrap"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  let session
  try {
    session = assertHostedRequest(req, body)
  } catch (e) {
    if (e instanceof RouteGuardError) {
      return NextResponse.json(e.body, { status: e.status })
    }
    throw e
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

  try {
    await ensureBootstrap()
  } catch {
    /* swallow; loadSubscription will throw if mis-configured */
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
  if (!sub.stripeCustomerId) {
    return NextResponse.json(
      { error: "No active subscription for this user. Start a plan via checkout first.", code: "no_customer" },
      { status: 400 },
    )
  }

  const returnUrl =
    (typeof body.returnUrl === "string" && body.returnUrl) ||
    process.env.NEXT_PUBLIC_BILLING_PORTAL_RETURN_URL ||
    "https://localhost/billing"

  try {
    const portal = await stripeRequest<{ url: string }>("/billing_portal/sessions", {
      customer: sub.stripeCustomerId,
      return_url: returnUrl,
    })
    return NextResponse.json({ url: portal.url })
  } catch (e) {
    if (e instanceof StripeError) {
      return NextResponse.json(
        { error: e.message, code: e.type },
        { status: e.status },
      )
    }
    return NextResponse.json(
      { error: "Failed to create Stripe billing portal session." },
      { status: 502 },
    )
  }
}
