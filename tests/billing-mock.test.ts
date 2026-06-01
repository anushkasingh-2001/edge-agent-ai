/**
 * Dummy billing (BILLING_MOCK=1) — no Stripe required.
 *
 * Run: EDGE_AGENT_HOME=$(mktemp -d) node --import tsx --test tests/billing-mock.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { POST as devCheckoutPOST } from "../app/api/billing/dev-checkout/route"
import { POST as registerPOST } from "../app/api/auth/register/route"
import { POST as devLoginPOST } from "../app/api/auth/dev-login/route"

import { billingMockEnabled, DEMO_BILLING_LABEL } from "../lib/server-billing-mock"
import { checkCloudEnv, runProdCheck } from "../lib/server-prod-check"
import {
  ensureUserBootstrap,
  getAsyncUserStore,
  _resetUserBootstrapForTests,
} from "../lib/server-user-bootstrap"
import {
  FileBillingStore,
  getBillingStore,
  PLAN_TIER_LIMITS,
  setBillingStore,
} from "../lib/server-billing-store"
import { _resetBillingBootstrapForTests } from "../lib/server-billing-bootstrap"
import { getAuditWriter } from "../lib/server-audit-log"

const SECRET = "billing-mock-test-jwt-secret-0123456789"
const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>
const ORIG_BILLING = getBillingStore()

function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
}

function resetEnv(home: string): void {
  restore()
  env.EDGE_AGENT_HOME = home
  env.JWT_SECRET = SECRET
  env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
  delete env.DATABASE_URL
}

function setMinimalCloudEnv(): void {
  env.DATABASE_URL = "postgres://user:pass@localhost:5432/db?sslmode=require"
  env.OPENAI_API_KEY = "sk-test-openai"
  env.ANTHROPIC_API_KEY = "sk-ant-test"
  env.JWT_SECRET = "test-jwt-secret-min-16-chars"
  env.RESEND_API_KEY = "re_test_key"
  env.EMAIL_FROM = "Edge Agent AI <noreply@test.com>"
  env.AUTH_CLEANUP_SECRET = "cleanup-secret-xyz"
  env.NEXT_PUBLIC_APP_URL = "https://app.test"
  env.EDGE_AGENT_CLOUD_ALLOWED_ORIGINS = "https://app.test"
}

function jsonReq(url: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe("billing mock mode", () => {
  let home: string
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-bill-mock-"))
    resetEnv(home)
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(new FileBillingStore())
    getAuditWriter()._resetForTests()
  })
  afterEach(async () => {
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(ORIG_BILLING)
    fs.rmSync(home, { recursive: true, force: true })
    restore()
  })

  it("billingMockEnabled is true when BILLING_MOCK=1", () => {
    env.BILLING_MOCK = "1"
    assert.equal(billingMockEnabled(), true)
    delete env.BILLING_MOCK
    assert.equal(billingMockEnabled(), false)
  })

  it("prod:check does not require Stripe env when BILLING_MOCK=1", () => {
    setMinimalCloudEnv()
    env.BILLING_MOCK = "1"
    delete env.STRIPE_SECRET_KEY
    delete env.STRIPE_WEBHOOK_SECRET
    delete env.STRIPE_PRICE_STARTER
    delete env.STRIPE_PRICE_PRO
    delete env.STRIPE_PRICE_TEAM
    delete env.NEXT_PUBLIC_BILLING_SUCCESS_URL
    delete env.NEXT_PUBLIC_BILLING_CANCEL_URL

    const checks = checkCloudEnv()
    assert.ok(checks.some((c) => c.id === "BILLING_MOCK" && c.status === "ok"))
    assert.ok(checks.some((c) => c.id === "STRIPE_SECRET_KEY" && c.status === "skip"))
    const fails = checks.filter((c) => c.status === "fail")
    assert.deepEqual(fails, [], `unexpected fails: ${JSON.stringify(fails)}`)
  })

  it("prod:check requires Stripe env when BILLING_MOCK is off", () => {
    setMinimalCloudEnv()
    delete env.BILLING_MOCK
    delete env.STRIPE_SECRET_KEY
    env.PROD_CHECK = "1"

    const checks = checkCloudEnv()
    assert.ok(
      checks.some((c) => c.id === "STRIPE_SECRET_KEY" && c.status === "fail"),
      "Stripe required when mock off",
    )
  })

  it("dev-checkout upgrades plan without Stripe in production when BILLING_MOCK=1", async () => {
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(new FileBillingStore())
    env.BILLING_MOCK = "1"
    env.NODE_ENV = "production"
    env.USER_STORE = "file"
    env.BILLING_STORE = "file"
    // This test exercises dev-checkout in production mock mode, not the email
    // verification gate — opt out so register returns a session directly.
    env.EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION = "0"
    delete env.DATABASE_URL

    const reg = await registerPOST(
      jsonReq("https://cloud.test/api/auth/register", {
        email: "upgrade@edge.test",
        password: "password12345",
      }),
    )
    const data = (await reg.json()) as { token: string; user: { id: string; workspaceId: string } }
    assert.equal(reg.status, 201)

    const checkout = await devCheckoutPOST(
      jsonReq("https://cloud.test/api/billing/dev-checkout", { tier: "pro" }, data.token),
    )
    assert.equal(checkout.status, 200)
    const body = (await checkout.json()) as {
      ok: boolean
      mock: boolean
      tier: string
      creditsRemaining: number
    }
    assert.equal(body.ok, true)
    assert.equal(body.mock, true)
    assert.equal(body.tier, "pro")
    assert.equal(body.creditsRemaining, PLAN_TIER_LIMITS.pro.creditsLimit)

    const sub = await getBillingStore().loadSubscription(data.user.id, data.user.workspaceId)
    assert.equal(sub.planTier, "pro")
    assert.equal(sub.subscriptionStatus, "active")
    assert.equal(sub.creditsLimit, PLAN_TIER_LIMITS.pro.creditsLimit)
  })

  it("dev-checkout allows tier upgrade (starter → team) and resets credits", async () => {
    env.BILLING_MOCK = "1"
    const reg = await registerPOST(
      jsonReq("https://cloud.test/api/auth/register", {
        email: "tierup@edge.test",
        password: "password12345",
      }),
    )
    const data = (await reg.json()) as { token: string; user: { id: string; workspaceId: string } }

    await devCheckoutPOST(jsonReq("https://cloud.test/api/billing/dev-checkout", { tier: "starter" }, data.token))
    getBillingStore().consume({
      userId: data.user.id,
      workspaceId: data.user.workspaceId,
      credits: 10,
      usage: {
        userId: data.user.id,
        workspaceId: data.user.workspaceId,
        task: "chat",
        intelligenceMode: "auto",
        provider: "openai",
        model: "gpt-4.1-mini",
        estimatedCredits: 10,
        actualCredits: 10,
        requestId: "req-1",
      },
    })

    const team = await devCheckoutPOST(
      jsonReq("https://cloud.test/api/billing/dev-checkout", { tier: "team" }, data.token),
    )
    assert.equal(team.status, 200)
    const body = (await team.json()) as { tier: string; creditsRemaining: number; upgraded: boolean }
    assert.equal(body.tier, "team")
    assert.equal(body.upgraded, true)
    assert.equal(body.creditsRemaining, PLAN_TIER_LIMITS.team.creditsLimit)

    const sub = await getBillingStore().loadSubscription(data.user.id, data.user.workspaceId)
    assert.equal(sub.planTier, "team")
    assert.equal(sub.creditsUsed, 0)
  })

  it("dev-login works in production when BILLING_MOCK=1", async () => {
    env.BILLING_MOCK = "1"
    env.NODE_ENV = "production"
    const res = await devLoginPOST(
      jsonReq("https://cloud.test/api/auth/dev-login", { email: "demo@edge.test" }),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; email: string }
    assert.equal(body.ok, true)
    assert.equal(body.email, "demo@edge.test")
  })

  it("dev-login is disabled in production when BILLING_MOCK is off", async () => {
    env.NODE_ENV = "production"
    delete env.BILLING_MOCK
    const res = await devLoginPOST(
      jsonReq("https://cloud.test/api/auth/dev-login", { email: "demo@edge.test" }),
    )
    assert.equal(res.status, 404)
  })

  it("demo billing label is defined for UI", () => {
    assert.match(DEMO_BILLING_LABEL, /Demo billing mode/)
    assert.match(DEMO_BILLING_LABEL, /no real payment/i)
  })

  it("runProdCheck passes without Stripe when BILLING_MOCK=1", async () => {
    setMinimalCloudEnv()
    env.BILLING_MOCK = "1"
    delete env.STRIPE_SECRET_KEY
    const report = await runProdCheck({ skipDb: true })
    assert.equal(report.ok, true)
  })
})
