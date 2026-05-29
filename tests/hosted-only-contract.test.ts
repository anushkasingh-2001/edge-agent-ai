/**
 * Hosted-only contract regression tests.
 *
 * Pins the post-BYOK security contract one assertion at a time. Each
 * test matches one numbered requirement from the rollout spec:
 *
 *   1.  Settings page has no API key fields.
 *   2.  There is no BYOK toggle/option.
 *   3.  Scan page says "AI included in your plan. No API key required."
 *   4.  Frontend hosted requests never include apiKey.
 *   5.  Backend defaults to hosted provider behavior.
 *   6.  Backend reads provider keys only from server env/secret manager.
 *   7.  API responses never include provider keys.
 *   8.  Provider keys are never stored in localStorage/client state.
 *   9.  Quota exceeded blocks model call before provider call.
 *  10.  Plan without Pro/Max blocks those modes before provider call.
 *  11.  Explain/fix/bulk all use the same hosted resolver.
 *
 * Run with:
 *   node --import tsx --test tests/hosted-only-contract.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  recordConsumption,
  redactForClient,
  resolveAiProviderForRequest,
} from "../lib/server-ai-provider-resolver"
import {
  _resetLedgerForTests,
  loadSubscription,
  planSummary,
} from "../lib/server-subscription"
import { fetchFindingExplanation } from "../lib/finding-explanation-client"
import { runFindingFixesApi } from "../lib/finding-fixes-client"
import { purgeLegacyProviderKeys } from "../lib/model-keys"

const repoRoot = path.resolve(__dirname, "..")
const readRepoFile = (p: string) => readFileSync(path.join(repoRoot, p), "utf8")

function setHostedKeys() {
  process.env.OPENAI_API_KEY = "sk-hosted-test"
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  process.env.GEMINI_API_KEY = "sk-hosted-test"
}
function clearHostedKeys() {
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GEMINI_API_KEY
}
function enterprise() {
  process.env.EDGE_AGENT_PLAN_TIER = "enterprise"
}
function free() {
  process.env.EDGE_AGENT_PLAN_TIER = "free"
}

// ===================================================================
// 1. Settings page has no API key fields.
// ===================================================================

test("1. Settings page source has no API key input controls", () => {
  const src = readRepoFile("components/views/settings.tsx")
  // The Settings page must not contain the BYOK-era key/baseUrl
  // inputs, the "Use my own key" toggle, or the Test-key button.
  const banned = [
    /\bapiKey\b/,
    /\bbaseUrl\b/,
    /Bring your own/i,
    /Use your own/i,
    /Use my own/i,
    /Test key/i,
    /Provider key/i,
    /<Input[^>]*placeholder=["'][^"']*sk-/i,
  ]
  for (const re of banned) {
    assert.equal(
      re.test(src),
      false,
      `Settings still contains a BYOK surface matching ${re}`,
    )
  }
})

// ===================================================================
// 2. There is no BYOK toggle/option.
// ===================================================================

test("2. No BYOK toggle/option in the Settings or Scan UI", () => {
  for (const file of [
    "components/views/settings.tsx",
    "components/views/scan-center.tsx",
  ]) {
    const src = readRepoFile(file)
    assert.equal(
      /BYOK|Bring your own key|Use my own key/i.test(src),
      false,
      `${file} still references BYOK`,
    )
  }
})

// ===================================================================
// 3. Scan page says "AI included in your plan. No API key required."
// ===================================================================

test("3. Scan Center surfaces the hosted-plan banner", () => {
  const src = readRepoFile("components/views/scan-center.tsx")
  assert.match(
    src,
    /AI included in your plan/i,
    "Scan Center must show the hosted plan banner",
  )
  assert.match(
    src,
    /No API key required/i,
    "Scan Center must explicitly say no key is required",
  )
})

// ===================================================================
// 4. Frontend hosted requests never include apiKey.
// ===================================================================

test("4. fetchFindingExplanation never sends apiKey/baseUrl/provider", async () => {
  const captured: { body?: Record<string, unknown> } = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.body = JSON.parse(init?.body ?? "{}")
    return new Response(
      JSON.stringify({
        kind: "ai",
        text: "...",
        details: [],
        apiKeySource: "hosted",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  try {
    await fetchFindingExplanation({
      finding: {
        id: "f1",
        category: "test",
        title: "t",
        severity: "low",
        file: "a.py",
        line: 1,
        agent: "scanner",
        reason: "test",
        evidence: [],
        suggestedFix: "",
        ruleId: "r1",
      } as unknown as Parameters<typeof fetchFindingExplanation>[0]["finding"],
      projectPath: "/p",
      intelligenceMode: "save",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body ?? {}
  for (const k of [
    "apiKey",
    "baseUrl",
    "provider",
    "providerKey",
    "openaiApiKey",
    "anthropicApiKey",
    "geminiApiKey",
  ]) {
    assert.equal(
      body[k],
      undefined,
      `explain client must never put ${k} on the wire`,
    )
  }
})

test("4b. runFindingFixesApi never sends apiKey/baseUrl/provider", async () => {
  const captured: { body?: Record<string, unknown> } = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captured.body = JSON.parse(init?.body ?? "{}")
    return new Response(
      JSON.stringify({
        mode: "suggest",
        total: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
        proposals: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
  try {
    await runFindingFixesApi({
      projectPath: "/p",
      mode: "suggest",
      targets: [],
      intelligenceMode: "auto",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const body = captured.body ?? {}
  for (const k of [
    "apiKey",
    "baseUrl",
    "provider",
    "providerKey",
    "openaiApiKey",
    "anthropicApiKey",
    "geminiApiKey",
  ]) {
    assert.equal(body[k], undefined, `fixes client must never put ${k} on wire`)
  }
})

// ===================================================================
// 5. Backend defaults to hosted provider behavior.
// 6. Backend reads provider keys only from server env/secret manager.
// ===================================================================

test("5,6. Resolver succeeds from env keys; fails missing_hosted_key without them", () => {
  enterprise()
  _resetLedgerForTests()

  setHostedKeys()
  const ok = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.apiKeySource, "hosted")

  clearHostedKeys()
  const miss = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(miss.ok, false)
  if (!miss.ok) assert.equal(miss.code, "missing_hosted_key")
})

// ===================================================================
// 7. API responses never include provider keys (via redactForClient).
// ===================================================================

test("7. redactForClient strips apiKey + baseUrl from any resolution", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const safe = redactForClient(r)
  assert.equal(safe.apiKey, null, "apiKey must be null on the client view")
  assert.equal(safe.baseUrl, null, "baseUrl must be null on the client view")
  assert.equal(safe.apiKeySource, "hosted")
  // Sanity: real key never appears in the redacted form.
  const serialized = JSON.stringify(safe)
  assert.equal(
    serialized.includes("sk-hosted-test"),
    false,
    "redactForClient must never echo the env key",
  )
})

// ===================================================================
// 8. Provider keys are never stored in localStorage/client state.
// ===================================================================

test("8. purgeLegacyProviderKeys wipes any leftover BYOK localStorage slot", () => {
  const store: Record<string, string> = {
    "edge-agent-ai.modelKeys": JSON.stringify([
      { id: "x", type: "anthropic", label: "a", model: "claude-sonnet-4-6", apiKey: "sk-legacy" },
    ]),
  }
  const fake = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k of Object.keys(store)) delete store[k] },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
  const w = globalThis as unknown as { window?: { localStorage: typeof fake } }
  const prev = w.window
  w.window = { localStorage: fake }
  try {
    const r = purgeLegacyProviderKeys()
    assert.equal(r.purged, true)
    assert.equal(
      "edge-agent-ai.modelKeys" in store,
      false,
      "purge must remove the legacy storage slot",
    )
  } finally {
    w.window = prev
  }
})

// ===================================================================
// 9. Quota exceeded blocks the call BEFORE the provider call.
// ===================================================================

test("9. Quota exceeded returns quota_exceeded before any model call", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()
  const sub = loadSubscription("u-q", "w")
  recordConsumption({
    userId: "u-q",
    workspaceId: "w",
    apiKeySource: "hosted",
    estimatedCredits: sub.creditsTotal,
  })
  const r = resolveAiProviderForRequest({
    userId: "u-q",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "quota_exceeded")
    assert.equal(r.upgrade, true)
  }
})

// ===================================================================
// 10. Free plan blocks Pro/Max/Manual before any provider call.
// ===================================================================

test("10. Free plan blocks Pro/Max/Manual with mode_not_in_plan", () => {
  free()
  setHostedKeys()
  _resetLedgerForTests()
  for (const mode of ["pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u",
      workspaceId: "w",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, false, `Free plan must block ${mode}`)
    if (!r.ok) assert.equal(r.code, "mode_not_in_plan")
  }
})

// ===================================================================
// 11. Explain/fix/bulk all use the same hosted resolver.
// ===================================================================

test("11. All AI routes import the same hosted resolver", () => {
  const routes = [
    "app/api/finding/explain/route.ts",
    "app/api/finding/patch/route.ts",
    "app/api/findings/fix/route.ts",
    "app/api/findings/fix-filtered/route.ts",
  ]
  for (const r of routes) {
    const src = readRepoFile(r)
    // The route must reach the hosted resolver EITHER directly OR via the
    // patch-generation gateway (which owns the resolver call for the
    // desktop/cloud split). Both paths enforce auth → plan → quota → key.
    assert.match(
      src,
      /resolveAiProviderForRequest|generateFindingPatch/,
      `${r} must call the hosted resolver (directly or via the generation gateway)`,
    )
    // And must not silently fall back to a process.env key without
    // going through the resolver.
    assert.equal(
      /process\.env\.OPENAI_API_KEY\s*\?\?/.test(src),
      false,
      `${r} must not bypass the resolver with a process.env fallback`,
    )
  }

  // The generation gateway itself MUST go through the hosted resolver — it is
  // the single seam the patch/fix routes delegate generation to.
  const gateway = readRepoFile("lib/server-patch-generation-gateway.ts")
  assert.match(
    gateway,
    /resolveAiProviderForRequestAsync/,
    "the generation gateway must call the hosted resolver in its local path",
  )
})

// ===================================================================
// 11b. /api/plan returns a safe summary (no apiKey).
// ===================================================================

test("11b. /api/plan source never returns apiKey", () => {
  const src = readRepoFile("app/api/plan/route.ts")
  assert.equal(
    /\bapiKey\b/.test(src),
    false,
    "/api/plan must not include apiKey in its response",
  )
  assert.match(src, /planSummary/)
})
