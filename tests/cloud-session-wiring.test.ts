/**
 * Cloud session wiring (Bearer attach + 401 handling + optional GitHub bridge).
 *
 * Identity model: the Edge Agent AI account is the identity of record. The
 * GitHub bridge (establishCloudSession / remintCloudSession) is an OPTIONAL
 * integration. apiFetch no longer auto-remints on 401 — re-mint is pluggable
 * via setSessionReminter and OFF by default, so a 401 prompts an account login.
 *
 * Required coverage:
 *   - the GitHub bridge mints + stores a session token (establishCloudSession).
 *   - the cloud token is attached as a Bearer on cloud requests.
 *   - a 401 with NO reminter goes straight to "login required" (no retry).
 *   - a 401 WITH a registered reminter triggers ONE re-mint + retry.
 *   - a failed re-mint surfaces "login required" (and does not retry).
 *   - logout clears the cloud token.
 *   - the GitHub PAT never reaches the renderer (only the session JWT does).
 *   - no provider key appears in the token, request, or response.
 *
 * Run: node --import tsx --test tests/cloud-session-wiring.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  apiFetch,
  setCloudAuthToken,
  getCloudAuthToken,
  setCloudRefreshToken,
  getCloudRefreshToken,
  setOnLoginRequired,
  setSessionReminter,
  remintCloudSession,
} from "../lib/api-fetch"
import { establishCloudSession, clearCloudSession } from "../lib/plan-client"
import { issueSessionToken } from "../lib/server-auth"

const CLOUD_BASE = "https://cloud.product.test"
const SECRET = "wiring-test-jwt-secret-0123456789"
const env = process.env as Record<string, string | undefined>
const ORIG_FETCH = global.fetch

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function isBridge(url: unknown): boolean {
  return String(url).includes("/api/desktop/cloud-session")
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1]
  const pad = "=".repeat((4 - (part.length % 4)) % 4)
  return JSON.parse(
    Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"),
  ) as Record<string, unknown>
}

/** A realistic session JWT (identity claims only) as the bridge would return. */
function mintToken(userId = "github:42"): string {
  const issued = issueSessionToken({ userId, workspaceId: userId, email: "u@gh.test", role: "owner" })
  if (!issued) throw new Error("could not mint test token")
  return issued.token
}

