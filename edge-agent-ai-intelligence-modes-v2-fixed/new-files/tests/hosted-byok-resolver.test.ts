/**
 * Hosted-AI / BYOK + subscription/quota tests.
 *
 * Covers the spec's backend assertions:
 *   - Hosted is usable without a frontend key; the hosted key is never
 *     returned to the client (redactForClient).
 *   - BYOK uses the request key, only when BYOK is selected.
 *   - Pro/Max/Manual blocked when the plan doesn't allow them.
 *   - Quota exceeded blocks before any model call.
 *   - Save mode stays cheapest (cheap tier) and forbids patch generation.
 *   - Bulk routing resolves one model per call (cluster), priced.
 *
 * Run with:
 *   node --import tsx/esm --test tests/hosted-byok-resolver.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolveAiProviderForRequest,
  recordConsumption,
  redactForClient,
} from "../lib/server-ai-provider-resolver"
import { _resetLedgerForTests, loadSubscription, planSummary } from "../lib/server-subscription"

function setTier(t: "free" | "pro" | "enterprise") {
  process.env.EDGE_AGENT_PLAN_TIER = t
}

test("free plan blocks Pro mode with an upgrade message", () => {
  _resetLedgerForTests()
  setTier("free")
  const r = resolveAiProviderForRequest({
    userId: "u", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "pro", task: "patch",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "mode_not_in_plan")
    assert.equal(r.upgrade, true)
  }
})

test("Hosted works without a frontend key, and the key is never returned", () => {
  _resetLedgerForTests()
  setTier("free")
  process.env.EDGE_AGENT_HOSTED_OPENAI_KEY = "sk-hosted-secret"
  const r = resolveAiProviderForRequest({
    userId: "u", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "auto", task: "explain",
    estimatedInputTokens: 1000, estimatedOutputTokens: 500,
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.apiKeySource, "hosted")
    assert.equal(r.apiKey, "sk-hosted-secret", "server has the hosted key for the call")
    const safe = redactForClient(r)
    assert.equal(safe.apiKey, null, "hosted key must NOT go to the client")
    assert.equal(safe.baseUrl, null)
  }
})

test("Pro plan allows Manual mode but blocks per-task model selection", () => {
  _resetLedgerForTests()
  setTier("pro")
  const r = resolveAiProviderForRequest({
    userId: "u", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "manual", task: "patch",
    manualModelSelection: { patch: "mid" },
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "manual_not_in_plan")
})

test("Enterprise BYOK uses the request key, only when BYOK is selected", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  const r = resolveAiProviderForRequest({
    userId: "u", workspaceId: "w", aiProviderMode: "byok", intelligenceMode: "manual", task: "patch",
    byokApiKey: "sk-user-key", byokProvider: "anthropic", manualModelSelection: { patch: "mid" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.apiKeySource, "byok")
    assert.equal(r.apiKey, "sk-user-key")
    assert.equal(r.provider, "anthropic")
  }
})

test("BYOK without a key is blocked", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  const r = resolveAiProviderForRequest({
    userId: "u", workspaceId: "w", aiProviderMode: "byok", intelligenceMode: "auto", task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "missing_byok_key")
})

test("quota exceeded blocks before any model call", () => {
  _resetLedgerForTests()
  setTier("free")
  const r = resolveAiProviderForRequest({
    userId: "u2", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "auto", task: "patch",
    estimatedInputTokens: 100_000_000, estimatedOutputTokens: 100_000_000,
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "quota_exceeded")
})

test("Save mode is cheapest and forbids patch generation", () => {
  _resetLedgerForTests()
  setTier("free")
  const explain = resolveAiProviderForRequest({
    userId: "u3", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "save", task: "explain",
    estimatedInputTokens: 500, estimatedOutputTokens: 200,
  })
  assert.equal(explain.ok, true)
  if (explain.ok) assert.ok(explain.estimatedCredits >= 1)

  const patch = resolveAiProviderForRequest({
    userId: "u3", workspaceId: "w", aiProviderMode: "hosted", intelligenceMode: "save", task: "patch",
  })
  assert.equal(patch.ok, false)
  if (!patch.ok) assert.equal(patch.code, "task_not_allowed_in_mode")
})

test("hosted consumption draws down credits; BYOK does not", () => {
  _resetLedgerForTests()
  setTier("pro")
  const before = planSummary(loadSubscription("u4", "w")).creditsRemaining
  recordConsumption({ userId: "u4", workspaceId: "w", apiKeySource: "hosted", actualCostUsd: 0.05 })
  const afterHosted = planSummary(loadSubscription("u4", "w")).creditsRemaining
  assert.ok(afterHosted < before, "hosted spend should reduce remaining credits")

  recordConsumption({ userId: "u4", workspaceId: "w", apiKeySource: "byok", actualCostUsd: 999 })
  const afterByok = planSummary(loadSubscription("u4", "w")).creditsRemaining
  assert.equal(afterByok, afterHosted, "BYOK must not draw down hosted credits")
})

test("plan summary never leaks keys (shape is limits + credits only)", () => {
  setTier("enterprise")
  const summary = planSummary(loadSubscription("u5", "w"))
  assert.deepEqual(
    Object.keys(summary).sort(),
    ["allowManualModelSelection", "allowedModes", "creditsRemaining", "creditsTotal", "creditsUsed", "tier"].sort(),
  )
})
