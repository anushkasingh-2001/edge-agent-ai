/**
 * Production readiness check — env validation and schema expectations.
 *
 * Run: EDGE_AGENT_HOME=$(mktemp -d) node --import tsx --test tests/prod-check.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  BYOK_FORBIDDEN_ENV,
  EXPECTED_PG_TABLES,
  REQUIRED_CLOUD_ENV,
  checkCloudEnv,
  checkDesktopBuildEnv,
  runProdCheck,
} from "../lib/server-prod-check"

const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>

function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
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
  env.BILLING_MOCK = "1"
  env.STRIPE_SECRET_KEY = "sk_test_abc"
  env.STRIPE_WEBHOOK_SECRET = "whsec_test"
  env.STRIPE_PRICE_STARTER = "price_starter"
  env.STRIPE_PRICE_PRO = "price_pro"
  env.STRIPE_PRICE_TEAM = "price_team"
  env.NEXT_PUBLIC_BILLING_SUCCESS_URL = "https://app.test/billing/success"
  env.NEXT_PUBLIC_BILLING_CANCEL_URL = "https://app.test/billing/cancel"
}

describe("prod check", () => {
  beforeEach(() => restore())
  afterEach(() => restore())

  it("lists all required cloud env keys", () => {
    assert.ok(REQUIRED_CLOUD_ENV.includes("DATABASE_URL"))
    assert.ok(REQUIRED_CLOUD_ENV.includes("RESEND_API_KEY"))
    assert.ok(REQUIRED_CLOUD_ENV.includes("AUTH_CLEANUP_SECRET"))
    assert.equal(EXPECTED_PG_TABLES.length, 10)
  })

  it("fails when required env vars are missing", () => {
    delete env.DATABASE_URL
    delete env.JWT_SECRET
    const checks = checkCloudEnv()
    assert.ok(checks.some((c) => c.id === "DATABASE_URL" && c.status === "fail"))
    assert.ok(checks.some((c) => c.id === "JWT_SECRET" && c.status === "fail"))
  })

  it("passes env check when all required vars are set (mock billing)", () => {
    setMinimalCloudEnv()
    delete env.NODE_ENV
    const checks = checkCloudEnv()
    const fails = checks.filter((c) => c.status === "fail")
    assert.deepEqual(fails, [], `unexpected fails: ${JSON.stringify(fails)}`)
    assert.ok(checks.some((c) => c.id === "BILLING_MOCK" && c.status === "ok"))
  })

  it("requires Stripe when BILLING_MOCK is off", () => {
    setMinimalCloudEnv()
    delete env.BILLING_MOCK
    delete env.STRIPE_SECRET_KEY
    env.PROD_CHECK = "1"
    const checks = checkCloudEnv()
    assert.ok(checks.some((c) => c.id === "STRIPE_SECRET_KEY" && c.status === "fail"))
  })

  it("flags BYOK/dev-token env in production mode", () => {
    setMinimalCloudEnv()
    env.NODE_ENV = "production"
    env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
    env.GEMINI_API_KEY = "gemini-should-not-be-set"
    const checks = checkCloudEnv()
    assert.ok(checks.some((c) => c.id === "forbidden_EDGE_AGENT_RETURN_AUTH_TOKENS" && c.status === "fail"))
    assert.ok(checks.some((c) => c.id === "forbidden_GEMINI_API_KEY" && c.status === "fail"))
    assert.ok(BYOK_FORBIDDEN_ENV.includes("GEMINI_API_KEY"))
  })

  it("warns when Upstash Redis is missing in dev", () => {
    setMinimalCloudEnv()
    delete env.NODE_ENV
    delete env.UPSTASH_REDIS_REST_URL
    delete env.UPSTASH_REDIS_REST_TOKEN
    const checks = checkCloudEnv()
    assert.ok(checks.some((c) => c.id === "upstash_redis" && c.status === "warn"))
  })

  it("desktop build check rejects cloud secrets in desktop env", () => {
    env.NEXT_PUBLIC_CLOUD_API_BASE = "https://cloud.test"
    env.OPENAI_API_KEY = "sk-leak"
    env.DATABASE_URL = "postgres://leak"
    const checks = checkDesktopBuildEnv()
    assert.ok(checks.some((c) => c.id === "desktop_forbidden_OPENAI_API_KEY" && c.status === "fail"))
    assert.ok(checks.some((c) => c.id === "desktop_forbidden_DATABASE_URL" && c.status === "fail"))
  })

  it("runProdCheck skips db when skipDb is true", async () => {
    setMinimalCloudEnv()
    const report = await runProdCheck({ skipDb: true })
    assert.equal(report.ok, true)
    assert.equal(report.checks.find((c) => c.id === "postgres_connection"), undefined)
  })
})
