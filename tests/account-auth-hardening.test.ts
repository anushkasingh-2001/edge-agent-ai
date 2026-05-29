/**
 * Production auth hardening: email sending, rate limiting, refresh-token
 * revocation, and token cleanup.
 *
 * Required coverage:
 *   1.  Register sends a verification email (production mode).
 *   2.  Verification token is NOT returned in a production response.
 *   3.  Dev token return works only with EDGE_AGENT_RETURN_AUTH_TOKENS=1.
 *   4.  Forgot-password sends a reset email without revealing existence.
 *   5.  Reset-password revokes all refresh tokens.
 *   6.  An old refresh token fails after a password reset.
 *   7.  logout-all revokes all refresh tokens.
 *   8.  Rate limit blocks repeated forgot-password requests.
 *   9.  Rate limit blocks repeated login failures.
 *   10. Cleanup deletes expired/used/old tokens.
 *   11. Cleanup keeps valid active tokens.
 *   12. The email adapter never logs a raw token.
 *   13. Provider keys never appear in responses/logs.
 *   14. GitHub remains optional and does not affect billing identity.
 *
 * Run: EDGE_AGENT_HOME=$(mktemp -d) node --import tsx --test tests/account-auth-hardening.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { POST as registerPOST } from "../app/api/auth/register/route"
import { POST as loginPOST } from "../app/api/auth/login/route"
import { POST as forgotPOST } from "../app/api/auth/forgot-password/route"
import { POST as resetPOST } from "../app/api/auth/reset-password/route"
import { POST as refreshPOST } from "../app/api/auth/refresh/route"
import { POST as logoutAllPOST } from "../app/api/auth/logout-all/route"
import { GET as cleanupGET, POST as cleanupPOST } from "../app/api/auth/cleanup/route"

import {
  _setEmailTransportForTests,
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../lib/server-email"
import { _resetRateLimitsForTests, rateLimiterKind } from "../lib/server-rate-limit"
import { hashToken } from "../lib/server-password"
import { cleanupAuthTokens } from "../lib/server-auth-token-cleanup"
import {
  ensureUserBootstrap,
  getAsyncUserStore,
  _resetUserBootstrapForTests,
} from "../lib/server-user-bootstrap"
import { FileBillingStore, getBillingStore, setBillingStore } from "../lib/server-billing-store"
import { _resetBillingBootstrapForTests } from "../lib/server-billing-bootstrap"
import { getAuditWriter } from "../lib/server-audit-log"

const SECRET = "hardening-test-jwt-secret-0123456789"
const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>
const ORIG_FETCH = global.fetch
const ORIG_BILLING_STORE = getBillingStore()

interface SentEmail {
  to: string
  subject: string
  html: string
  text: string
}

let sent: SentEmail[] = []

function installCaptureTransport(): void {
  _setEmailTransportForTests({
    name: "capture",
    async send(msg) {
      sent.push(msg)
    },
  })
}

function resetEnv(home: string): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
  delete env.NODE_ENV
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.DATABASE_URL
  delete env.EDGE_AGENT_RETURN_AUTH_TOKENS
  delete env.NEXT_PUBLIC_CLOUD_API_BASE
  env.EDGE_AGENT_HOME = home
  env.JWT_SECRET = SECRET
}

function restoreOrigEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
}

function jsonReq(url: string, body?: unknown, token?: string, ip = "1.2.3.4"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip }
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface RegResponse {
  ok: boolean
  token: string
  refreshToken?: string
  verificationToken?: string
  user: { id: string; email: string; workspaceId: string; emailVerified?: boolean }
}

async function register(email: string, password: string, ip = "1.2.3.4"): Promise<RegResponse> {
  const res = await registerPOST(jsonReq("https://cloud.test/api/auth/register", { email, password }, undefined, ip))
  return (await res.json()) as RegResponse
}

describe("account auth hardening", () => {
  let home: string
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-harden-"))
    resetEnv(home)
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(new FileBillingStore())
    getAuditWriter()._resetForTests()
    _resetRateLimitsForTests()
    sent = []
    installCaptureTransport()
  })
  afterEach(async () => {
    global.fetch = ORIG_FETCH
    _setEmailTransportForTests(null)
    _resetRateLimitsForTests()
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(ORIG_BILLING_STORE)
    fs.rmSync(home, { recursive: true, force: true })
    restoreOrigEnv()
  })

  // (1) + (2) ---------------------------------------------------------------
  it("(1/2) register sends a verification email and does NOT return the token in production", async () => {
    env.NODE_ENV = "production"
    env.USER_STORE = "file" // allow account store without DATABASE_URL in prod-mode test
    const data = await register("prod@edge.test", "password12345")
    assert.equal(data.ok, true)
    assert.equal(data.verificationToken, undefined, "no raw token in production response")
    assert.equal(sent.length, 1, "one verification email sent")
    assert.equal(sent[0]!.to, "prod@edge.test")
    assert.match(sent[0]!.html, /\/auth\/verify-email\?token=/, "email contains the verify link")
  })

  // (3) ---------------------------------------------------------------------
  it("(3) dev token return requires EDGE_AGENT_RETURN_AUTH_TOKENS=1", async () => {
    // dev, flag OFF → no token in response (but email still 'sent').
    const off = await register("devoff@edge.test", "password12345")
    assert.equal(off.verificationToken, undefined, "no token without the flag")
    assert.equal(sent.length, 1)

    // dev, flag ON → token surfaced.
    env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
    const on = await register("devon@edge.test", "password12345", "9.9.9.9")
    assert.ok(on.verificationToken, "token returned with the flag in dev")
  })

  // (4) ---------------------------------------------------------------------
  it("(4) forgot-password sends a reset email without revealing existence", async () => {
    await register("known@edge.test", "password12345")
    sent = []

    const known = await forgotPOST(jsonReq("https://cloud.test/api/auth/forgot-password", { email: "known@edge.test" }, undefined, "5.5.5.5"))
    const knownBody = (await known.json()) as { ok: boolean; message: string }
    const unknown = await forgotPOST(jsonReq("https://cloud.test/api/auth/forgot-password", { email: "nobody@edge.test" }, undefined, "5.5.5.6"))
    const unknownBody = (await unknown.json()) as { ok: boolean; message: string }

    // Identical generic responses → no enumeration.
    assert.equal(known.status, unknown.status)
    assert.deepEqual(knownBody, unknownBody)
    // But an email is only actually sent for the real account.
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.to, "known@edge.test")
    assert.match(sent[0]!.html, /\/auth\/reset-password\?token=/)
  })

  // (5) + (6) ---------------------------------------------------------------
  it("(5/6) reset-password revokes all refresh tokens; old refresh token then fails", async () => {
    env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
    const data = await register("reset@edge.test", "password12345")
    assert.ok(data.refreshToken)

    // Get the reset token (dev surfaces it).
    const fres = await forgotPOST(jsonReq("https://cloud.test/api/auth/forgot-password", { email: "reset@edge.test" }, undefined, "6.6.6.6"))
    const { resetToken } = (await fres.json()) as { resetToken: string }
    assert.ok(resetToken)

    const rres = await resetPOST(jsonReq("https://cloud.test/api/auth/reset-password", { token: resetToken, password: "new-password-123" }, undefined, "6.6.6.7"))
    assert.equal(rres.status, 200)

    // (6) the pre-reset refresh token no longer works.
    const refresh = await refreshPOST(jsonReq("https://cloud.test/api/auth/refresh", { refreshToken: data.refreshToken }, undefined, "6.6.6.8"))
    assert.equal(refresh.status, 401, "refresh token revoked by the reset")

    // And no active refresh token remains in the store.
    await ensureUserBootstrap()
    const stillValid = await getAsyncUserStore().findRefreshToken(hashToken(data.refreshToken!))
    assert.equal(stillValid, null)
  })

  // (7) ---------------------------------------------------------------------
  it("(7) logout-all revokes all refresh tokens for the user", async () => {
    const data = await register("logoutall@edge.test", "password12345")
    assert.ok(data.refreshToken)

    const res = await logoutAllPOST(jsonReq("https://cloud.test/api/auth/logout-all", {}, data.token))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean; revoked: number }
    assert.equal(body.ok, true)
    assert.ok(body.revoked >= 1, "at least one refresh token revoked")

    // The refresh token is now dead.
    const refresh = await refreshPOST(jsonReq("https://cloud.test/api/auth/refresh", { refreshToken: data.refreshToken }, undefined, "7.7.7.7"))
    assert.equal(refresh.status, 401)

    // Requires a JWT.
    const anon = await logoutAllPOST(jsonReq("https://cloud.test/api/auth/logout-all", {}))
    assert.equal(anon.status, 401)
  })

  // (8) ---------------------------------------------------------------------
  it("(8) rate limit blocks repeated forgot-password requests (per email)", async () => {
    await register("rl@edge.test", "password12345")
    let last = 200
    // 3 allowed per email/hour; 4th is blocked. Vary IP so the email limit (not
    // the IP limit) is what trips.
    for (let i = 0; i < 4; i++) {
      const res = await forgotPOST(
        jsonReq("https://cloud.test/api/auth/forgot-password", { email: "rl@edge.test" }, undefined, `10.0.0.${i}`),
      )
      last = res.status
    }
    assert.equal(last, 429, "4th forgot-password for the same email is rate limited")
  })

  // (9) ---------------------------------------------------------------------
  it("(9) rate limit blocks repeated login failures", async () => {
    await register("brute@edge.test", "password12345")
    let last = 401
    // 5 failures allowed per (email+IP)/15min; the 6th attempt is blocked.
    for (let i = 0; i < 6; i++) {
      const res = await loginPOST(
        jsonReq("https://cloud.test/api/auth/login", { email: "brute@edge.test", password: "wrong" }, undefined, "11.0.0.1"),
      )
      last = res.status
    }
    assert.equal(last, 429, "repeated login failures are rate limited")

    // A different IP is not affected (independent budget).
    const other = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", { email: "brute@edge.test", password: "wrong" }, undefined, "11.0.0.2"),
    )
    assert.equal(other.status, 401, "a different IP still gets the normal 401")
  })

  // (10) + (11) -------------------------------------------------------------
  it("(10/11) cleanup deletes expired/used tokens but keeps valid active ones", async () => {
    // Two users so per-user token supersession doesn't clobber our fixtures.
    const a = await register("cleanup-a@edge.test", "password12345", "20.0.0.1")
    const b = await register("cleanup-b@edge.test", "password12345", "20.0.0.2")
    await ensureUserBootstrap()
    const store = getAsyncUserStore()

    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()

    // userA: expired reset + expired refresh tokens (should be deleted).
    await store.createResetToken(a.user.id, hashToken("r-expired"), past)
    await store.createRefreshToken(a.user.id, a.user.workspaceId, hashToken("ref-expired"), past)
    // userB: a valid active reset token (should be kept).
    await store.createResetToken(b.user.id, hashToken("r-valid"), future)

    const result = await cleanupAuthTokens()
    assert.ok(result.reset >= 1, "expired reset token deleted")
    assert.ok(result.refresh >= 1, "expired refresh token deleted")

    // The active reset token survives.
    const valid = await store.findResetToken(hashToken("r-valid"))
    assert.ok(valid, "valid active token is preserved")
    // The expired one is gone.
    const gone = await store.findResetToken(hashToken("r-expired"))
    assert.equal(gone, null)
  })

  // (12) --------------------------------------------------------------------
  it("(12) the email adapter never logs the raw token", async () => {
    // Use a transport that throws, forcing the adapter's error log path.
    _setEmailTransportForTests({
      name: "boom",
      async send() {
        throw new Error("simulated provider failure")
      },
    })
    const logs: string[] = []
    const origErr = console.error
    console.error = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "))
    }
    try {
      const RAW = "super-secret-raw-token-value-987654321"
      const res = await sendVerificationEmail("leak@edge.test", RAW)
      assert.equal(res.ok, false)
      for (const line of logs) {
        assert.ok(!line.includes(RAW), "raw token must never be logged")
        assert.ok(!line.includes("/auth/verify-email?token="), "the link (with token) must never be logged")
      }
    } finally {
      console.error = origErr
    }
  })

  // (13) --------------------------------------------------------------------
  it("(13) provider keys never appear in responses", async () => {
    env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
    env.OPENAI_API_KEY = "sk-openai-leak"
    env.ANTHROPIC_API_KEY = "sk-ant-leak"
    const data = await register("keys2@edge.test", "password12345")
    const blob = JSON.stringify(data) + JSON.stringify(sent)
    assert.ok(!blob.includes("sk-openai-leak"))
    assert.ok(!blob.includes("sk-ant-leak"))
    assert.ok(!blob.includes("passwordHash"))
  })

  // (14) --------------------------------------------------------------------
  it("(14) GitHub stays optional and billing identity remains the account", async () => {
    const data = await register("optgh@edge.test", "password12345")
    await ensureUserBootstrap()
    // No linked accounts by default; account works without GitHub.
    assert.deepEqual(await getAsyncUserStore().getLinkedAccounts(data.user.id), [])
    assert.match(data.user.id, /^usr_/, "billing identity is the account id, not a GitHub id")
    assert.match(data.user.workspaceId, /^ws_/)
  })

  // (15) --------------------------------------------------------------------
  it("(15) live Postgres smoke + migrate + prod-check docs are present", () => {
    const authDoc = fs.readFileSync(path.join(process.cwd(), "docs", "CLOUD-AUTH.md"), "utf8")
    const deployDoc = fs.readFileSync(path.join(process.cwd(), "docs", "CLOUD-DEPLOYMENT.md"), "utf8")
    assert.match(authDoc, /pnpm db:migrate/)
    assert.match(authDoc, /pnpm db:user-smoke/)
    assert.match(authDoc, /pnpm auth:cleanup/)
    assert.match(deployDoc, /pnpm prod:check/)
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    assert.ok(pkg.scripts["db:user-smoke"], "db:user-smoke script registered")
    assert.ok(pkg.scripts["auth:cleanup"], "auth:cleanup script registered")
    assert.ok(pkg.scripts["prod:check"], "prod:check script registered")
  })

  // (16) Resend ------------------------------------------------------------
  it("(16) Resend sends verification + reset email when RESEND_API_KEY is set, and never logs the token", async () => {
    _setEmailTransportForTests(null) // use the real provider resolution
    env.RESEND_API_KEY = "re_test_key"
    env.EMAIL_FROM = "Edge Agent AI <noreply@edge.test>"
    env.NEXT_PUBLIC_APP_URL = "https://app.edge.test"

    const calls: Array<{ url: string; body: string }> = []
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const logs: string[] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "))
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "))
    try {
      const RAW_V = "verify-raw-token-aaa111"
      const RAW_R = "reset-raw-token-bbb222"
      const v = await sendVerificationEmail("user@edge.test", RAW_V)
      const r = await sendPasswordResetEmail("user@edge.test", RAW_R)
      assert.equal(v.ok, true)
      assert.equal(v.provider, "resend")
      assert.equal(r.ok, true)
      assert.equal(calls.length, 2, "two Resend API calls")
      assert.ok(calls.every((c) => c.url.includes("api.resend.com/emails")))
      assert.match(calls[0]!.body, /\/auth\/verify-email\?token=verify-raw-token-aaa111/)
      assert.match(calls[1]!.body, /\/auth\/reset-password\?token=reset-raw-token-bbb222/)
      // Nothing about the raw token reaches the logs.
      for (const line of logs) {
        assert.ok(!line.includes(RAW_V) && !line.includes(RAW_R), "raw token must never be logged")
      }
    } finally {
      console.log = origLog
      console.error = origErr
    }
  })

  // (17) ---------------------------------------------------------------------
  it("(17) Redis limiter is selected when Upstash env exists; in-memory otherwise", () => {
    // No Upstash env (dev default) → memory.
    _resetRateLimitsForTests()
    assert.equal(rateLimiterKind(), "memory")

    // Upstash env present → redis backend selected.
    env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io"
    env.UPSTASH_REDIS_REST_TOKEN = "tok_test"
    _resetRateLimitsForTests()
    assert.equal(rateLimiterKind(), "redis")

    // Cleared again → back to memory.
    delete env.UPSTASH_REDIS_REST_URL
    delete env.UPSTASH_REDIS_REST_TOKEN
    _resetRateLimitsForTests()
    assert.equal(rateLimiterKind(), "memory")
  })

  // (18) ---------------------------------------------------------------------
  it("(18) in-memory limiter still enforces a 429 in dev (no Upstash)", async () => {
    assert.equal(rateLimiterKind(), "memory")
    await register("memlimit@edge.test", "password12345")
    let last = 200
    for (let i = 0; i < 4; i++) {
      const res = await forgotPOST(
        jsonReq("https://cloud.test/api/auth/forgot-password", { email: "memlimit@edge.test" }, undefined, `30.0.0.${i}`),
      )
      last = res.status
    }
    assert.equal(last, 429)
  })

  // (19) cron cleanup --------------------------------------------------------
  it("(19) cleanup cron requires the secret, deletes expired tokens, keeps active ones", async () => {
    // Without a secret configured the route is disabled (404).
    const disabled = await cleanupPOST(new Request("https://cloud.test/api/auth/cleanup", { method: "POST" }))
    assert.equal(disabled.status, 404)

    env.AUTH_CLEANUP_SECRET = "cron-secret-xyz"

    // Wrong / missing secret → 401.
    const noAuth = await cleanupGET(new Request("https://cloud.test/api/auth/cleanup"))
    assert.equal(noAuth.status, 401)
    const wrong = await cleanupGET(new Request("https://cloud.test/api/auth/cleanup?key=nope"))
    assert.equal(wrong.status, 401)

    // Seed expired + active tokens on two users (per-user supersession safe).
    const a = await register("cron-a@edge.test", "password12345", "31.0.0.1")
    const b = await register("cron-b@edge.test", "password12345", "31.0.0.2")
    await ensureUserBootstrap()
    const store = getAsyncUserStore()
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    await store.createResetToken(a.user.id, hashToken("cron-expired"), past)
    await store.createResetToken(b.user.id, hashToken("cron-active"), future)

    // Correct secret via bearer → 200 with delete counts.
    const ok = await cleanupPOST(
      new Request("https://cloud.test/api/auth/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer cron-secret-xyz" },
      }),
    )
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as { ok: boolean; deleted: { reset: number } }
    assert.equal(body.ok, true)
    assert.ok(body.deleted.reset >= 1, "expired reset token deleted")

    // Active token preserved; expired gone.
    assert.ok(await store.findResetToken(hashToken("cron-active")))
    assert.equal(await store.findResetToken(hashToken("cron-expired")), null)

    // Vercel's CRON_SECRET is also accepted.
    delete env.AUTH_CLEANUP_SECRET
    env.CRON_SECRET = "vercel-cron-secret"
    const viaCron = await cleanupGET(
      new Request("https://cloud.test/api/auth/cleanup", {
        headers: { Authorization: "Bearer vercel-cron-secret" },
      }),
    )
    assert.equal(viaCron.status, 200)
  })
})
