/**
 * Hosted-only security contract, v2.
 *
 *   21. No BYOK/API-key fields in the production UI surfaces.
 *   22. Hosted routes reject apiKey/baseUrl/providerKey/* fields.
 *   23. API responses never include apiKey/baseUrl.
 *   24. Audit logs never include provider keys.
 *   25. Plan-blocked Pro/Max does NOT call the model provider.
 *
 * Run: node --import tsx --test tests/hosted-security-v2.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { POST as chatPOST } from "../app/api/hosted/chat/route"
import { POST as explainPOST } from "../app/api/finding/explain/route"
import {
  FileBillingStore,
  PLAN_TIER_LIMITS,
  setBillingStore,
} from "../lib/server-billing-store"
import { setAsyncBillingStore } from "../lib/server-billing-bootstrap"
import { getAuditWriter } from "../lib/server-audit-log"

const ORIG_FETCH = global.fetch
const ORIG_ENV = { ...process.env }
const env = process.env as Record<string, string | undefined>

function fresh() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete env[k]
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    env[k] = v
  }
  env.EDGE_AGENT_DEV_AUTH = "1"
  delete env.NODE_ENV
  env.OPENAI_API_KEY = "sk-test-not-real-abcdef"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-sec2-"))
  process.env.EDGE_AGENT_HOME = dir
  const s = new FileBillingStore()
  s._resetForTests()
  setBillingStore(s)
  setAsyncBillingStore({
    loadSubscription: async (u, w) => s.loadSubscription(u, w),
    upsertSubscription: async (u, w, p) => s.upsertSubscription(u, w, p),
    consume: async (a) => s.consume(a),
    canConsume: async (u, w, c) => s.canConsume(u, w, c),
    recentUsage: async (u, w, l) => s.recentUsage(u, w, l),
    claimEvent: async (r) => s.claimEvent(r),
    hasProcessedEvent: async (id) => s.hasProcessedEvent(id),
    _resetForTests: async () => s._resetForTests(),
  })
  // Default the dev user to a free plan so the Pro/Max gate fires.
  s.upsertSubscription("local-user", "local-workspace", {
    planTier: "free",
    creditsLimit: PLAN_TIER_LIMITS.free.creditsLimit,
  })
  getAuditWriter()._resetForTests()
  return s
}

describe("hosted security v2", () => {
  beforeEach(fresh)
  afterEach(() => {
    global.fetch = ORIG_FETCH
  })

  it("(21) Settings page source has no API-key form fields", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "components/views/settings.tsx"),
      "utf8",
    )
    // Look for the most common provider-key UI affordances.
    assert.ok(!/<Input[^>]*type="password"/.test(src), "password Input fields suggest API-key UI")
    assert.ok(!/OPENAI_API_KEY/i.test(src), "Settings must not surface env-var names to users")
    assert.ok(!/Bring your own key|Use my own key/i.test(src))
  })

  it("(22) /api/hosted/chat rejects apiKey body field with 400", async () => {
    const res = await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "auto",
          messages: [{ role: "user", content: "hi" }],
          apiKey: "sk-evil",
        }),
      }),
    )
    assert.equal(res.status, 400)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "byok_not_supported")
  })

  it("(22b) /api/hosted/chat rejects baseUrl and providerKey too", async () => {
    for (const field of ["baseUrl", "providerKey", "openaiApiKey", "anthropicApiKey", "geminiApiKey"]) {
      const res = await chatPOST(
        new Request("http://localhost/api/hosted/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intelligenceMode: "auto",
            messages: [{ role: "user", content: "hi" }],
            [field]: "evil",
          }),
        }),
      )
      assert.equal(res.status, 400, `${field} must be rejected`)
    }
  })

  it("(23) Hosted chat success response never includes apiKey/baseUrl", async () => {
    // Upgrade dev user to pro so the call goes through.
    const s = new FileBillingStore()
    s.upsertSubscription("local-user", "local-workspace", {
      planTier: "pro",
      creditsLimit: PLAN_TIER_LIMITS.pro.creditsLimit,
    })
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", role: "assistant" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch
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
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.ok(!("apiKey" in body), "response must not include apiKey")
    assert.ok(!("baseUrl" in body), "response must not include baseUrl")
    assert.ok(!("provider_key" in body))
    assert.equal(body.apiKeySource, "hosted")
  })

  it("(24) Audit log never serializes apiKey or raw prompts", async () => {
    const s = new FileBillingStore()
    s.upsertSubscription("local-user", "local-workspace", {
      planTier: "pro",
      creditsLimit: PLAN_TIER_LIMITS.pro.creditsLimit,
    })
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok", role: "assistant" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch
    await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "auto",
          messages: [{ role: "user", content: "very-distinctive-marker-string-12345" }],
        }),
      }),
    )
    const rows = getAuditWriter().recent(50)
    for (const r of rows) {
      const blob = JSON.stringify(r)
      assert.ok(!("apiKey" in r), "no apiKey column on audit rows")
      assert.ok(
        !/very-distinctive-marker-string-12345/.test(blob),
        "raw user prompt must not appear in audit rows",
      )
      assert.ok(!/sk-test-not-real/.test(blob), "API key must never reach audit rows")
    }
  })

  it("(25) Plan-blocked PRO mode never reaches the upstream provider", async () => {
    let upstreamCalls = 0
    global.fetch = (async () => {
      upstreamCalls += 1
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    const res = await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "pro",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    assert.equal(res.status, 402, "blocked Pro mode must return 402")
    assert.equal(upstreamCalls, 0, "provider must not be called for blocked plan")
  })

  it("(25b) Plan-blocked MAX mode never reaches the upstream provider", async () => {
    let upstreamCalls = 0
    global.fetch = (async () => {
      upstreamCalls += 1
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    const res = await chatPOST(
      new Request("http://localhost/api/hosted/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intelligenceMode: "max",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    assert.equal(res.status, 402)
    assert.equal(upstreamCalls, 0)
  })

  it("/api/finding/explain also rejects BYOK fields", async () => {
    const res = await explainPOST(
      new Request("http://localhost/api/finding/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectPath: "/tmp/nope",
          finding: { id: "x", rule_id: "x", category: "x", severity: "low", title: "x" },
          apiKey: "sk-evil",
        }),
      }),
    )
    assert.equal(res.status, 400)
  })
})
