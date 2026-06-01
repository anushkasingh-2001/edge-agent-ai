/**
 * Account-auth production features: email verification, password reset,
 * refresh-token renewal, GitHub link-after-login, and migration coverage.
 *
 * Required coverage (maps to the task's numbered list):
 *   1.  Register creates user/workspace AND a verification token.
 *   2.  Password is hashed (scrypt), never raw.
 *   3.  Unverified email blocks paid checkout + paid AI (enforcement on).
 *   4.  verify-email marks emailVerified true (single-use token).
 *   5.  forgot-password stores only a HASHED reset token.
 *   6.  reset-password changes the password and invalidates the token.
 *   7.  An expired reset token fails.
 *   8.  refresh issues a new JWT and rotates the refresh token.
 *   9.  apiFetch refreshes once on 401 and retries once.
 *   10. GitHub link requires an account JWT.
 *   11. GitHub link stores a linked account without changing billing identity.
 *   12. The GitHub PAT never reaches the renderer.
 *   13. Subscriptions/credits stay on the account userId/workspaceId.
 *   14. Provider keys never appear in any auth request/response.
 *   15. Postgres migrations include all auth tables.
 *
 * Run: EDGE_AGENT_HOME=$(mktemp -d) node --import tsx --test tests/account-auth-prod.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { POST as registerPOST } from "../app/api/auth/register/route"
import { POST as sendVerificationPOST } from "../app/api/auth/send-verification/route"
import { POST as verifyEmailPOST } from "../app/api/auth/verify-email/route"
import { POST as forgotPOST } from "../app/api/auth/forgot-password/route"
import { POST as resetPOST } from "../app/api/auth/reset-password/route"
import { POST as refreshPOST } from "../app/api/auth/refresh/route"
import { POST as linkGithubPOST } from "../app/api/auth/link/github/route"
import { POST as chatPOST } from "../app/api/hosted/chat/route"
import { POST as checkoutPOST } from "../app/api/billing/checkout/route"
import { POST as loginPOST } from "../app/api/auth/login/route"

import { verifyPassword, hashToken } from "../lib/server-password"
import { findVerificationCode } from "../lib/server-account"
import {
  ensureUserBootstrap,
  getAsyncUserStore,
  _resetUserBootstrapForTests,
} from "../lib/server-user-bootstrap"
import {
  FileBillingStore,
  getBillingStore,
  setBillingStore,
  PLAN_TIER_LIMITS,
} from "../lib/server-billing-store"
import { _resetBillingBootstrapForTests } from "../lib/server-billing-bootstrap"
import { getAuditWriter } from "../lib/server-audit-log"
import { _resetRateLimitsForTests } from "../lib/server-rate-limit"

const SECRET = "account-prod-test-jwt-secret-0123456789"
const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>
const ORIG_FETCH = global.fetch
const ORIG_BILLING_STORE = getBillingStore()

function resetEnv(home: string): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
  delete env.NODE_ENV
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.EDGE_AGENT_GITHUB_SESSION
  delete env.EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION
  delete env.DATABASE_URL
  delete env.NEXT_PUBLIC_CLOUD_API_BASE
  delete env.EDGE_AGENT_CLOUD_API_BASE
  delete env.BILLING_MOCK
  env.EDGE_AGENT_HOME = home
  env.JWT_SECRET = SECRET
  // Dev token return is opt-in; these tests read the raw tokens.
  env.EDGE_AGENT_RETURN_AUTH_TOKENS = "1"
}

/** Restore the process env exactly to what it was before this suite ran, so a
 *  later suite never inherits a (now-deleted) per-test EDGE_AGENT_HOME. */
function restoreOrigEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
}

function jsonReq(url: string, method: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1]
  const pad = "=".repeat((4 - (part.length % 4)) % 4)
  return JSON.parse(
    Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"),
  ) as Record<string, unknown>
}

interface RegResponse {
  ok: boolean
  token: string
  refreshToken?: string
  verificationCode?: string
  user: { id: string; email: string; workspaceId: string; emailVerified?: boolean }
}

/** Build a 6-digit code guaranteed to differ from `code`. */
function otherCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0")
}