describe("desktop GitHub sign-in → cloud session wiring", () => {
  beforeEach(() => {
    env.NEXT_PUBLIC_CLOUD_API_BASE = CLOUD_BASE
    env.JWT_SECRET = SECRET
    setCloudAuthToken(null)
    setCloudRefreshToken(null)
    setOnLoginRequired(null)
    setSessionReminter(null)
  })
  afterEach(() => {
    global.fetch = ORIG_FETCH
    setCloudAuthToken(null)
    setCloudRefreshToken(null)
    setOnLoginRequired(null)
    setSessionReminter(null)
    delete env.NEXT_PUBLIC_CLOUD_API_BASE
    delete env.JWT_SECRET
    delete env.OPENAI_API_KEY
    delete env.ANTHROPIC_API_KEY
  })

  // ---------------------------------------------------------------------- //
  it("GitHub login mints + stores a cloud session token", async () => {
    const token = mintToken()
    let bridgeCalls = 0
    global.fetch = (async (url: unknown) => {
      if (isBridge(url)) {
        bridgeCalls++
        return json(
          { ok: true, token, user: { userId: "github:42", login: "octocat", email: "u@gh.test" } },
          200,
        )
      }
      return json({}, 200)
    }) as typeof fetch

    const result = await establishCloudSession()
    assert.equal(bridgeCalls, 1)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.user.login, "octocat")
    assert.equal(getCloudAuthToken(), token, "session token is stored")
  })

  // ---------------------------------------------------------------------- //
  it("attaches the cloud token as Bearer on cloud requests", async () => {
    setCloudAuthToken("session-token-xyz")
    const seen: Array<{ url: string; auth: string | null }> = []
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return json({ ok: true }, 200)
    }) as typeof fetch

    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, `${CLOUD_BASE}/api/plan`)
    assert.equal(seen[0].auth, "Bearer session-token-xyz")
  })

  // ---------------------------------------------------------------------- //
  it("a 401 with NO reminter goes straight to 'login required' (no retry, no bridge)", async () => {
    let cloudCalls = 0
    let bridgeCalls = 0
    let loginRequired = 0
    setOnLoginRequired(() => {
      loginRequired++
    })
    global.fetch = (async (url: unknown) => {
      if (isBridge(url)) {
        bridgeCalls++
        return json({ ok: true, token: mintToken(), user: { userId: "github:42", login: "octocat", email: null } }, 200)
      }
      cloudCalls++
      return json({ error: "not_authenticated", code: "not_authenticated" }, 401)
    }) as typeof fetch

    setCloudAuthToken("stale-token")
    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 401, "final response is the unchanged 401")
    assert.equal(cloudCalls, 1, "no silent retry in the default account model")
    assert.equal(bridgeCalls, 0, "GitHub bridge is NOT auto-invoked on 401")
    assert.equal(loginRequired, 1, "login-required handler fired once")
  })

  // ---------------------------------------------------------------------- //
  it("a 401 WITH a registered reminter triggers ONE re-mint and retry", async () => {
    const fresh = mintToken()
    let cloudCalls = 0
    let bridgeCalls = 0
    let retryAuth: string | null = null
    // Opt in to the pluggable non-interactive re-mint (uses the GitHub bridge).
    setSessionReminter(remintCloudSession)
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      if (isBridge(url)) {
        bridgeCalls++
        return json({ ok: true, token: fresh, user: { userId: "github:42", login: "octocat", email: null } }, 200)
      }
      cloudCalls++
      if (cloudCalls === 1) return json({ error: "not_authenticated", code: "not_authenticated" }, 401)
      retryAuth = new Headers(init?.headers).get("authorization")
      return json({ ok: true }, 200)
    }) as typeof fetch

    setCloudAuthToken("stale-token")
    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 200, "retry succeeds")
    assert.equal(cloudCalls, 2, "cloud called exactly twice (original + one retry)")
    assert.equal(bridgeCalls, 1, "re-mint attempted exactly once")
    assert.equal(getCloudAuthToken(), fresh, "fresh token stored")
    assert.equal(retryAuth, `Bearer ${fresh}`, "retry carries the fresh token")
  })

  // ---------------------------------------------------------------------- //
  it("a failed re-mint surfaces 'login required' and does not retry", async () => {
    let cloudCalls = 0
    let bridgeCalls = 0
    let loginRequired = 0
    setOnLoginRequired(() => {
      loginRequired++
    })
    setSessionReminter(remintCloudSession)
    global.fetch = (async (url: unknown) => {
      if (isBridge(url)) {
        bridgeCalls++
        return json({ ok: false, code: "github_login_required", error: "Sign in with GitHub first." }, 401)
      }
      cloudCalls++
      return json({ error: "not_authenticated" }, 401)
    }) as typeof fetch

    setCloudAuthToken("stale-token")
    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 401, "final response is the unchanged 401")
    assert.equal(cloudCalls, 1, "no retry when re-mint fails")
    assert.equal(bridgeCalls, 1, "exactly one re-mint attempt")
    assert.equal(loginRequired, 1, "login-required handler fired once")
  })

  // ---------------------------------------------------------------------- //
  it("(9) apiFetch refreshes once on 401 (account refresh-token) and retries once", async () => {
    // No custom reminter → the built-in account refresh flow is used.
    setCloudAuthToken("stale-access")
    setCloudRefreshToken("refresh-1")
    let cloudCalls = 0
    let refreshCalls = 0
    let retryAuth: string | null = null
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (u.includes("/api/auth/refresh")) {
        refreshCalls++
        return json({ ok: true, token: "fresh-access", refreshToken: "refresh-2" }, 200)
      }
      cloudCalls++
      if (cloudCalls === 1) return json({ code: "not_authenticated" }, 401)
      retryAuth = new Headers(init?.headers).get("authorization")
      return json({ ok: true }, 200)
    }) as typeof fetch

    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 200, "retry succeeds after refresh")
    assert.equal(cloudCalls, 2, "cloud called exactly twice (original + one retry)")
    assert.equal(refreshCalls, 1, "account refresh attempted exactly once")
    assert.equal(getCloudAuthToken(), "fresh-access", "new access token stored")
    assert.equal(getCloudRefreshToken(), "refresh-2", "refresh token rotated + stored")
    assert.equal(retryAuth, "Bearer fresh-access", "retry carries the refreshed token")

    // GitHub is NEVER used in this path — the bridge route is not touched.
  })

  it("(9b) a 401 with no refresh token goes straight to login required (no GitHub)", async () => {
    let cloudCalls = 0
    let bridgeCalls = 0
    let loginRequired = 0
    setOnLoginRequired(() => {
      loginRequired++
    })
    setCloudAuthToken("stale-access")
    setCloudRefreshToken(null)
    global.fetch = (async (url: unknown) => {
      if (isBridge(url)) bridgeCalls++
      cloudCalls++
      return json({ code: "not_authenticated" }, 401)
    }) as typeof fetch

    const res = await apiFetch("/api/plan")
    assert.equal(res.status, 401)
    assert.equal(cloudCalls, 1, "no retry without a refresh token")
    assert.equal(bridgeCalls, 0, "GitHub bridge is never auto-invoked")
    assert.equal(loginRequired, 1, "login-required handler fired once")
  })

  // ---------------------------------------------------------------------- //
  it("logout clears the cloud token", () => {
    setCloudAuthToken("some-token")
    assert.equal(getCloudAuthToken(), "some-token")
    clearCloudSession()
    assert.equal(getCloudAuthToken(), null)
  })

  // ---------------------------------------------------------------------- //
  it("the GitHub PAT never reaches the renderer", async () => {
    const PAT = "ghp_super_secret_pat_value"
    const token = mintToken()
    global.fetch = (async (url: unknown) => {
      if (isBridge(url)) {
        // The bridge returns ONLY the session token + public user info; the
        // GitHub PAT stays server-side and is never in this payload.
        return json(
          { ok: true, token, user: { userId: "github:42", login: "octocat", email: "u@gh.test" } },
          200,
        )
      }
      return json({}, 200)
    }) as typeof fetch

    const result = await establishCloudSession()
    assert.equal(result.ok, true)
    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes(PAT), "establishCloudSession result must not contain the PAT")
    assert.ok(!serialized.includes("ghp_"), "no GitHub PAT prefix in the renderer-visible result")
    const stored = getCloudAuthToken()
    assert.notEqual(stored, PAT, "stored value is the session JWT, not the PAT")
    assert.equal(stored, token)
  })

  // ---------------------------------------------------------------------- //
  it("no provider key appears in the token, request, or response", async () => {
    // Provider keys present in the (server) env must NOT leak anywhere client-side.
    env.OPENAI_API_KEY = "sk-openai-must-not-leak"
    env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak"
    const token = mintToken()

    // (a) the minted token carries identity claims only.
    const payload = decodePayload(token)
    for (const k of ["apiKey", "baseUrl", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "openaiApiKey", "anthropicApiKey"]) {
      assert.ok(!(k in payload), `token payload must not contain '${k}'`)
    }

    // (b) the cloud request carries only a Bearer header — never a key.
    setCloudAuthToken(token)
    let reqHeaders = new Headers()
    let reqBody: string | null = null
    global.fetch = (async (_url: unknown, init?: RequestInit) => {
      reqHeaders = new Headers(init?.headers)
      reqBody = init?.body == null ? null : String(init.body)
      return json({ reply: "ok", apiKeySource: "hosted" }, 200)
    }) as typeof fetch

    const res = await apiFetch("/api/hosted/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    assert.equal(reqHeaders.get("authorization"), `Bearer ${token}`)
    for (const banned of ["sk-openai-must-not-leak", "sk-ant-must-not-leak"]) {
      for (const [, v] of reqHeaders.entries()) assert.ok(!v.includes(banned), "no key in request headers")
      assert.ok(!(reqBody ?? "").includes(banned), "no key in request body")
    }

    // (c) the response the client reads carries no provider key either.
    const body = (await res.json()) as Record<string, unknown>
    assert.ok(!("apiKey" in body) && !("baseUrl" in body), "response must not echo a key")
  })
})
