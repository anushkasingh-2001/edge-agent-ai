/**
 * /api/hosted/chat — guard + auth + audit + credit contract.
 *
 *   - 401 on anonymous calls.
 *   - 400 when the body contains BYOK-era fields.
 *   - With dev-auth + a hosted key, a stubbed upstream returns a reply,
 *     credits are debited, and an audit row is closed.
 *   - Response payload NEVER contains `apiKey`.
 *
 * Run: node --import tsx --test tests/hosted-chat-route.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { POST as chatPOST } from "../app/api/hosted/chat/route"
import { FileBillingStore, setBillingStore, PLAN_TIER_LIMITS } from "../lib/server-billing-store"
import { getAuditWriter } from "../lib/server-audit-log"

const ORIGINAL_FETCH = global.fetch

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-hosted-chat-"))
  process.env.EDGE_AGENT_HOME = dir
  process.env.EDGE_AGENT_DEV_AUTH = "1"
  process.env.OPENAI_API_KEY = "sk-test-only-not-real"
  const store = new FileBillingStore()
  setBillingStore(store)
  store._resetForTests()
  // Give the dev user enough credits to run pro/max in some tests.
  store.upsertSubscription("local-user", "local-workspace", {
    planTier: "team",
    creditsLimit: PLAN_TIER_LIMITS.team.creditsLimit,
    creditsUsed: 0,
  })
  getAuditWriter()._resetForTests()
  return store
}

function stubUpstreamOnce(replyText: string) {
  global.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: replyText, role: "assistant" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch
}

function req(body: object): Request {
  return new Request("http://localhost/api/hosted/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("/api/hosted/chat", () => {
  beforeEach(() => {
    fresh()
  })
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    delete process.env.EDGE_AGENT_DEV_AUTH
    delete process.env.OPENAI_API_KEY
  })

  it("returns 401 when no session is available", async () => {
    delete process.env.EDGE_AGENT_DEV_AUTH
    const res = await chatPOST(
      req({
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    assert.equal(res.status, 401)
  })

  it("rejects requests carrying apiKey / baseUrl with 400", async () => {
    const res = await chatPOST(
      req({
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "sk-anything",
      }),
    )
    assert.equal(res.status, 400)
    const body = (await res.json()) as { code?: string }
    assert.equal(body.code, "byok_not_supported")
  })

  it("happy path: returns reply, debits credits, never echoes apiKey", async () => {
    stubUpstreamOnce("Hello from the model.")
    const store = new FileBillingStore()
    const beforeUsed = store.loadSubscription("local-user", "local-workspace").creditsUsed
    const res = await chatPOST(
      req({
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "Say hi" }],
      }),
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.reply, "Hello from the model.")
    assert.equal(body.apiKeySource, "hosted")
    assert.ok(!("apiKey" in body), "response must not include apiKey")
    assert.ok(!("baseUrl" in body), "response must not include baseUrl")
    const afterUsed = new FileBillingStore().loadSubscription("local-user", "local-workspace").creditsUsed
    assert.ok(afterUsed > beforeUsed, "credits must be debited on success")
  })

  it("writes a success audit row tied to the resolver requestId", async () => {
    stubUpstreamOnce("ok")
    await chatPOST(
      req({
        intelligenceMode: "auto",
        messages: [{ role: "user", content: "ok?" }],
      }),
    )
    const rows = getAuditWriter().recent(50)
    const successes = rows.filter((r) => r.status === "success" && r.task === "explain")
    assert.ok(successes.length >= 1, "expected at least one success audit row")
    for (const r of rows) {
      assert.ok(!("apiKey" in r), "audit rows must not include apiKey")
    }
  })
})
