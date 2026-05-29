/**
 * POST /api/billing/webhook  —  Stripe → billing-store synchronizer.
 *
 * Verifies the `Stripe-Signature` header via HMAC-SHA256 against
 * `STRIPE_WEBHOOK_SECRET`. Anonymous, unsigned, or stale requests are
 * rejected. Verified events update the persistent subscription record
 * keyed by the `metadata.userId` / `metadata.workspaceId` we sent when
 * we created the Checkout session.
 *
 * **Idempotency**: every event id is recorded in `billing_events`
 * (file or DB) via `claimEvent()`. A duplicate delivery (Stripe retries
 * unacked webhooks for up to 3 days) returns 200 immediately without
 * re-applying the side effects.
 *
 * Handled events:
 *   - checkout.session.completed
 *   - customer.subscription.{created,updated,deleted}
 *   - invoice.paid
 *   - invoice.payment_failed
 *
 * Anything else returns 200 (ignored) so Stripe doesn't retry forever.
 *
 * Hosted-only contract: provider API keys (OpenAI/Anthropic/Gemini) are
 * never touched on this path. Only plan state moves.
 */

import { NextResponse } from "next/server"
import { verifyStripeSignature, mapStripePriceToTier, StripeError } from "@/lib/server-stripe"
import {
  assertStripeWebhookConfigured,
  StripeConfigError,
} from "@/lib/server-stripe-config"
import {
  PLAN_TIER_LIMITS,
  type PlanTier,
} from "@/lib/server-billing-store"
import {
  BillingMisconfiguredError,
  ensureBootstrap,
  getAsyncBillingStore,
} from "@/lib/server-billing-bootstrap"

export const dynamic = "force-dynamic"

interface StripeMetadata {
  userId?: string
  workspaceId?: string
  planTier?: string
}

interface MinimalEvent {
  id?: string
  type?: string
  data?: { object?: Record<string, unknown> }
}

function readMetadata(obj: Record<string, unknown>): StripeMetadata {
  const meta = obj.metadata as StripeMetadata | undefined
  return meta ?? {}
}

function priceIdFromSubscription(obj: Record<string, unknown>): string | null {
  const items = obj.items as { data?: Array<{ price?: { id?: string } }> } | undefined
  return items?.data?.[0]?.price?.id ?? null
}

function periodWindowFromUnix(
  start?: number | null,
  end?: number | null,
): { start: string; end: string } {
  const now = new Date()
  const s = start ? new Date(start * 1000) : new Date(now.getFullYear(), now.getMonth(), 1)
  const e = end ? new Date(end * 1000) : new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return { start: s.toISOString(), end: e.toISOString() }
}

function asPlanTier(t: unknown): PlanTier | null {
  if (
    t === "free" ||
    t === "starter" ||
    t === "pro" ||
    t === "team" ||
    t === "enterprise"
  )
    return t
  return null
}

