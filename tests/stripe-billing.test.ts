/**
 * Stripe billing: signature verification + webhook → store mapping.
 *
 * We don't hit Stripe over the network; the webhook handler is pure,
 * deterministic input → store mutation. The tests cover:
 *
 *   - HMAC-SHA256 signature acceptance (correct secret) + rejection
 *     (wrong secret, stale timestamp, missing header).
 *   - `checkout.session.completed` → plan upgrade + credits reset.
 *   - `customer.subscription.deleted` → fall back to free.
 *   - `invoice.payment_failed` → status flips to past_due.
 *
 * Run: node --import tsx --test tests/stripe-billing.test.ts
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHmac } from "node:crypto"
import { verifyStripeSignature, mapStripePriceToTier, StripeError } from "../lib/server-stripe"
import { FileBillingStore, setBillingStore, PLAN_TIER_LIMITS } from "../lib/server-billing-store"
import { POST as webhookPOST } from "../app/api/billing/webhook/route"
import { setAsyncBillingStore } from "../lib/server-billing-bootstrap"

const SECRET = "whsec_test_1234567890"

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-stripe-"))
  process.env.EDGE_AGENT_HOME = dir
  // The webhook route now also gates on `stripeWebhookReadiness()`,
  // which requires the full price→tier env block in addition to the
  // signing secret. Configure all of them so the existing webhook
  // routing tests continue to exercise the handler logic instead of
  // bouncing off the readiness check.
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_for_local_only"
  process.env.STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER || "price_starter_T"
  process.env.STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO || "price_pro_T"
  process.env.STRIPE_PRICE_TEAM = process.env.STRIPE_PRICE_TEAM || "price_team_T"
  const store = new FileBillingStore()
  setBillingStore(store)
  store._resetForTests()
  // Keep the async store mirror pointed at the same on-disk state so
  // the async webhook handler observes the writes made here.
  setAsyncBillingStore({
    loadSubscription: async (u, w) => store.loadSubscription(u, w),
    upsertSubscription: async (u, w, p) => store.upsertSubscription(u, w, p),
    consume: async (a) => store.consume(a),
    canConsume: async (u, w, c) => store.canConsume(u, w, c),
    recentUsage: async (u, w, l) => store.recentUsage(u, w, l),
    claimEvent: async (r) => store.claimEvent(r),
    hasProcessedEvent: async (id) => store.hasProcessedEvent(id),
    _resetForTests: async () => store._resetForTests(),
  })
  return store
}

function signedRequest(body: object, opts: { secret?: string; tsOffsetSec?: number } = {}): Request {
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0)
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex")
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": `t=${ts},v1=${sig}`,
      "content-type": "application/json",
    },
    body: raw,
  })
}

describe("stripe signature verification", () => {
  it("accepts a correctly-signed payload", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "ping" })
    const ts = Math.floor(Date.now() / 1000)
    const sig = createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex")
    const event = verifyStripeSignature(payload, `t=${ts},v1=${sig}`, SECRET)
    assert.equal((event as { type: string }).type, "ping")
  })

  it("rejects a wrong-secret signature", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "ping" })
    const ts = Math.floor(Date.now() / 1000)
    const sig = createHmac("sha256", "WRONG").update(`${ts}.${payload}`).digest("hex")
    assert.throws(
      () => verifyStripeSignature(payload, `t=${ts},v1=${sig}`, SECRET),
      (e) => e instanceof StripeError && e.type === "invalid_signature",
    )
  })

  it("rejects stale timestamps (replay protection)", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "ping" })
    const ts = Math.floor(Date.now() / 1000) - 4000
    const sig = createHmac("sha256", SECRET).update(`${ts}.${payload}`).digest("hex")
    assert.throws(
      () => verifyStripeSignature(payload, `t=${ts},v1=${sig}`, SECRET),
      (e) => e instanceof StripeError && e.type === "stale_timestamp",
    )
  })
})

describe("stripe → billing store mapping", () => {
  beforeEach(() => {
    freshStore()
    process.env.STRIPE_PRICE_PRO = "price_pro_123"
    process.env.STRIPE_PRICE_TEAM = "price_team_456"
  })

  it("checkout.session.completed flips the user to the selected tier", async () => {
    const req = signedRequest({
      id: "evt_co_1",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_X",
          subscription: "sub_X",
          metadata: { userId: "u1", workspaceId: "w1", planTier: "pro" },
        },
      },
    })
    const res = await webhookPOST(req)
    assert.equal(res.status, 200)
    const store = new FileBillingStore()
    const sub = store.loadSubscription("u1", "w1")
    assert.equal(sub.planTier, "pro")
    assert.equal(sub.creditsLimit, PLAN_TIER_LIMITS.pro.creditsLimit)
    assert.equal(sub.subscriptionStatus, "active")
    assert.equal(sub.stripeCustomerId, "cus_X")
  })

  it("customer.subscription.deleted falls back to free", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("u2", "w2", { planTier: "pro" })
    const req = signedRequest({
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_X",
          metadata: { userId: "u2", workspaceId: "w2" },
        },
      },
    })
    const res = await webhookPOST(req)
    assert.equal(res.status, 200)
    const sub = new FileBillingStore().loadSubscription("u2", "w2")
    assert.equal(sub.planTier, "free")
    assert.equal(sub.subscriptionStatus, "canceled")
  })

  it("invoice.payment_failed flips status to past_due", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("u3", "w3", { planTier: "pro" })
    const req = signedRequest({
      id: "evt_fail",
      type: "invoice.payment_failed",
      data: { object: { metadata: { userId: "u3", workspaceId: "w3" } } },
    })
    const res = await webhookPOST(req)
    assert.equal(res.status, 200)
    const sub = new FileBillingStore().loadSubscription("u3", "w3")
    assert.equal(sub.subscriptionStatus, "past_due")
  })

  it("rejects unsigned / missing-signature webhooks", async () => {
    const req = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", type: "ping" }),
    })
    const res = await webhookPOST(req)
    assert.equal(res.status, 400)
  })

  it("mapStripePriceToTier returns 'free' for unknown prices", () => {
    assert.equal(mapStripePriceToTier("price_unknown"), "free")
    assert.equal(mapStripePriceToTier(null), "free")
  })
})
