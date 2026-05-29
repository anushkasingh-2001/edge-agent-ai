/**
 * server-auth: dev stub vs. real session.
 *
 * The auth seam is the single place every hosted AI route goes through.
 * Anonymous calls must be rejected, the dev stub must work for local
 * development, and a real session header must take precedence over the
 * stub when both are present.
 *
 * Run: node --import tsx --test tests/server-auth.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  assertSession,
  getOptionalSession,
  AuthRequiredError,
} from "../lib/server-auth"

const ORIGINAL_ENV = { ...process.env }
const env = process.env as Record<string, string | undefined>

function reset() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    env[k] = v
  }
  delete env.EDGE_AGENT_DEV_AUTH
  delete env.EDGE_AGENT_LOCAL_USER_ID
  delete env.EDGE_AGENT_LOCAL_WORKSPACE_ID
  delete env.EDGE_AGENT_AUTH_BEARER
  // Isolate from the developer's locally stored GitHub auth so the
  // GitHub-login resolver doesn't satisfy these "anonymous"/"dev
  // stub"/"bearer" scenarios.
  env.EDGE_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-auth-"))
}

function makeReq(headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { headers })
}

describe("server-auth", () => {
  beforeEach(reset)
  afterEach(reset)

  it("rejects anonymous calls when no auth source is configured", () => {
    delete env.EDGE_AGENT_DEV_AUTH
    assert.equal(getOptionalSession(null), null)
    assert.throws(() => assertSession(null), AuthRequiredError)
  })

  it("dev stub returns a deterministic session when EDGE_AGENT_DEV_AUTH=1", () => {
    env.EDGE_AGENT_DEV_AUTH = "1"
    const s = assertSession(null)
    assert.equal(s.userId, "local-user")
    assert.equal(s.workspaceId, "local-workspace")
    assert.equal(s.authSource, "dev_stub")
  })

  it("custom dev userId/workspaceId override the defaults", () => {
    env.EDGE_AGENT_DEV_AUTH = "1"
    env.EDGE_AGENT_LOCAL_USER_ID = "alice"
    env.EDGE_AGENT_LOCAL_WORKSPACE_ID = "ws-alpha"
    const s = assertSession(null)
    assert.equal(s.userId, "alice")
    assert.equal(s.workspaceId, "ws-alpha")
  })

  it("bearer token resolves to a session and beats the dev stub", () => {
    env.EDGE_AGENT_DEV_AUTH = "1"
    env.EDGE_AGENT_AUTH_BEARER = "tok_test_user_123"
    const s = assertSession(makeReq({ Authorization: "Bearer tok_test_user_123" }))
    assert.notEqual(s.authSource, "dev_stub")
    assert.ok(s.userId)
    assert.ok(s.workspaceId)
  })

  it("session never leaks provider credentials", () => {
    env.EDGE_AGENT_DEV_AUTH = "1"
    const s = assertSession(null)
    assert.ok(!("apiKey" in s), "session must not contain apiKey")
    assert.ok(!("baseUrl" in s), "session must not contain baseUrl")
    assert.ok(!("openaiApiKey" in s), "session must not contain openaiApiKey")
  })
})