export async function POST(req: Request) {
  try {
    assertStripeWebhookConfigured()
  } catch (e) {
    if (e instanceof StripeConfigError) {
      return NextResponse.json(
        { error: e.message, code: e.code, missing: e.missing },
        { status: e.status },
      )
    }
    throw e
  }

  const rawBody = await req.text()
  const sig = req.headers.get("stripe-signature")
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? ""

  let event: MinimalEvent
  try {
    event = verifyStripeSignature(rawBody, sig, secret) as MinimalEvent
  } catch (e) {
    if (e instanceof StripeError) {
      return NextResponse.json(
        { error: e.message, code: e.type },
        { status: e.status },
      )
    }
    return NextResponse.json({ error: "webhook verification failed" }, { status: 400 })
  }

  const type = event.type ?? ""
  const stripeEventId = event.id ?? ""
  const obj = event.data?.object ?? {}
  try {
    await ensureBootstrap()
  } catch {
    /* will surface below if claimEvent throws */
  }
  const store = getAsyncBillingStore()
  const meta = readMetadata(obj)

  // ---- Idempotency claim ----
  // For events whose side effect targets a specific user (most of
  // them), we claim against `(stripeEventId, userId, workspaceId)`.
  // For events without metadata we still claim against the bare id,
  // so retries are deduplicated.
  if (stripeEventId) {
    try {
      const claimed = await store.claimEvent({
        stripeEventId,
        type,
        userId: meta.userId,
        workspaceId: meta.workspaceId,
        rawStatus: "applied",
      })
      if (!claimed) {
        return NextResponse.json({
          received: true,
          type,
          idempotent: true,
          note: "event already processed",
        })
      }
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

  try {
    switch (type) {
      case "checkout.session.completed": {
        const userId = meta.userId
        const workspaceId = meta.workspaceId
        const planTier = asPlanTier(meta.planTier) ?? "starter"
        const customer = (obj.customer as string | undefined) ?? undefined
        const subscriptionId = (obj.subscription as string | undefined) ?? undefined
        if (userId && workspaceId) {
          await store.upsertSubscription(userId, workspaceId, {
            planTier,
            creditsLimit: PLAN_TIER_LIMITS[planTier].creditsLimit,
            creditsUsed: 0,
            subscriptionStatus: "active",
            stripeCustomerId: customer,
            stripeSubscriptionId: subscriptionId,
          })
        }
        break
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const userId = meta.userId
        const workspaceId = meta.workspaceId
        const priceId = priceIdFromSubscription(obj)
        const planTier = mapStripePriceToTier(priceId)
        const status = (obj.status as string | undefined) ?? "active"
        const win = periodWindowFromUnix(
          obj.current_period_start as number | undefined,
          obj.current_period_end as number | undefined,
        )
        if (userId && workspaceId) {
          await store.upsertSubscription(userId, workspaceId, {
            planTier,
            creditsLimit: PLAN_TIER_LIMITS[planTier].creditsLimit,
            stripeCustomerId: (obj.customer as string | undefined) ?? undefined,
            stripeSubscriptionId: (obj.id as string | undefined) ?? undefined,
            subscriptionStatus: status as never,
            billingPeriodStart: win.start,
            billingPeriodEnd: win.end,
          })
        }
        break
      }
      case "customer.subscription.deleted": {
        const userId = meta.userId
        const workspaceId = meta.workspaceId
        if (userId && workspaceId) {
          await store.upsertSubscription(userId, workspaceId, {
            planTier: "free",
            creditsLimit: PLAN_TIER_LIMITS.free.creditsLimit,
            subscriptionStatus: "canceled",
            stripeSubscriptionId: undefined,
          })
        }
        break
      }
      case "invoice.paid": {
        const userId = meta.userId
        const workspaceId = meta.workspaceId
        // Resetting credits on every paid invoice is what makes
        // monthly quotas roll over. Idempotency above guarantees the
        // same invoice never resets twice — repeated `invoice.paid`
        // delivery for the SAME stripe event id is dropped before
        // reaching this branch.
        if (userId && workspaceId) {
          const existing = await store.loadSubscription(userId, workspaceId)
          const win = periodWindowFromUnix(
            obj.period_start as number | undefined,
            obj.period_end as number | undefined,
          )
          await store.upsertSubscription(userId, workspaceId, {
            creditsUsed: 0,
            creditsLimit: PLAN_TIER_LIMITS[existing.planTier].creditsLimit,
            subscriptionStatus: "active",
            billingPeriodStart: win.start,
            billingPeriodEnd: win.end,
          })
        }
        break
      }
      case "invoice.payment_failed": {
        const userId = meta.userId
        const workspaceId = meta.workspaceId
        if (userId && workspaceId) {
          await store.upsertSubscription(userId, workspaceId, {
            subscriptionStatus: "past_due",
          })
        }
        break
      }
      default:
        break
    }
  } catch {
    return NextResponse.json({ received: true, handled: false }, { status: 200 })
  }

  return NextResponse.json({ received: true, type })
}
