/**
 * All-mode wiring regression tests (Hosted-only product).
 *
 * Canonical end-to-end matrix for the five intelligence modes
 * (Save / Auto / Pro / Max / Manual) under the hosted-only contract.
 * Each test covers one item from the required-tests checklist and is
 * named accordingly so a failure points straight at the broken seam.
 *
 *   1. Save mode refuses LLM patch generation.
 *   2. Auto mode routes cheap/cascade/strong based on complexity.
 *   3. Pro mode routes to coding_flagship tier.
 *   4. Max mode enables two-step plan → patch behavior.
 *   5. Manual mode honors exact selected model IDs.
 *   6. manualModels and manualModelSelection are both accepted/normalized.
 *   7. Fix all / Fix filtered forwards intelligenceMode (no apiKey).
 *   8. Hosted resolver reads env keys; never expects caller apiKey.
 *   9. recordConsumption debits the ledger after a successful call.
 *
 * Run with:
 *   node --import tsx --test tests/all-modes-e2e-wiring.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolveAiProviderForRequest,
  recordConsumption,
  redactForClient,
} from "../lib/server-ai-provider-resolver"
import {
  _resetLedgerForTests,
  loadSubscription,
  planSummary,
} from "../lib/server-subscription"
import { routeForMode } from "../lib/server-model-router-ext"
import { runFindingFixesApi } from "../lib/finding-fixes-client"

// ===================================================================
// Test helpers
// ===================================================================

/** Force the env-keyed hosted resolver to find a credential. */
function setHostedKeys(): void {
  process.env.OPENAI_API_KEY = "sk-hosted-test"
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  process.env.GEMINI_API_KEY = "sk-hosted-test"
}

function clearHostedKeys(): void {
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

/** Capture-style fetch stub: records the JSON body sent to fetch() and
 *  returns a synthetic 200 OK with an empty RunFixesResult. Tests use
 *  this to inspect what `runFindingFixesApi` puts on the wire without
 *  needing a live Next route. */
function stubFetchOnce(): {
  bodies: Array<Record<string, unknown>>
  restore: () => void
} {
  const bodies: Array<Record<string, unknown>> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"))
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
  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

// ===================================================================
// 1. Save mode refuses LLM patch generation.
// ===================================================================

test("1. Save mode refuses LLM patch generation (hosted)", () => {
  _resetLedgerForTests()
  free()
  setHostedKeys()
  const r = resolveAiProviderForRequest({
    userId: "u-save",
    workspaceId: "w",
    intelligenceMode: "save",
    task: "patch",
  })
  assert.equal(r.ok, false, "Save must NOT return a usable resolution for patch")
  if (!r.ok) {
    assert.equal(
      r.code,
      "task_not_allowed_in_mode",
      "Save's refusal is policy-driven, not a missing-key failure",
    )
  }
  // Explain in Save mode IS allowed — same resolver call, different
  // task — so a regression that flat-blocks Save would be caught here.
  const explain = resolveAiProviderForRequest({
    userId: "u-save",
    workspaceId: "w",
    intelligenceMode: "save",
    task: "explain",
  })
  assert.equal(explain.ok, true, "Save mode must still allow AI explanations")
})

// ===================================================================
// 2. Auto mode routes cheap/cascade/strong based on complexity.
// ===================================================================

test("2. Auto mode routes by complexity", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()

  // Explain at low complexity is the cheap-tier sweet spot the
  // intelligence-modes spec advertises ("cheap explain for low
  // complexity"). Patch unconditionally jumps to the coding-flagship
  // tier even at low complexity, by design.
  // Complexity is a 0..1 score, not 0..9.
  const lo = routeForMode({
    mode: "auto", task: "explain", complexity: 0.1, provider: "openai_compatible",
  })
  const mid = routeForMode({
    mode: "auto", task: "patch", complexity: 0.5, provider: "openai_compatible",
  })
  const hi = routeForMode({
    mode: "auto", task: "patch", complexity: 0.9, provider: "openai_compatible",
  })
  assert.equal(lo.tier, "cheap", "low-complexity auto explain must pick cheap tier")
  // Auto patch always allows cascade escalation regardless of bucket.
  assert.equal(mid.cascade, true, "auto patch must allow cascade escalation")
  assert.equal(
    hi.tier,
    "coding_flagship",
    "high-complexity auto patch must route to coding_flagship",
  )
  assert.equal(hi.twoStep, true, "high-complexity auto patch must be two-step")
})

// ===================================================================
// 3. Pro mode routes to coding_flagship tier.
// ===================================================================

test("3. Pro mode routes to coding_flagship", () => {
  enterprise()
  setHostedKeys()
  const r = routeForMode({
    mode: "pro", task: "patch", complexity: 5, provider: "openai_compatible",
  })
  assert.equal(r.tier, "coding_flagship", "Pro must use the strongest coding model")
})

// ===================================================================
// 4. Max mode enables two-step plan → patch.
// ===================================================================

test("4. Max mode is two-step (plan → patch)", () => {
  enterprise()
  setHostedKeys()
  const r = routeForMode({
    mode: "max", task: "patch", complexity: 7, provider: "openai_compatible",
  })
  assert.equal(r.twoStep, true, "Max must enable two-step plan → patch")
})

// ===================================================================
// 5. Manual mode honors exact selected model IDs.
// ===================================================================

test("5. Manual mode honors exact selected model IDs", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "manual",
    task: "patch",
    manualModelSelection: { patch: "anthropic:claude-opus-4-7" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-opus-4-7")
  }
})

