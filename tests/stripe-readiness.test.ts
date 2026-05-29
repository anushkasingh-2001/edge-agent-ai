/**
 * Stripe readiness, idempotency, and end-to-end webhook behavior.
 *
 *   13. Missing Stripe env returns safe config error.
 *   14. Checkout creates a Stripe subscription session (stubbed).
 *   15. Portal requires existing stripeCustomerId.
 *   16. Webhook signature required.
 *   17. Duplicate webhook event does not double-apply.
 *   18. invoice.paid resets/updates billing-period credits.
 *   19. subscription.deleted downgrades to free/canceled safely.
 *   20. payment_failed marks past_due.
 *
 * Run: node --import tsx --test tests/stripe-readiness.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHmac } from "node:crypto"
import {
  hostedProviderReadiness,
  stripeReadiness,
  stripeWebhookReadiness,
} from "../lib/server-stripe-config"
import { POST as checkoutPOST } from "../app/api/billing/checkout/route"
import { POST as portalPOST } from "../app/api/billing/portal/route"
import { POST as webhookPOST } from "../app/api/billing/webhook/route"
import {
  FileBillingStore,
  PLAN_TIER_LIMITS,
  setBillingStore,
} from "../lib/server-billing-store"
import { setAsyncBillingStore } from "../lib/server-billing-bootstrap"

const ORIG_FETCH = global.fetch
const ORIG_ENV = { ...process.env }
const env = process.env as Record<string, string | undefined>
const WEBHOOK_SECRET = "whsec_test_readiness_xxxxxxxx"

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-stripe-r-"))
  process.env.EDGE_AGENT_HOME = dir
  const s = new FileBillingStore()
  s._resetForTests()
  setBillingStore(s)
  setAsyncBillingStore({
    loadSubscription: async (u, w) => s.loadSubscription(u, w),
    upsertSubscription: async (u, w, p) => s.upsertSubscription(u, w, p),
    consume: async (a) => s.consume(a),
    canConsume: async (u, w, c) => s.canConsume(u, w, c),
    recentUsage: async (u, w, l) => s.recentUsage(u, w, l),
    claimEvent: async (r) => s.claimEvent(r),
    hasProcessedEvent: async (id) => s.hasProcessedEvent(id),
    _resetForTests: async () => s._resetForTests(),
  })
  return s
}

function reset() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    env[k] = v
  }
  env.EDGE_AGENT_DEV_AUTH = "1"
  delete env.NODE_ENV
  delete env.STRIPE_SECRET_KEY
  delete env.STRIPE_WEBHOOK_SECRET
  delete env.STRIPE_PRICE_STARTER
  delete env.STRIPE_PRICE_PRO
  delete env.STRIPE_PRICE_TEAM
  delete env.NEXT_PUBLIC_APP_URL
  delete env.NEXT_PUBLIC_BILLING_SUCCESS_URL
  delete env.NEXT_PUBLIC_BILLING_CANCEL_URL
}

function configureStripeEnv() {
  env.STRIPE_SECRET_KEY = "sk_test_dummy_redacted"
  env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  env.STRIPE_PRICE_STARTER = "price_starter_T"
  env.STRIPE_PRICE_PRO = "price_pro_T"
  env.STRIPE_PRICE_TEAM = "price_team_T"
  env.NEXT_PUBLIC_APP_URL = "https://app.test"
  env.NEXT_PUBLIC_BILLING_SUCCESS_URL = "https://app.test/success"
  env.NEXT_PUBLIC_BILLING_CANCEL_URL = "https://app.test/cancel"
}

function stubStripeFetchOnce(body: Record<string, unknown>) {
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
}

function signedWebhook(body: object): Request {
  const raw = JSON.stringify(body)
  const ts = Math.floor(Date.now() / 1000)
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex")
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": `t=${ts},v1=${sig}`,
      "content-type": "application/json",
    },
    body: raw,
  })
}

describe("stripe — readiness checks", () => {
  beforeEach(() => {
    reset()
    freshStore()
  })
  afterEach(() => {
    global.fetch = ORIG_FETCH
  })

  it("(13) stripeReadiness reports missing env vars", () => {
    const r = stripeReadiness()
    assert.equal(r.ok, false)
    assert.ok(r.missing.includes("STRIPE_SECRET_KEY"))
    assert.ok(r.missing.includes("STRIPE_WEBHOOK_SECRET"))
  })

  it("(13b) Checkout returns 503 when Stripe env is missing", async () => {
    const res = await checkoutPOST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
      }),
    )
    assert.equal(res.status, 503)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "stripe_not_configured")
  })

  it("(13c) Webhook returns 503 when STRIPE_WEBHOOK_SECRET is missing", async () => {
    const r = stripeWebhookReadiness()
    assert.equal(r.ok, false)
    const res = await webhookPOST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    assert.equal(res.status, 503)
  })

  it("hostedProviderReadiness flags missing API keys", () => {
    delete env.OPENAI_API_KEY
    delete env.ANTHROPIC_API_KEY
    delete env.GEMINI_API_KEY
    const r = hostedProviderReadiness()
    assert.equal(r.ok, false)
    assert.ok(r.missing.length > 0)
  })
})

describe("stripe — checkout / portal", () => {
  beforeEach(() => {
    reset()
    freshStore()
    configureStripeEnv()
  })
  afterEach(() => {
    global.fetch = ORIG_FETCH
  })

  it("(14) Checkout creates a Stripe subscription session", async () => {
    stubStripeFetchOnce({ id: "cs_test_1", url: "https://stripe.test/cs_test_1" })
    const res = await checkoutPOST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
      }),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { url: string; tier: string }
    assert.equal(body.tier, "pro")
    assert.ok(body.url.startsWith("https://stripe.test/"))
  })

  it("(15) Portal returns 400 when the user has no Stripe customer", async () => {
    const res = await portalPOST(
      new Request("http://localhost/api/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    assert.equal(res.status, 400)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "no_customer")
  })

  it("(15b) Portal opens for a paid user", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("local-user", "local-workspace", {
      planTier: "pro",
      stripeCustomerId: "cus_existing",
    })
    stubStripeFetchOnce({ url: "https://stripe.test/portal_cs" })
    const res = await portalPOST(
      new Request("http://localhost/api/billing/portal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { url: string }
    assert.ok(body.url.includes("stripe.test"))
  })
})

describe("stripe — webhook", () => {
  beforeEach(() => {
    reset()
    freshStore()
    configureStripeEnv()
  })

  it("(16) Webhook 400s when signature header is missing", async () => {
    const res = await webhookPOST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", type: "ping" }),
      }),
    )
    assert.equal(res.status, 400)
  })

  it("(17) Duplicate webhook event does not double-apply", async () => {
    const payload = {
      id: "evt_idem_17",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_A",
          subscription: "sub_A",
          metadata: { userId: "u-17", workspaceId: "w", planTier: "pro" },
        },
      },
    }
    const first = await webhookPOST(signedWebhook(payload))
    assert.equal(first.status, 200)
    const second = await webhookPOST(signedWebhook(payload))
    assert.equal(second.status, 200)
    const body = (await second.json()) as { idempotent?: boolean }
    assert.equal(body.idempotent, true)
  })

  it("(18) invoice.paid resets credits", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("u-18", "w", {
      planTier: "pro",
      creditsLimit: PLAN_TIER_LIMITS.pro.creditsLimit,
      creditsUsed: 500,
    })
    const res = await webhookPOST(
      signedWebhook({
        id: "evt_inv_18",
        type: "invoice.paid",
        data: { object: { metadata: { userId: "u-18", workspaceId: "w" } } },
      }),
    )
    assert.equal(res.status, 200)
    const sub = new FileBillingStore().loadSubscription("u-18", "w")
    assert.equal(sub.creditsUsed, 0)
    assert.equal(sub.subscriptionStatus, "active")
  })

  it("(19) subscription.deleted downgrades to free + canceled", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("u-19", "w", { planTier: "team" })
    const res = await webhookPOST(
      signedWebhook({
        id: "evt_del_19",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_X", metadata: { userId: "u-19", workspaceId: "w" } } },
      }),
    )
    assert.equal(res.status, 200)
    const sub = new FileBillingStore().loadSubscription("u-19", "w")
    assert.equal(sub.planTier, "free")
    assert.equal(sub.subscriptionStatus, "canceled")
  })

  it("(20) invoice.payment_failed flips status to past_due", async () => {
    const store = new FileBillingStore()
    store.upsertSubscription("u-20", "w", { planTier: "pro" })
    const res = await webhookPOST(
      signedWebhook({
        id: "evt_fail_20",
        type: "invoice.payment_failed",
        data: { object: { metadata: { userId: "u-20", workspaceId: "w" } } },
      }),
    )
    assert.equal(res.status, 200)
    const sub = new FileBillingStore().loadSubscription("u-20", "w")
    assert.equal(sub.subscriptionStatus, "past_due")
  })
})
