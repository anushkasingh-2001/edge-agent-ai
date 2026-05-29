/**
 * Production session/JWT issuance — desktop → cloud authentication.
 *
 * Required coverage:
 *   1. production dev-login is disabled (404).
 *   2. the real auth endpoint (/api/auth/session) issues a valid JWT after a
 *      verified GitHub identity.
 *   3. an expired / invalid JWT is rejected (401).
 *   4. desktop cloud calls (apiFetch) attach Authorization: Bearer <token>.
 *   5. a hosted AI route accepts a valid issued token.
 *   6. a hosted AI route rejects a missing token (401).
 *   7. the issued token NEVER contains a provider API key.
 *
 * Run: node --import tsx --test tests/cloud-auth.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  assertSession,
  getOptionalSession,
  issueSessionToken,
  _signHs256,
  AuthRequiredError,
} from "../lib/server-auth"
import { handleCloudSession } from "../lib/server-cloud-session"
import { apiFetch, setCloudAuthToken } from "../lib/api-fetch"
import { POST as devLoginPOST } from "../app/api/auth/dev-login/route"
import { POST as chatPOST } from "../app/api/hosted/chat/route"
import { FileBillingStore, setBillingStore, PLAN_TIER_LIMITS } from "../lib/server-billing-store"
import { _resetBillingBootstrapForTests } from "../lib/server-billing-bootstrap"
import { getAuditWriter } from "../lib/server-audit-log"

const SECRET = "unit-test-jwt-secret-0123456789"
const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>

function reset(): string {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) env[k] = v
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.EDGE_AGENT_AUTH_BEARER
  delete env.NODE_ENV
  delete env.JWT_ISSUER
  delete env.JWT_AUDIENCE
  delete env.NEXT_PUBLIC_CLOUD_API_BASE
  delete env.EDGE_AGENT_CLOUD_API_BASE
  delete env.DATABASE_URL
  delete env.BILLING_MOCK
  delete env.BILLING_STORE
  // satisfy the "no session" assertions.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-cloud-auth-"))
  env.EDGE_AGENT_HOME = home
  env.JWT_SECRET = SECRET
  setCloudAuthToken(null)
  return home
}

const ORIG_FETCH = global.fetch

/** Decode the JWT payload (middle segment) into a plain object. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1]
  const pad = "=".repeat((4 - (part.length % 4)) % 4)
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8")
  return JSON.parse(json) as Record<string, unknown>
}

function sessionReq(body: Record<string, unknown>): Request {
  return new Request("https://api.product.test/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function bearerReq(url: string, token: string, body?: object): Request {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe("production session/JWT issuance", () => {
  let home: string
  beforeEach(() => {
    home = reset()
  })
  afterEach(() => {
    global.fetch = ORIG_FETCH
    setCloudAuthToken(null)
    fs.rmSync(home, { recursive: true, force: true })
    reset()
  })

  // (1) -------------------------------------------------------------------
  it("(1) dev-login is disabled in production when BILLING_MOCK is off", async () => {
    env.NODE_ENV = "production"
    delete env.BILLING_MOCK
    const res = await devLoginPOST(
      new Request("http://localhost/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      }),
    )
    assert.equal(res.status, 404)
  })

  it("(1b) dev-login works in production when BILLING_MOCK=1", async () => {
    env.NODE_ENV = "production"
    env.BILLING_MOCK = "1"
    const res = await devLoginPOST(
      new Request("http://localhost/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "mock@edge.test" }),
      }),
    )
    assert.equal(res.status, 200)
    const data = (await res.json()) as { ok: boolean; email: string }
    assert.equal(data.ok, true)
    assert.equal(data.email, "mock@edge.test")
  })

  // (2) -------------------------------------------------------------------
  it("(2) /api/auth/session issues a valid JWT after GitHub verification", async () => {
    global.fetch = (async (url: unknown) => {
      assert.match(String(url), /api\.github\.com\/user/)
      return new Response(JSON.stringify({ login: "octocat", id: 583231, email: "octo@github.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const res = await handleCloudSession(sessionReq({ provider: "github", token: "ghp_validtoken_xxx" }))
    assert.equal(res.status, 200)
    const data = (await res.json()) as {
      ok: boolean
      token: string
      expiresAt: number
      user: { userId: string; login: string; email: string | null }
    }
    assert.equal(data.ok, true)
    assert.ok(data.token, "a token is returned")
    assert.equal(data.user.userId, "github:583231")
    assert.equal(data.user.login, "octocat")
    assert.equal(data.user.email, "octo@github.test")
    assert.ok(data.expiresAt > Math.floor(Date.now() / 1000), "expiry in the future")

    // The minted token must verify and carry the expected identity claims.
    const session = assertSession(bearerReq("http://localhost/api/plan", data.token))
    assert.equal(session.userId, "github:583231")
    assert.equal(session.workspaceId, "github:583231")
    assert.equal(session.email, "octo@github.test")
    assert.equal(session.role, "owner")
    assert.equal(session.authSource, "jwt")
  })

  it("(2b) /api/auth/session rejects a GitHub token GitHub refuses (401)", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const res = await handleCloudSession(sessionReq({ provider: "github", token: "ghp_bad" }))
    assert.equal(res.status, 401)
    const data = (await res.json()) as { ok: boolean; code: string }
    assert.equal(data.ok, false)
    assert.equal(data.code, "invalid_token")
  })

  it("(2c) /api/auth/session 503s when JWT_SECRET is not configured", async () => {
    delete env.JWT_SECRET
    delete env.EDGE_AGENT_JWT_SECRET
    global.fetch = (async () =>
      new Response(JSON.stringify({ login: "octocat", id: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const res = await handleCloudSession(sessionReq({ provider: "github", token: "ghp_ok" }))
    assert.equal(res.status, 503)
    const data = (await res.json()) as { code: string }
    assert.equal(data.code, "server_misconfigured")
  })

  // (3) -------------------------------------------------------------------
  it("(3) an expired JWT is rejected", () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const expired = _signHs256({ sub: "u1", workspaceId: "w1", iat: past - 3600, exp: past }, SECRET)
    assert.equal(getOptionalSession(bearerReq("http://localhost/x", expired)), null)
    assert.throws(() => assertSession(bearerReq("http://localhost/x", expired)), AuthRequiredError)
  })

  it("(3b) a JWT signed with the wrong secret is rejected", () => {
    const tok = _signHs256({ sub: "u1", workspaceId: "w1" }, "the-wrong-secret-0123456789")
    assert.equal(getOptionalSession(bearerReq("http://localhost/x", tok)), null)
  })

  // (4) -------------------------------------------------------------------
  it("(4) apiFetch attaches Authorization: Bearer on cloud calls", async () => {
    env.NEXT_PUBLIC_CLOUD_API_BASE = "https://cloud.product.test"
    setCloudAuthToken("session-token-abc")
    const captured: Array<{ url: string; auth: string | null }> = []
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      captured.push({ url: String(url), auth: headers.get("authorization") })
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    await apiFetch("/api/plan")
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, "https://cloud.product.test/api/plan")
    assert.equal(captured[0].auth, "Bearer session-token-abc")
  })

  // (5) + (6) -------------------------------------------------------------
  it("(5) a hosted AI route accepts a valid issued token", async () => {
    // Real billing store + hosted key, model upstream stubbed.
    env.OPENAI_API_KEY = "sk-server-side-key-never-leaks"
    await _resetBillingBootstrapForTests()
    const store = new FileBillingStore()
    setBillingStore(store)
    store._resetForTests()
    store.upsertSubscription("github:42", "github:42", {
      planTier: "team",
      creditsLimit: PLAN_TIER_LIMITS.team.creditsLimit,
      creditsUsed: 0,
    })
    getAuditWriter()._resetForTests()
    global.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi from model", role: "assistant" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch

    const issued = issueSessionToken({ userId: "github:42", workspaceId: "github:42", role: "owner" })
    if (!issued) assert.fail("expected a token to be issued")
    const res = await chatPOST(
      bearerReq("http://localhost/api/hosted/chat", issued.token, {
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "say hi" }],
      }),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.reply, "hi from model")
    assert.equal(body.apiKeySource, "hosted")
    assert.ok(!("apiKey" in body), "response must not include apiKey")
    assert.ok(!("baseUrl" in body), "response must not include baseUrl")
  })

  it("(6) a hosted AI route rejects a missing token (401)", async () => {
    env.NODE_ENV = "production"
    const res = await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intelligenceMode: "auto", messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    assert.equal(res.status, 401)
  })

  // (7) -------------------------------------------------------------------
  it("(7) the issued token never contains a provider API key", async () => {
    // Set provider keys in the env to prove they are NOT copied into the JWT.
    env.OPENAI_API_KEY = "sk-openai-must-not-leak"
    env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak"
    env.GEMINI_API_KEY = "gm-must-not-leak"
    global.fetch = (async () =>
      new Response(JSON.stringify({ login: "octocat", id: 7, email: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch

    const res = await handleCloudSession(sessionReq({ provider: "github", token: "ghp_ok" }))
    assert.equal(res.status, 200)
    const data = (await res.json()) as { token: string }
    const payload = decodeJwtPayload(data.token)

    const banned = [
      "apiKey",
      "baseUrl",
      "providerKey",
      "openaiApiKey",
      "anthropicApiKey",
      "geminiApiKey",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
    ]
    for (const k of banned) {
      assert.ok(!(k in payload), `JWT payload must not contain '${k}'`)
    }
    // And no value in the payload should equal any configured provider key.
    const secrets = ["sk-openai-must-not-leak", "sk-ant-must-not-leak", "gm-must-not-leak"]
    for (const v of Object.values(payload)) {
      if (typeof v === "string") {
        for (const s of secrets) assert.notEqual(v, s, "no provider key value may appear in the token")
      }
    }

    // The HTTP response body must not leak keys either.
    const raw = JSON.stringify(data)
    for (const s of secrets) assert.ok(!raw.includes(s), "response body must not contain a provider key")
  })
})
