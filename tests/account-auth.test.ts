/**
 * Edge Agent AI account auth (email/password) — the identity of record.
 *
 * Required coverage:
 *   1.  register with email/password.
 *   2.  password is hashed (scrypt), never stored raw.
 *   3.  login returns a session JWT.
 *   4.  the JWT carries the account userId/workspaceId (usr_/ws_), not a
 *       GitHub id.
 *   5.  a hosted AI route accepts the account JWT.
 *   6.  a hosted AI route rejects a missing/invalid JWT (401).
 *   7.  billing (dev-checkout) attaches to the account userId/workspaceId.
 *   8.  credits debit from the account.
 *   9.  GitHub linking is optional (linked_accounts row, identity unchanged).
 *   10. a stored GitHub login is NOT a subscription identity by default
 *       (gated behind EDGE_AGENT_GITHUB_SESSION).
 *   11. the GitHub PAT / password hash never reach the renderer.
 *   12. provider keys never appear in token / response.
 *   13. no BYOK / apiKey field is accepted or echoed.
 *
 * Run: EDGE_AGENT_HOME=$(mktemp -d) node --import tsx --test tests/account-auth.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  assertSession,
  getOptionalSession,
  _signHs256,
  AuthRequiredError,
} from "../lib/server-auth"
import { POST as registerPOST } from "../app/api/auth/register/route"
import { POST as loginPOST } from "../app/api/auth/login/route"
import { POST as logoutPOST } from "../app/api/auth/logout/route"
import { GET as meGET } from "../app/api/auth/me/route"
import { POST as chatPOST } from "../app/api/hosted/chat/route"
import { POST as devCheckoutPOST } from "../app/api/billing/dev-checkout/route"
import { verifyPassword } from "../lib/server-password"
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
import { storeAuth } from "../lib/server-github-auth"

const SECRET = "account-test-jwt-secret-0123456789"
const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>
const ORIG_FETCH = global.fetch
// Capture the process-wide billing singleton so we can restore it after this
// suite (other suites, e.g. audit-gaps-fix, rely on the default store).
const ORIG_BILLING_STORE = getBillingStore()

function resetEnv(home: string): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
  delete env.NODE_ENV
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.EDGE_AGENT_AUTH_BEARER
  delete env.EDGE_AGENT_GITHUB_SESSION
  delete env.DATABASE_URL // force file-backed user + billing stores
  delete env.JWT_ISSUER
  delete env.JWT_AUDIENCE
  delete env.NEXT_PUBLIC_CLOUD_API_BASE
  delete env.EDGE_AGENT_CLOUD_API_BASE
  env.EDGE_AGENT_HOME = home
  env.JWT_SECRET = SECRET
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

interface AccountResponse {
  ok: boolean
  token: string
  expiresAt: number
  user: { id: string; email: string; name?: string; workspaceId: string; role: string }
}

async function registerUser(
  email: string,
  password: string,
  name?: string,
): Promise<{ res: Response; data: AccountResponse }> {
  const res = await registerPOST(
    jsonReq("https://cloud.test/api/auth/register", "POST", { email, password, name }),
  )
  const data = (await res.json()) as AccountResponse
  return { res, data }
}

describe("Edge Agent AI account auth", () => {
  let home: string
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-account-"))
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
    // Restore the global billing singleton so later suites see the default.
    setBillingStore(ORIG_BILLING_STORE)
    fs.rmSync(home, { recursive: true, force: true })
    restoreOrigEnv()
  })

  // (1) --------------------------------------------------------------------
  it("(1) registers a user with email/password", async () => {
    const { res, data } = await registerUser("ada@edge.test", "hunter2hunter", "Ada Lovelace")
    assert.equal(res.status, 201)
    assert.equal(data.ok, true)
    assert.equal(data.user.email, "ada@edge.test")
    assert.equal(data.user.name, "Ada Lovelace")
    assert.ok(data.token, "a session token is returned")

    // Duplicate email is rejected with 409.
    const dup = await registerUser("ada@edge.test", "anotherpassword")
    assert.equal(dup.res.status, 409)
  })

  it("(1b) rejects weak passwords and invalid emails", async () => {
    const weak = await registerUser("a@b.test", "short")
    assert.equal(weak.res.status, 400)
    const badEmail = await registerUser("not-an-email", "longenoughpassword")
    assert.equal(badEmail.res.status, 400)
  })

  // (2) --------------------------------------------------------------------
  it("(2) stores a scrypt hash, never the raw password", async () => {
    const password = "correct horse battery staple"
    await registerUser("grace@edge.test", password)
    await ensureUserBootstrap()
    const user = await getAsyncUserStore().getUserByEmail("grace@edge.test")
    assert.ok(user, "user persisted")
    assert.notEqual(user!.passwordHash, password, "hash is not the raw password")
    assert.match(user!.passwordHash, /^scrypt\$/, "hash uses the scrypt format")
    assert.ok(await verifyPassword(password, user!.passwordHash), "correct password verifies")
    assert.ok(!(await verifyPassword("wrong", user!.passwordHash)), "wrong password rejected")
  })

  // (3) --------------------------------------------------------------------
  it("(3) logs in and returns a JWT", async () => {
    await registerUser("login@edge.test", "password12345")
    const res = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "login@edge.test",
        password: "password12345",
      }),
    )
    assert.equal(res.status, 200)
    const data = (await res.json()) as AccountResponse
    assert.equal(data.ok, true)
    assert.ok(data.token)

    // A wrong password returns the same generic 401 (no user-enumeration).
    const wrong = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "login@edge.test",
        password: "wrongpassword",
      }),
    )
    assert.equal(wrong.status, 401)
    const unknown = await loginPOST(
      jsonReq("https://cloud.test/api/auth/login", "POST", {
        email: "nobody@edge.test",
        password: "whatever12345",
      }),
    )
    assert.equal(unknown.status, 401)
  })

  // (4) --------------------------------------------------------------------
  it("(4) the JWT carries the account userId/workspaceId, not a GitHub id", async () => {
    const { data } = await registerUser("ids@edge.test", "password12345")
    const payload = decodePayload(data.token)
    assert.match(String(payload.sub), /^usr_/, "sub is the account user id")
    assert.match(String(payload.workspaceId), /^ws_/, "workspaceId is the account workspace id")
    assert.ok(!String(payload.sub).startsWith("github:"), "sub is not a GitHub id")
    assert.equal(payload.email, "ids@edge.test")
    assert.equal(payload.role, "owner")

    // And the resolved session matches the issued account identity.
    const session = assertSession(jsonReq("http://localhost/api/plan", "GET", undefined, data.token))
    assert.equal(session.userId, data.user.id)
    assert.equal(session.workspaceId, data.user.workspaceId)
    assert.equal(session.authSource, "jwt")
  })

  // (5) + (6) --------------------------------------------------------------
  it("(5) a hosted AI route accepts the account JWT", async () => {
    env.OPENAI_API_KEY = "sk-server-side-key-never-leaks"
    const { data } = await registerUser("ai@edge.test", "password12345")

    // Seed a plan + credits for THIS account.
    const store = new FileBillingStore()
    setBillingStore(store)
    store.upsertSubscription(data.user.id, data.user.workspaceId, {
      planTier: "team",
      creditsLimit: PLAN_TIER_LIMITS.team.creditsLimit,
      creditsUsed: 0,
      subscriptionStatus: "active",
    })

    global.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hi from model", role: "assistant" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch

    const res = await chatPOST(
      jsonReq(
        "http://localhost/api/hosted/chat",
        "POST",
        { intelligenceMode: "auto", messages: [{ role: "user", content: "say hi" }] },
        data.token,
      ),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.reply, "hi from model")
    assert.equal(body.apiKeySource, "hosted")

    // (8) credits debited from the ACCOUNT row.
    const after = store.loadSubscription(data.user.id, data.user.workspaceId)
    assert.ok(after.creditsUsed > 0, "credits debit from the account")
  })

  it("(6) a hosted AI route rejects a missing or invalid JWT (401)", async () => {
    env.NODE_ENV = "production"
    const missing = await chatPOST(
      jsonReq("http://localhost/api/hosted/chat", "POST", {
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    assert.equal(missing.status, 401)

    const bogus = _signHs256({ sub: "usr_x", workspaceId: "ws_x" }, "the-wrong-secret-0123456789")
    const invalid = await chatPOST(
      jsonReq(
        "http://localhost/api/hosted/chat",
        "POST",
        { intelligenceMode: "auto", messages: [{ role: "user", content: "hi" }] },
        bogus,
      ),
    )
    assert.equal(invalid.status, 401)
  })

  // (7) --------------------------------------------------------------------
  it("(7) billing checkout attaches to the account userId/workspaceId", async () => {
    env.BILLING_MOCK = "1"
    const { data } = await registerUser("billing@edge.test", "password12345")

    const res = await devCheckoutPOST(
      jsonReq("http://localhost/api/billing/dev-checkout", "POST", { tier: "pro" }, data.token),
    )
    assert.equal(res.status, 200)
    const out = (await res.json()) as { ok: boolean; tier: string; email: string | null }
    assert.equal(out.ok, true)
    assert.equal(out.tier, "pro")
    assert.equal(out.email, "billing@edge.test")

    // The upgraded subscription is keyed to the ACCOUNT ids, not a GitHub id.
    const store = new FileBillingStore()
    const sub = store.loadSubscription(data.user.id, data.user.workspaceId)
    assert.equal(sub.planTier, "pro")
    assert.ok(!data.user.id.startsWith("github:"), "billing identity is the account, not GitHub")
  })

  // (9) --------------------------------------------------------------------
  it("(9) GitHub linking is optional and does not change identity", async () => {
    const { data } = await registerUser("link@edge.test", "password12345")
    await ensureUserBootstrap()
    const users = getAsyncUserStore()

    // No links by default — the account works without GitHub.
    assert.deepEqual(await users.getLinkedAccounts(data.user.id), [])

    // Linking attaches a row but leaves the account identity untouched.
    const link = await users.linkAccount({
      userId: data.user.id,
      provider: "github",
      providerUserId: "583231",
      tokenRef: "server-side-ref",
    })
    assert.equal(link.provider, "github")
    const links = await users.getLinkedAccounts(data.user.id)
    assert.equal(links.length, 1)

    const session = assertSession(jsonReq("http://localhost/api/plan", "GET", undefined, data.token))
    assert.equal(session.userId, data.user.id, "identity unchanged after linking GitHub")
  })

  // (10) -------------------------------------------------------------------
  it("(10) a stored GitHub login is NOT a subscription identity by default", async () => {
    // Persist a GitHub PAT on disk (as the in-app GitHub sign-in would).
    storeAuth({ token: "ghp_stored_pat_value", login: "octocat", kind: "pat" })

    // Default: GitHub is not an identity → no session without a JWT.
    delete env.EDGE_AGENT_GITHUB_SESSION
    assert.equal(getOptionalSession(jsonReq("http://localhost/api/plan", "GET")), null)
    assert.throws(
      () => assertSession(jsonReq("http://localhost/api/plan", "GET")),
      AuthRequiredError,
    )

    // Opt-in legacy flag re-enables it (proving the default is OFF).
    env.EDGE_AGENT_GITHUB_SESSION = "1"
    const legacy = getOptionalSession(jsonReq("http://localhost/api/plan", "GET"))
    assert.ok(legacy, "opt-in flag restores the legacy GitHub session")
    assert.equal(legacy!.userId, "github:octocat")
    assert.equal(legacy!.authSource, "github_local")
  })

  // (11) + (12) + (13) -----------------------------------------------------
  it("(11/12/13) no PAT, password hash, provider key, or BYOK field leaks to the client", async () => {
    env.OPENAI_API_KEY = "sk-openai-must-not-leak"
    env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak"
    storeAuth({ token: "ghp_super_secret_pat", login: "octocat", kind: "pat" })

    // Register sends a BYOK-style apiKey field; it must be ignored, never echoed.
    const res = await registerPOST(
      jsonReq("https://cloud.test/api/auth/register", "POST", {
        email: "secure@edge.test",
        password: "password12345",
        apiKey: "sk-byok-attempt",
        baseUrl: "https://evil.example",
      }),
    )
    assert.equal(res.status, 201)
    const data = (await res.json()) as AccountResponse
    const registerRaw = JSON.stringify(data)

    const me = await meGET(jsonReq("https://cloud.test/api/auth/me", "GET", undefined, data.token))
    const meRaw = JSON.stringify(await me.json())

    const payload = decodePayload(data.token)
    const banned = [
      "sk-openai-must-not-leak",
      "sk-ant-must-not-leak",
      "ghp_super_secret_pat",
      "sk-byok-attempt",
    ]
    for (const raw of [registerRaw, meRaw]) {
      for (const s of banned) assert.ok(!raw.includes(s), `client payload must not contain ${s}`)
      assert.ok(!raw.includes("passwordHash"), "password hash must never reach the client")
      assert.ok(!raw.includes("scrypt$"), "no scrypt hash in client payloads")
      assert.ok(!raw.includes("apiKey"), "no apiKey field in client payloads")
      assert.ok(!raw.includes("baseUrl"), "no baseUrl field in client payloads")
    }
    for (const k of ["apiKey", "baseUrl", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "password", "passwordHash"]) {
      assert.ok(!(k in payload), `JWT payload must not contain '${k}'`)
    }
  })

  // logout ------------------------------------------------------------------
  it("logout clears the session cookie", async () => {
    const res = await logoutPOST(jsonReq("https://cloud.test/api/auth/logout", "POST", {}))
    assert.equal(res.status, 200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    assert.match(setCookie, /__edge_session=/)
    assert.match(setCookie, /Max-Age=0/)
  })
})
