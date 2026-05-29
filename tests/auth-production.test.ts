/**
 * Auth — production hardening.
 *
 *   1. Production without valid session returns 401.
 *   2. Dev stub works only when EDGE_AGENT_DEV_AUTH=1 and NOT production.
 *   3. Production never returns local-user/local-workspace.
 *   4. Billing checkout requires auth.
 *   5. Hosted AI routes require auth before model call.
 *
 * Run: node --import tsx --test tests/auth-production.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  AuthRequiredError,
  assertSession,
  getOptionalSession,
  _signHs256,
} from "../lib/server-auth"
import { POST as checkoutPOST } from "../app/api/billing/checkout/route"
import { POST as chatPOST } from "../app/api/hosted/chat/route"

const ORIG = { ...process.env }
const env = process.env as Record<string, string | undefined>
function reset() {
  // Mutate process.env IN PLACE — Next/Node modules cache the env
  // reference; reassigning process.env decouples our writes.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG)) {
    env[k] = v
  }
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.EDGE_AGENT_AUTH_BEARER
  delete env.JWT_SECRET
  delete env.EDGE_AGENT_JWT_SECRET
  delete env.NODE_ENV
  // Isolate from the host's GitHub auth file. Without this, the
  // dev's locally stored token would satisfy `resolveSessionFromGithub`
  // and bypass the JWT-only path the production tests assert.
  env.EDGE_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-auth-"))
}

function reqWithAuth(token: string): Request {
  return new Request("http://localhost/x", {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("auth — production hardening", () => {
  beforeEach(reset)
  afterEach(reset)

  it("(1) Production without valid session returns 401", () => {
    env.NODE_ENV = "production"
    assert.throws(() => assertSession(null), AuthRequiredError)
  })

  it("(2) Dev stub disabled in production even with EDGE_AGENT_DEV_AUTH=1", () => {
    env.NODE_ENV = "production"
    env.EDGE_AGENT_DEV_AUTH = "1"
    assert.equal(getOptionalSession(null), null)
    assert.throws(() => assertSession(null), AuthRequiredError)
  })

  it("(2b) Dev stub works outside production", () => {
    env.NODE_ENV = "development"
    env.EDGE_AGENT_DEV_AUTH = "1"
    const s = assertSession(null)
    assert.equal(s.userId, "local-user")
  })

  it("(3) Production never returns local-user/local-workspace", () => {
    env.NODE_ENV = "production"
    env.EDGE_AGENT_DEV_AUTH = "1"
    env.EDGE_AGENT_AUTH_BEARER = "tok-prod-xyz"
    const sNoReq = getOptionalSession(null)
    assert.equal(sNoReq, null, "no session for null req in production")
    // Bearer dev should be inert in production too.
    const sBearer = getOptionalSession(reqWithAuth("tok-prod-xyz"))
    assert.equal(sBearer, null, "bearer-dev path disabled in production")
  })

  it("(3b) Production accepts a real HS256 JWT", () => {
    env.NODE_ENV = "production"
    env.JWT_SECRET = "x".repeat(32)
    const tok = _signHs256(
      { sub: "user-1", workspaceId: "ws-1", email: "u@example.com" },
      env.JWT_SECRET,
    )
    const s = assertSession(reqWithAuth(tok))
    assert.equal(s.userId, "user-1")
    assert.equal(s.workspaceId, "ws-1")
    assert.equal(s.authSource, "jwt")
  })

  it("(3c) Production rejects a JWT signed with the wrong secret", () => {
    env.NODE_ENV = "production"
    env.JWT_SECRET = "x".repeat(32)
    const tok = _signHs256({ sub: "u" }, "y".repeat(32))
    assert.throws(() => assertSession(reqWithAuth(tok)), AuthRequiredError)
  })

  it("(3d) Cookie-based JWT also works", () => {
    env.NODE_ENV = "production"
    env.JWT_SECRET = "x".repeat(32)
    const tok = _signHs256({ sub: "cookie-user", workspaceId: "w" }, env.JWT_SECRET)
    const req = new Request("http://localhost/x", {
      headers: { cookie: `__edge_session=${tok}; theme=dark` },
    })
    const s = assertSession(req)
    assert.equal(s.userId, "cookie-user")
    assert.equal(s.authSource, "cookie")
  })

  it("(4) Billing checkout requires auth → 401 anonymously", async () => {
    env.NODE_ENV = "production"
    const res = await checkoutPOST(
      new Request("http://localhost/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: "pro" }),
      }),
    )
    assert.equal(res.status, 401)
  })

  it("(5) Hosted AI routes require auth before model call → 401 anonymously", async () => {
    env.NODE_ENV = "production"
    const res = await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "auto",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    assert.equal(res.status, 401)
  })
})
