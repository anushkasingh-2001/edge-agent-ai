/**
 * Desktop/cloud split for AI fix GENERATION.
 *
 * Verifies the contract:
 *   1.  fix/patch APPLY routes stay local (classifyApiRoute).
 *   2.  the local patch generation gateway calls the cloud endpoint.
 *   3.  the cloud generation endpoint uses the hosted resolver.
 *   4.  the cloud endpoint rejects apiKey/baseUrl fields (400).
 *   6.  the patch is applied only locally (applyPatch + .bak), never cloud.
 *   7.  the cloud receives prompt text only — never a local file path/key.
 *   8.  quota exceeded blocks BEFORE the provider/model call.
 *   9.  credits are debited only after a successful cloud generation.
 *  10.  re-scan runs locally after apply (pipeline owns the rescan seam).
 *  11.  no provider key appears in the request, response, or transport body.
 *
 * (5 — desktop env stripping — is covered by tests/desktop-cloud-split.test.ts.)
 *
 * Run: node --import tsx --test tests/cloud-fix-generation.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { handleCloudGenerate } from "../lib/server-cloud-generate"
import {
  setAsyncBillingStore,
  _resetBillingBootstrapForTests,
  type AsyncBillingStore,
} from "../lib/server-billing-bootstrap"
import type { SubscriptionRecord, CreditUsageRecord } from "../lib/server-billing-store"
import { _setFetcherForTests } from "../lib/server-llm-client"
import { _setRunScannerForTests, generatePatchPreview, applyPatch, type PatchPreview } from "../lib/server-patch-pipeline"
import { makeCloudCompletionFn } from "../lib/server-completion-transport"
import {
  generateFindingPatch,
  cloudGenerationActive,
  bearerFromRequest,
} from "../lib/server-patch-generation-gateway"
import { classifyApiRoute, forwardsGenerationToCloud } from "../lib/api-fetch"
import { _signHs256 } from "../lib/server-auth"
import { planFix, type PlannerFinding } from "../lib/fix-planner"
import type { ScanReportLite } from "../lib/server-scan"

const JWT_SECRET = "unit-test-secret-key-0123456789"

// ------------------------------------------------------------------ //
// In-memory billing store                                            //
// ------------------------------------------------------------------ //

function nowIso(): string {
  return new Date().toISOString()
}

function makeRecord(userId: string, workspaceId: string, over: Partial<SubscriptionRecord>): SubscriptionRecord {
  return {
    userId,
    workspaceId,
    planTier: "pro",
    creditsLimit: 50,
    creditsUsed: 0,
    billingPeriodStart: nowIso(),
    billingPeriodEnd: nowIso(),
    subscriptionStatus: "active",
    updatedAt: nowIso(),
    ...over,
  }
}

interface MemStore extends AsyncBillingStore {
  _subs: Map<string, SubscriptionRecord>
  _usage: CreditUsageRecord[]
}

function memStore(seed: SubscriptionRecord[]): MemStore {
  const subs = new Map<string, SubscriptionRecord>()
  const usage: CreditUsageRecord[] = []
  const key = (u: string, w: string) => `${u}::${w}`
  for (const s of seed) subs.set(key(s.userId, s.workspaceId), s)
  const fallback = (u: string, w: string) => makeRecord(u, w, { planTier: "free", creditsLimit: 0 })

  return {
    async loadSubscription(u, w) {
      return subs.get(key(u, w)) ?? fallback(u, w)
    },
    async upsertSubscription(u, w, p) {
      const cur = subs.get(key(u, w)) ?? fallback(u, w)
      const next = { ...cur, ...p, updatedAt: nowIso() }
      subs.set(key(u, w), next)
      return next
    },
    async consume({ userId, workspaceId, credits, usage: rec }) {
      const cur = subs.get(key(userId, workspaceId)) ?? fallback(userId, workspaceId)
      cur.creditsUsed += credits
      subs.set(key(userId, workspaceId), cur)
      const record: CreditUsageRecord = { ...rec, id: String(usage.length + 1), createdAt: nowIso() }
      usage.push(record)
      return { creditsUsed: credits, record }
    },
    async canConsume(u, w, c) {
      const cur = subs.get(key(u, w)) ?? fallback(u, w)
      const remaining = cur.creditsLimit - cur.creditsUsed
      return remaining >= c ? { ok: true, remaining } : { ok: false, remaining }
    },
    async recentUsage() {
      return usage.slice(-10)
    },
    async claimEvent() {
      return true
    },
    async hasProcessedEvent() {
      return false
    },
    async _resetForTests() {
      subs.clear()
      usage.length = 0
    },
    _subs: subs,
    _usage: usage,
  }
}

// ------------------------------------------------------------------ //
// callLlm fetcher stub (server-side model call)                      //
// ------------------------------------------------------------------ //

let modelCalls: Array<{ url: string; auth: string | null; body: string }> = []

function stubModelFetcher(content: string): void {
  modelCalls = []
  _setFetcherForTests((async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    modelCalls.push({
      url: String(url),
      auth: headers.get("authorization"),
      body: String(init?.body ?? ""),
    })
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch)
}

const EMPTY_REPORT: ScanReportLite = {
  risk_score: 0,
  summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
  findings: [],
}

function bearerFor(userId: string, workspaceId: string): string {
  const now = Math.floor(Date.now() / 1000)
  return _signHs256({ sub: userId, workspaceId, iat: now, exp: now + 3600 }, JWT_SECRET)
}

function cloudReq(body: Record<string, unknown>, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request("https://api.product.test/api/cloud/finding/patch-generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const PATCH_REPLY = JSON.stringify({
  edits: [{ old_str: "TARGET_OLD_LINE", new_str: "TARGET_NEW_LINE" }],
  reason: "unit-test patch",
})

// ------------------------------------------------------------------ //
// Cloud generation endpoint                                          //
// ------------------------------------------------------------------ //

describe("cloud generation endpoint (/api/cloud/.../*-generate)", () => {
  let emptyHome: string
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.OPENAI_API_KEY = "sk-server-side-key-never-leaks"
    delete process.env.EDGE_AGENT_DEV_AUTH
    delete process.env.EDGE_AGENT_AUTH_BEARER
    // Point the GitHub-auth store at an empty dir so a developer machine's
    // real stored login can't authenticate the "no session" case.
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "edge-empty-home-"))
    process.env.EDGE_AGENT_HOME = emptyHome
    // Ensure the dev-stub / bearer paths in assertSession stay inert and the
    // resolver is exercised as in production-like conditions (non-prod so the
    // JWT path is honoured).
    ;(process.env as Record<string, string | undefined>).NODE_ENV = "test"
  })
  afterEach(async () => {
    _setFetcherForTests(null)
    await _resetBillingBootstrapForTests()
    delete process.env.OPENAI_API_KEY
    delete process.env.JWT_SECRET
    delete process.env.EDGE_AGENT_HOME
    fs.rmSync(emptyHome, { recursive: true, force: true })
  })

  it("401s when no session is present", async () => {
    setAsyncBillingStore(memStore([]))
    stubModelFetcher(PATCH_REPLY)
    const res = await handleCloudGenerate(cloudReq({ system: "s", user: "u" }))
    assert.equal(res.status, 401)
    assert.equal(modelCalls.length, 0, "no model call without auth")
  })

  it("rejects apiKey / baseUrl fields with 400 (BYOK not supported)", async () => {
    setAsyncBillingStore(memStore([makeRecord("u1", "w1", {})]))
    stubModelFetcher(PATCH_REPLY)
    const res = await handleCloudGenerate(
      cloudReq({ system: "s", user: "u", apiKey: "sk-byok" }, bearerFor("u1", "w1")),
    )
    assert.equal(res.status, 400)
    const data = (await res.json()) as { code?: string }
    assert.equal(data.code, "byok_not_supported")
    assert.equal(modelCalls.length, 0, "no model call when body carries a key")
  })

  it("uses the hosted resolver + SERVER key, debits credits, and never returns a key", async () => {
    const store = memStore([makeRecord("u1", "w1", { creditsLimit: 50, creditsUsed: 0 })])
    setAsyncBillingStore(store)
    stubModelFetcher(PATCH_REPLY)

    const res = await handleCloudGenerate(
      cloudReq({ system: "sys", user: "usr", intelligenceMode: "auto", task: "patch" }, bearerFor("u1", "w1")),
    )
    assert.equal(res.status, 200)
    const data = (await res.json()) as Record<string, unknown>
    assert.equal(data.ok, true)
    assert.equal(typeof data.text, "string")
    assert.ok((data.creditsUsed as number) > 0, "credits debited after success")
    // No provider credentials ever leave the cloud.
    assert.equal(data.apiKey, undefined)
    assert.equal(data.baseUrl, undefined)
    const serialized = JSON.stringify(data)
    assert.ok(!serialized.includes("sk-server-side-key"), "response must not include the server key")

    // The model was called with the SERVER key (resolver-supplied), not a body key.
    assert.equal(modelCalls.length, 1)
    assert.equal(modelCalls[0].auth, "Bearer sk-server-side-key-never-leaks")

    // Ledger debited.
    assert.ok(store._subs.get("u1::w1")!.creditsUsed > 0)
  })

  it("returns quota_exceeded (402) BEFORE any model call", async () => {
    const store = memStore([makeRecord("u1", "w1", { creditsLimit: 0, creditsUsed: 0 })])
    setAsyncBillingStore(store)
    stubModelFetcher(PATCH_REPLY)

    const res = await handleCloudGenerate(
      cloudReq({ system: "s", user: "u", intelligenceMode: "auto", task: "patch" }, bearerFor("u1", "w1")),
    )
    assert.equal(res.status, 402)
    const data = (await res.json()) as { code?: string }
    assert.equal(data.code, "quota_exceeded")
    assert.equal(modelCalls.length, 0, "quota gate must block before the model call")
    assert.equal(store._subs.get("u1::w1")!.creditsUsed, 0, "no credits debited on a blocked call")
  })
})

// ------------------------------------------------------------------ //
// Completion transport (local → cloud relay)                         //
// ------------------------------------------------------------------ //

describe("makeCloudCompletionFn (transport)", () => {
  it("POSTs prompt-only to base+endpoint with the session Bearer, returns text", async () => {
    const captured: Array<{ url: string; auth: string | null; body: string }> = []
    const fn = makeCloudCompletionFn({
      baseUrl: "https://api.product.test/",
      token: "session-jwt",
      endpoint: "/api/cloud/finding/patch-generate",
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        captured.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body ?? ""),
        })
        return new Response(JSON.stringify({ ok: true, text: PATCH_REPLY, model: "m", creditsUsed: 3, quotaRemaining: 47 }), { status: 200 })
      }) as typeof fetch,
    })

    const r = await fn({
      system: "sys",
      user: "usr",
      json: true,
      maxTokens: 800,
      model: "gpt-x",
      intelligenceMode: "auto",
      task: "patch",
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.text, PATCH_REPLY)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, "https://api.product.test/api/cloud/finding/patch-generate")
    assert.equal(captured[0].auth, "Bearer session-jwt")
    // Body carries ONLY prompt + routing hints — no key, no file path.
    assert.ok(!/apiKey|baseUrl|sk-/.test(captured[0].body), "transport body must not carry a key")
    // Only whitelisted prompt/routing fields may appear (undefined ones are
    // dropped by JSON.stringify — that's fine; the point is no EXTRA fields).
    const allowed = new Set([
      "complexity",
      "intelligenceMode",
      "json",
      "manualModelSelection",
      "maxTokens",
      "model",
      "system",
      "task",
      "temperature",
      "user",
    ])
    const parsed = JSON.parse(captured[0].body) as Record<string, unknown>
    for (const k of Object.keys(parsed)) {
      assert.ok(allowed.has(k), `unexpected field in cloud request body: ${k}`)
    }
    assert.ok("system" in parsed && "user" in parsed)
  })

  it("surfaces quota_exceeded via onError and returns ok:false", async () => {
    const errors: Array<{ code: string; status: number }> = []
    const fn = makeCloudCompletionFn({
      baseUrl: "https://api.product.test",
      token: null,
      endpoint: "/api/cloud/findings/fix-generate",
      onError: (e) => {
        errors.push({ code: e.code, status: e.status })
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "no credits", code: "quota_exceeded" }), { status: 402 })) as typeof fetch,
    })
    const r = await fn({ system: "s", user: "u", json: true, maxTokens: 1, model: "m", intelligenceMode: "auto", task: "patch" })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "quota_exceeded")
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, "quota_exceeded")
    assert.equal(errors[0].status, 402)
  })
})

// ------------------------------------------------------------------ //
// Pipeline seam: injected generate skips the provider guard           //
// and apply stays local                                               //
// ------------------------------------------------------------------ //

describe("pipeline generate-injection + local apply", () => {
  let dir: string
  const rel = "notes.txt" // no parser → parse gate is a no-op (avoids python/node dep)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-gen-test-"))
    fs.writeFileSync(path.join(dir, rel), "line one\nTARGET_OLD_LINE\nline three\n", "utf8")
    _setRunScannerForTests(() => Promise.resolve(EMPTY_REPORT))
  })
  afterEach(() => {
    _setRunScannerForTests(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("generates via the injected completion (no provider key) and applies locally with a backup", async () => {
    const finding: PlannerFinding = {
      id: "f1",
      rule_id: "prompt-injection",
      severity: "high",
      category: "",
      file: rel,
      line: 2,
    }

    const captured: Array<{ system: string; user: string }> = []
    const preview = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: null, // desktop: NO local key — injected generate is the seam
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0,
      generate: async (req) => {
        captured.push({ system: req.system, user: req.user })
        return { ok: true, text: PATCH_REPLY }
      },
    })

    assert.ok(!("refused" in preview && preview.refused), "should not be refused")
    const p = preview as PatchPreview
    assert.ok(p.patches[0].newContents.includes("TARGET_NEW_LINE"))
    assert.ok(!p.patches[0].newContents.includes("TARGET_OLD_LINE"))

    // (7) The cloud only ever saw prompt text — never the absolute project path.
    assert.ok(captured.length >= 1)
    for (const c of captured) {
      assert.ok(!c.user.includes(dir), "prompt must not leak the absolute project path")
      assert.ok(!c.system.includes(dir))
    }

    // (6 + 10) Apply happens locally: file rewritten + backup created.
    const applied = applyPatch({ projectPath: dir, preview: p })
    assert.equal(applied.applied, true)
    const onDisk = fs.readFileSync(path.join(dir, rel), "utf8")
    assert.ok(onDisk.includes("TARGET_NEW_LINE"))
    const bak = path.join(dir, ".edge-agent", "backups", `${rel}.bak`)
    assert.ok(fs.existsSync(bak), "a .bak backup must be written before apply")
    assert.ok(fs.readFileSync(bak, "utf8").includes("TARGET_OLD_LINE"))
  })
})

// ------------------------------------------------------------------ //
// Gateway cloud path: local route → cloud generation endpoint        //
// ------------------------------------------------------------------ //

describe("generation gateway (cloud mode)", () => {
  let dir: string
  const rel = "svc.txt"
  const ORIGINAL_FETCH = global.fetch
  let cloudCalls: Array<{ url: string; auth: string | null; body: string }> = []

  beforeEach(() => {
    process.env.EDGE_AGENT_CLOUD_API_BASE = "https://api.product.test"
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-gw-test-"))
    fs.writeFileSync(path.join(dir, rel), "alpha\nTARGET_OLD_LINE\nomega\n", "utf8")
    _setRunScannerForTests(() => Promise.resolve(EMPTY_REPORT))
    cloudCalls = []
    global.fetch = (async (url: unknown, init?: RequestInit) => {
      cloudCalls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: String(init?.body ?? ""),
      })
      return new Response(
        JSON.stringify({ ok: true, text: PATCH_REPLY, model: "cloud-model", creditsUsed: 3, quotaRemaining: 47 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
  })
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    _setRunScannerForTests(null)
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.EDGE_AGENT_CLOUD_API_BASE
  })

  it("relays generation to the cloud endpoint with the forwarded token and reports cloud credits", async () => {
    assert.equal(cloudGenerationActive(), true)

    const finding: PlannerFinding = {
      id: "f1",
      rule_id: "prompt-injection",
      severity: "high",
      category: "",
      file: rel,
      line: 2,
    }
    // Incoming local-route request carries the session bearer (apiFetch
    // attaches it to fix/patch when the split is on).
    const req = new Request("http://127.0.0.1:31337/api/finding/patch", {
      method: "POST",
      headers: { authorization: "Bearer relayed-session-jwt" },
    })
    assert.equal(bearerFromRequest(req), "relayed-session-jwt")

    const gen = await generateFindingPatch({
      req,
      session: { userId: "u1", workspaceId: "w1" },
      projectPath: dir,
      finding,
      plan: planFix(finding),
      intelligenceMode: "auto",
      complexity: 0,
      task: "patch",
      cloudEndpoint: "/api/cloud/finding/patch-generate",
    })

    assert.equal(gen.ok, true)
    assert.ok(gen.preview && !("refused" in gen.preview && gen.preview.refused))
    assert.equal(gen.creditsUsed, 3, "credits come from the cloud response")
    assert.equal(gen.quotaRemaining, 47)

    // (2) the gateway hit the cloud generation endpoint with the token.
    assert.ok(cloudCalls.length >= 1)
    assert.equal(cloudCalls[0].url, "https://api.product.test/api/cloud/finding/patch-generate")
    assert.equal(cloudCalls[0].auth, "Bearer relayed-session-jwt")
    // (7 + 11) the relayed body has no key and no absolute local path.
    assert.ok(!/apiKey|baseUrl|sk-/.test(cloudCalls[0].body))
    assert.ok(!cloudCalls[0].body.includes(dir))
  })
})

// ------------------------------------------------------------------ //
// Route classification: apply stays local, generation is cloud        //
// ------------------------------------------------------------------ //

describe("route classification for the generation split", () => {
  it("keeps fix/patch APPLY routes local but marks them as generation-forwarding", () => {
    for (const r of ["/api/finding/patch", "/api/findings/fix", "/api/findings/fix-filtered"]) {
      assert.equal(classifyApiRoute(r), "local", `${r} apply must stay local`)
      assert.equal(forwardsGenerationToCloud(r), true, `${r} forwards generation`)
    }
  })

  it("routes the cloud generation endpoints to the cloud backend", () => {
    for (const r of [
      "/api/cloud/finding/patch-generate",
      "/api/cloud/findings/fix-generate",
      "/api/cloud/findings/fix-filtered-generate",
    ]) {
      assert.equal(classifyApiRoute(r), "cloud", `${r} must be cloud`)
      assert.equal(forwardsGenerationToCloud(r), false)
    }
  })
})