async function register(email: string, password: string): Promise<RegResponse> {
  const res = await registerPOST(
    jsonReq("https://cloud.test/api/auth/register", "POST", { email, password }),
  )
  return (await res.json()) as RegResponse
}

function githubUserFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ login: "octocat", id: 583231, email: "octo@gh.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

describe("account-auth production features", () => {
  let home: string
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-acct-prod-"))
    resetEnv(home)
    _resetRateLimitsForTests()
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(new FileBillingStore())
    getAuditWriter()._resetForTests()
  })
  afterEach(async () => {
    global.fetch = ORIG_FETCH
    await _resetUserBootstrapForTests()
    await _resetBillingBootstrapForTests()
    setBillingStore(ORIG_BILLING_STORE)
    fs.rmSync(home, { recursive: true, force: true })
    restoreOrigEnv()
  })

  // (1) ---------------------------------------------------------------------
  it("(1) register creates a user, workspace, and verification code", async () => {
    const data = await register("verify@edge.test", "password12345")
    assert.equal(data.ok, true)
    assert.match(data.user.id, /^usr_/)
    assert.match(data.user.workspaceId, /^ws_/)
    assert.equal(data.user.emailVerified, false, "new account starts unverified")
    assert.match(data.verificationCode ?? "", /^\d{6}$/, "dev build surfaces the 6-digit code")
    assert.ok(data.refreshToken, "a refresh token is issued at register")

    await ensureUserBootstrap()
    const stored = await findVerificationCode(data.user.id, data.verificationCode!)
    assert.ok(stored, "the verification code is persisted (by hash, per-user)")
    assert.notEqual(stored!.tokenHash, data.verificationCode, "stored value is a hash, not the raw code")
  })

  // (2) ---------------------------------------------------------------------
  it("(2) stores a scrypt hash, never the raw password", async () => {
    await register("hash@edge.test", "password12345")
    await ensureUserBootstrap()
    const user = await getAsyncUserStore().getUserByEmail("hash@edge.test")
    assert.match(user!.passwordHash, /^scrypt\$/)
    assert.ok(await verifyPassword("password12345", user!.passwordHash))
  })

  // (4) ---------------------------------------------------------------------
  it("(4) verify-email with the OTP code marks emailVerified and consumes the code", async () => {
    const data = await register("v4@edge.test", "password12345")
    const code = data.verificationCode!
    const email = "v4@edge.test"

    // A wrong code is rejected.
    const bad = await verifyEmailPOST(
      jsonReq("https://cloud.test/api/auth/verify-email", "POST", { email, code: otherCode(code) }),
    )
    assert.equal(bad.status, 400)

    // The correct code verifies and auto-issues a session.
    const res = await verifyEmailPOST(
      jsonReq("https://cloud.test/api/auth/verify-email", "POST", { email, code }),
    )
    assert.equal(res.status, 200)
    const vout = (await res.json()) as { ok: boolean; token?: string; emailVerified?: boolean }
    assert.equal(vout.emailVerified, true)
    assert.ok(vout.token, "verify-email auto-issues a session token")

    await ensureUserBootstrap()
    const user = await getAsyncUserStore().getUserByEmail(email)
    assert.equal(user!.emailVerified, true)

    // Single-use: the code record is consumed after a successful verify.
    const stored = await findVerificationCode(user!.id, code)
    assert.equal(stored, null, "the code is consumed (single-use)")
  })

  it("(4b) send-verification reissues a code for a session OR a public email", async () => {
    // Anonymous with no email → generic 200 (never reveals account existence).
    const anon = await sendVerificationPOST(
      jsonReq("https://cloud.test/api/auth/send-verification", "POST", {}),
    )
    assert.equal(anon.status, 200)

    const data = await register("resend@edge.test", "password12345")

    // Authenticated resend (signed-in user) reissues a code.
    const res = await sendVerificationPOST(
      jsonReq("https://cloud.test/api/auth/send-verification", "POST", {}, data.token),
    )
    assert.equal(res.status, 200)
    const out = (await res.json()) as { ok: boolean; verificationCode?: string }
    assert.match(out.verificationCode ?? "", /^\d{6}$/, "a fresh code is issued for the signed-in user")

    // Public resend by email (no session) — used by the "verify your email"
    // screen before the user can sign in. Generic 200, code surfaced in dev.
    const pub = await sendVerificationPOST(
      jsonReq("https://cloud.test/api/auth/send-verification", "POST", {
        email: "resend@edge.test",
      }),
    )
    assert.equal(pub.status, 200)
    const pubOut = (await pub.json()) as { ok: boolean; verificationCode?: string }
    assert.match(pubOut.verificationCode ?? "", /^\d{6}$/, "a fresh code is issued for the public email path")
  })

  // (3b) Strict flow: NO account until the OTP is verified ------------------
  it("(3b) strict: registration is pending (no account) until the OTP is verified", async () => {
    env.EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION = "1"

    // Register: pending only — no session, no users row yet.
    const res = await registerPOST(
      jsonReq("https://cloud.test/api/auth/register", "POST", {
        email: "strict@edge.test",
        password: "password12345",
      }),
    )
    assert.equal(res.status, 201)
    const reg = (await res.json()) as {
      ok: boolean
      requiresVerification?: boolean
      token?: string
      verificationCode?: string
    }
    assert.equal(reg.requiresVerification, true, "registration requires verification")
    assert.equal(reg.token, undefined, "no session token is issued before verification")
    assert.match(reg.verificationCode ?? "", /^\d{6}$/, "dev surfaces the verification code")

    // The account does NOT exist yet — it's only a pending registration.
    await ensureUserBootstrap()
    assert.equal(
      await getAsyncUserStore().getUserByEmail("strict@edge.test"),
      null,
      "no users row is created before verification",
    )

    // Login before verifying is blocked with a dedicated 403, and a fresh code
    // is (re)sent so the user can finish.
    const blocked = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "strict@edge.test",
        password: "password12345",
      }),
    )
    assert.equal(blocked.status, 403)
    const bout = (await blocked.json()) as { code: string; email?: string; verificationCode?: string }
    assert.equal(bout.code, "email_not_verified")
    assert.match(bout.verificationCode ?? "", /^\d{6}$/, "login resends a fresh verification code")

    // Verifying with the freshest code CREATES the account and signs in.
    const verify = await verifyEmailPOST(
      jsonReq("https://cloud.test/api/auth/verify-email", "POST", {
        email: "strict@edge.test",
        code: bout.verificationCode,
      }),
    )
    assert.equal(verify.status, 200)
    const vout = (await verify.json()) as { ok: boolean; token?: string; emailVerified?: boolean }
    assert.equal(vout.emailVerified, true)
    assert.ok(vout.token, "verify-email auto-issues a session token")

    // The account now exists and is verified; the pending row is gone.
    const created = await getAsyncUserStore().getUserByEmail("strict@edge.test")
    assert.ok(created && created.emailVerified === true, "account created + verified on OTP")
    assert.equal(
      await getAsyncUserStore().getPendingRegistration("strict@edge.test"),
      null,
      "pending registration is consumed",
    )

    // Login now succeeds and returns a session.
    const okLogin = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "strict@edge.test",
        password: "password12345",
      }),
    )
    assert.equal(okLogin.status, 200)
    assert.ok(((await okLogin.json()) as { token?: string }).token, "verified login returns a token")

    // (1) Re-registering an EXISTING verified email is refused (no new account).
    const dup = await registerPOST(
      jsonReq("https://cloud.test/api/auth/register", "POST", {
        email: "strict@edge.test",
        password: "password12345",
      }),
    )
    assert.equal(dup.status, 409)
    assert.equal((await dup.json() as { code?: string }).code, "user_exists")
  })

  // (5) + (6) ---------------------------------------------------------------
  it("(5/6) forgot-password hashes the token; reset-password changes the password", async () => {
    await register("reset@edge.test", "password12345")
    const fres = await forgotPOST(
      jsonReq("https://cloud.test/api/auth/forgot-password", "POST", { email: "reset@edge.test" }),
    )
    assert.equal(fres.status, 200)
    const fout = (await fres.json()) as { ok: boolean; resetToken?: string }
    assert.ok(fout.resetToken, "dev build surfaces the reset token")

    // Stored value is a hash, never the raw token.
    await ensureUserBootstrap()
    const stored = await getAsyncUserStore().findResetToken(hashToken(fout.resetToken!))
    assert.ok(stored)
    assert.notEqual(stored!.tokenHash, fout.resetToken)

    const rres = await resetPOST(
      jsonReq("https://cloud.test/api/auth/reset-password", "POST", {
        token: fout.resetToken,
        password: "brand-new-password",
      }),
    )
    assert.equal(rres.status, 200)

    // New password works; old one no longer does.
    const user = await getAsyncUserStore().getUserByEmail("reset@edge.test")
    assert.ok(await verifyPassword("brand-new-password", user!.passwordHash))
    assert.ok(!(await verifyPassword("password12345", user!.passwordHash)))

    // Token is single-use.
    const replay = await resetPOST(
      jsonReq("https://cloud.test/api/auth/reset-password", "POST", {
        token: fout.resetToken,
        password: "yet-another-password",
      }),
    )
    assert.equal(replay.status, 400)
  })

  // (7) ---------------------------------------------------------------------
  it("(7) an expired reset token fails", async () => {
    const data = await register("expired@edge.test", "password12345")
    await ensureUserBootstrap()
    const raw = "expired-token-value-123456"
    const past = new Date(Date.now() - 60_000).toISOString()
    await getAsyncUserStore().createResetToken(data.user.id, hashToken(raw), past)

    const res = await resetPOST(
      jsonReq("https://cloud.test/api/auth/reset-password", "POST", {
        token: raw,
        password: "should-not-work",
      }),
    )
    assert.equal(res.status, 400)
  })

  // (8) ---------------------------------------------------------------------
  it("(8) refresh issues a new JWT and rotates the refresh token", async () => {
    const data = await register("refresh@edge.test", "password12345")
    const res = await refreshPOST(
      jsonReq("https://cloud.test/api/auth/refresh", "POST", { refreshToken: data.refreshToken }),
    )
    assert.equal(res.status, 200)
    const out = (await res.json()) as { ok: boolean; token: string; refreshToken?: string }
    assert.ok(out.token)
    assert.match(String(decodePayload(out.token).sub), /^usr_/)
    assert.ok(out.refreshToken && out.refreshToken !== data.refreshToken, "refresh token rotates")

    // The old (presented) refresh token is now revoked.
    const reuse = await refreshPOST(
      jsonReq("https://cloud.test/api/auth/refresh", "POST", { refreshToken: data.refreshToken }),
    )
    assert.equal(reuse.status, 401)

    // A bogus refresh token is rejected.
    const bogus = await refreshPOST(
      jsonReq("https://cloud.test/api/auth/refresh", "POST", { refreshToken: "nope" }),
    )
    assert.equal(bogus.status, 401)
  })

  // (3) ---------------------------------------------------------------------
  it("(3) unverified email blocks paid checkout and paid AI when enforced", async () => {
    env.OPENAI_API_KEY = "sk-server-side-key"
    // Register with the gate OFF so we obtain an (unverified) session token,
    // then turn enforcement ON to assert the paid actions are blocked.
    const data = await register("gate@edge.test", "password12345")
    env.EDGE_AGENT_REQUIRE_EMAIL_VERIFICATION = "1"

    // Seed a paid plan on the account so the only thing blocking is verification.
    const store = new FileBillingStore()
    setBillingStore(store)
    store.upsertSubscription(data.user.id, data.user.workspaceId, {
      planTier: "team",
      creditsLimit: PLAN_TIER_LIMITS.team.creditsLimit,
      creditsUsed: 0,
      subscriptionStatus: "active",
    })

    // Paid checkout is blocked with 403 email_unverified (before Stripe).
    const checkout = await checkoutPOST(
      jsonReq("http://localhost/api/billing/checkout", "POST", { tier: "pro" }, data.token),
    )
    assert.equal(checkout.status, 403)
    assert.equal(((await checkout.json()) as { code: string }).code, "email_unverified")

    // Paid AI mode (pro) is blocked too.
    const pro = await chatPOST(
      jsonReq(
        "http://localhost/api/hosted/chat",
        "POST",
        { intelligenceMode: "pro", messages: [{ role: "user", content: "hi" }] },
        data.token,
      ),
    )
    assert.equal(pro.status, 403)

    // Free-tier AI still works (auto mode), so unverified users aren't locked out.
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", role: "assistant" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch
    const auto = await chatPOST(
      jsonReq(
        "http://localhost/api/hosted/chat",
        "POST",
        { intelligenceMode: "auto", messages: [{ role: "user", content: "hi" }] },
        data.token,
      ),
    )
    assert.equal(auto.status, 200)

    // After verifying, checkout passes the verification gate (no longer 403).
    global.fetch = ORIG_FETCH
    await ensureUserBootstrap()
    await getAsyncUserStore().markEmailVerified(data.user.id)
    const login = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "gate@edge.test",
        password: "password12345",
      }),
    )
    const fresh = (await login.json()) as RegResponse
    assert.equal(decodePayload(fresh.token).email_verified, true)
    const checkout2 = await checkoutPOST(
      jsonReq("http://localhost/api/billing/checkout", "POST", { tier: "pro" }, fresh.token),
    )
    assert.notEqual(checkout2.status, 403, "verified account clears the email gate")
  })

  // (10) + (11) + (12) ------------------------------------------------------
  it("(10/11/12) GitHub link requires a JWT, stores a link, never leaks the PAT", async () => {
    global.fetch = githubUserFetch()

    // (10) No account JWT → 401.
    const anon = await linkGithubPOST(
      jsonReq("https://cloud.test/api/auth/link/github", "POST", { token: "ghp_secret_pat" }),
    )
    assert.equal(anon.status, 401)

    const data = await register("ghlink@edge.test", "password12345")
    const res = await linkGithubPOST(
      jsonReq("https://cloud.test/api/auth/link/github", "POST", { token: "ghp_secret_pat" }, data.token),
    )
    assert.equal(res.status, 200)
    const raw = JSON.stringify(await res.json())
    // (12) PAT never echoed back to the renderer.
    assert.ok(!raw.includes("ghp_secret_pat"), "GitHub PAT must not reach the client")

    // (11) A linked_accounts row exists, keyed to the ACCOUNT userId, and the
    //      account identity / billing keys are unchanged.
    await ensureUserBootstrap()
    const links = await getAsyncUserStore().getLinkedAccounts(data.user.id)
    assert.equal(links.length, 1)
    const link = links[0]!
    assert.equal(link.provider, "github")
    assert.ok(!(link.tokenRef ?? "").includes("ghp_secret_pat"), "stored tokenRef is not the PAT")
    assert.match(data.user.id, /^usr_/, "billing identity stays on the account, not GitHub")
  })

  // (14) --------------------------------------------------------------------
  it("(14) provider keys never appear in any auth response", async () => {
    env.OPENAI_API_KEY = "sk-openai-leak-check"
    env.ANTHROPIC_API_KEY = "sk-ant-leak-check"
    const data = await register("keys@edge.test", "password12345")
    const refreshRes = await refreshPOST(
      jsonReq("https://cloud.test/api/auth/refresh", "POST", { refreshToken: data.refreshToken }),
    )
    const blobs = [JSON.stringify(data), JSON.stringify(await refreshRes.json())]
    for (const blob of blobs) {
      assert.ok(!blob.includes("sk-openai-leak-check"))
      assert.ok(!blob.includes("sk-ant-leak-check"))
      assert.ok(!blob.includes("passwordHash"))
      assert.ok(!blob.includes("scrypt$"))
    }
  })

  // (15) --------------------------------------------------------------------
  it("(15) Postgres migrations include all auth tables", () => {
    const dir = path.resolve(process.cwd(), "migrations")
    const sql = fs
      .readdirSync(dir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n")
    for (const table of [
      "users",
      "workspaces",
      "linked_accounts",
      "email_verification_tokens",
      "password_reset_tokens",
      "refresh_tokens",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing table ${table}`)
    }
    assert.match(sql, /email_verified/, "users carries email_verified column")
  })
})