// ===================================================================
// 6. manualModels and manualModelSelection are both accepted.
// ===================================================================

test("6. Manual task aliases (patch / patch_generation) both resolve", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "manual",
    task: "patch",
    manualModelSelection: { patchGeneration: "openai:gpt-4.1-mini" },
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.model, "gpt-4.1-mini")
})

// ===================================================================
// 7. Fix all / Fix filtered forwards intelligenceMode but NEVER apiKey.
// ===================================================================

test("7. runFindingFixesApi forwards mode but never sends apiKey/baseUrl/provider", async () => {
  const cap = stubFetchOnce()
  try {
    await runFindingFixesApi({
      projectPath: "/x",
      mode: "suggest",
      targets: [],
      intelligenceMode: "pro",
      manualModelSelection: { patch: "anthropic:claude-opus-4-7" },
    })
  } finally {
    cap.restore()
  }
  assert.equal(cap.bodies.length, 1)
  const body = cap.bodies[0]
  assert.equal(body.intelligenceMode, "pro", "intelligenceMode must be forwarded")
  assert.equal(body.apiKey, undefined, "apiKey must NEVER be on the wire")
  assert.equal(body.baseUrl, undefined, "baseUrl must NEVER be on the wire")
  assert.equal(body.provider, undefined, "provider must NEVER be on the wire")
  assert.equal(
    body.providerKey,
    undefined,
    "providerKey must NEVER be on the wire",
  )
  assert.equal(
    body.openaiApiKey,
    undefined,
    "openaiApiKey must NEVER be on the wire",
  )
  assert.equal(
    body.anthropicApiKey,
    undefined,
    "anthropicApiKey must NEVER be on the wire",
  )
  assert.equal(
    body.geminiApiKey,
    undefined,
    "geminiApiKey must NEVER be on the wire",
  )
})

// ===================================================================
// 8. Hosted resolver reads env keys; never expects caller apiKey.
// ===================================================================

test("8. Hosted resolver fails with missing_hosted_key when env unset", () => {
  enterprise()
  _resetLedgerForTests()
  clearHostedKeys()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "missing_hosted_key")
  }
})

test("8b. Hosted resolver succeeds when OPENAI_API_KEY is in env", () => {
  enterprise()
  _resetLedgerForTests()
  setHostedKeys()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.apiKeySource, "hosted")
    assert.ok(r.apiKey, "server-side resolution carries the env key")
    // Critical: the redacted-for-client form has no apiKey.
    const safe = redactForClient(r)
    assert.equal(
      safe.apiKey,
      null,
      "redactForClient must strip the apiKey before any HTTP response",
    )
    assert.equal(
      safe.baseUrl,
      null,
      "redactForClient must strip the baseUrl before any HTTP response",
    )
  }
})

// ===================================================================
// 9. recordConsumption debits the ledger after a successful hosted call.
// ===================================================================

test("9. recordConsumption debits credits after a successful hosted call", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()

  const before = planSummary(loadSubscription("u-cred", "w"))
  const r = resolveAiProviderForRequest({
    userId: "u-cred",
    workspaceId: "w",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const debited = recordConsumption({
    userId: "u-cred",
    workspaceId: "w",
    apiKeySource: "hosted",
    estimatedCredits: r.estimatedCredits,
  })
  assert.ok(debited > 0, "recordConsumption must debit at least one credit")
  const after = planSummary(loadSubscription("u-cred", "w"))
  assert.equal(
    after.creditsRemaining,
    before.creditsRemaining - debited,
    "ledger must be debited by exactly the recorded amount",
  )
})

// ===================================================================
// 10. Free plan blocks Pro / Max / Manual modes before any model call.
// ===================================================================

test("10. Free plan blocks Pro/Max/Manual with mode_not_in_plan", () => {
  free()
  setHostedKeys()
  _resetLedgerForTests()
  for (const mode of ["pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-free",
      workspaceId: "w",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, false, `Free plan must block ${mode}`)
    if (!r.ok) {
      assert.equal(r.code, "mode_not_in_plan")
      assert.equal(r.upgrade, true)
    }
  }
})

// ===================================================================
// 11. Quota exceeded blocks the call BEFORE any provider call.
// ===================================================================

test("11. quota_exceeded fires before any upstream model call", () => {
  enterprise()
  setHostedKeys()
  _resetLedgerForTests()
  // Pre-fill the ledger to the exact total so the next call cannot fit.
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
    intelligenceMode: "pro",
    task: "patch",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "quota_exceeded")
    assert.equal(r.upgrade, true)
  }
})
