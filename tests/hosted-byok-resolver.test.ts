/**
 * BYOK-only resolver tests.
 *
 * The previous build supported a Hosted (server-side key) path. This
 * MVP refactor removed it entirely — the resolver now requires a
 * caller-supplied key and never reads `process.env.*_API_KEY`. These
 * tests pin that contract so a future regression that re-introduces
 * a silent hosted fallback fails immediately.
 *
 * Spec mirrored here:
 *   - missing key → `missing_api_key`
 *   - aiProviderMode === "hosted" still routes through `missing_api_key`
 *     so no caller can accidentally re-enable the legacy path
 *   - BYOK with a key → `ok: true`, `apiKeySource: "byok"`
 *   - `recordConsumption` is a no-op (no credit draw-down)
 *   - `process.env.*_API_KEY` is NEVER consulted
 *   - Save mode forbids patch generation in BYOK-only mode too
 *
 * Run with:
 *   node --import tsx --test tests/hosted-byok-resolver.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolveAiProviderForRequest,
  recordConsumption,
  redactForClient,
  BYOK_MESSAGES,
  classifyUpstreamFailure,
} from "../lib/server-ai-provider-resolver"
import { _resetLedgerForTests, loadSubscription, planSummary } from "../lib/server-subscription"

function setTier(t: "free" | "pro" | "enterprise") {
  ;(process.env as Record<string, string | undefined>).EDGE_AGENT_PLAN_TIER = t
}

test("BYOK with caller key succeeds and never reads process.env", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  delete (process.env as Record<string, string | undefined>).OPENAI_API_KEY
  delete (process.env as Record<string, string | undefined>).ANTHROPIC_API_KEY
  delete (process.env as Record<string, string | undefined>).GOOGLE_API_KEY
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "explain",
    byokApiKey: "sk-user-key",
    byokProvider: "anthropic",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.apiKeySource, "byok")
    assert.equal(r.apiKey, "sk-user-key")
    assert.equal(r.provider, "anthropic")
    // No credit drawdown in BYOK-only — quotaStatus stays at 0/0
    // and estimatedCredits is 0.
    assert.equal(r.estimatedCredits, 0)
    assert.equal(r.quotaStatus.total, 0)
  }
})

test("aiProviderMode 'hosted' still requires a key (no silent fallback)", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  // Even though Hosted was the legacy default, the resolver now
  // requires the caller to forward a key regardless of the wire
  // enum. This pins the "no silent fallback to a server key" rule.
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "hosted",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "missing_api_key")
    assert.equal(r.reason, BYOK_MESSAGES.missing)
  }
})

test("BYOK without a key returns missing_api_key with canonical message", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, "missing_api_key")
    assert.equal(r.reason, BYOK_MESSAGES.missing)
  }
})

test("process.env.*_API_KEY is NOT honoured as a fallback", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  ;(process.env as Record<string, string | undefined>).OPENAI_API_KEY = "sk-env-leaked"
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "explain",
  })
  // No byokApiKey supplied → must refuse even though OPENAI_API_KEY
  // is set in the environment. This is the critical invariant.
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "missing_api_key")
  delete (process.env as Record<string, string | undefined>).OPENAI_API_KEY
})

test("redactForClient strips key and baseUrl from a successful resolution", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "auto",
    task: "explain",
    byokApiKey: "sk-user-key",
    byokBaseUrl: "https://api.openai.com/v1",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    const safe = redactForClient(r)
    assert.equal(safe.apiKey, null)
    assert.equal(safe.baseUrl, null)
  }
})

test("Save mode forbids patch generation in BYOK-only too", () => {
  _resetLedgerForTests()
  setTier("free")
  const explain = resolveAiProviderForRequest({
    userId: "u3",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "save",
    task: "explain",
    byokApiKey: "sk-user-key",
    estimatedInputTokens: 500,
    estimatedOutputTokens: 200,
  })
  assert.equal(explain.ok, true)
  if (explain.ok) {
    assert.equal(explain.estimatedCredits, 0, "no credit drawdown in BYOK-only")
  }

  const patch = resolveAiProviderForRequest({
    userId: "u3",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "save",
    task: "patch",
    byokApiKey: "sk-user-key",
  })
  assert.equal(patch.ok, false)
  if (!patch.ok) assert.equal(patch.code, "task_not_allowed_in_mode")
})

test("recordConsumption is a no-op (no credit drawdown for BYOK)", () => {
  _resetLedgerForTests()
  setTier("pro")
  const before = planSummary(loadSubscription("u4", "w")).creditsRemaining
  // Pretend a hosted call recorded $0.05 — must NOT debit anything.
  recordConsumption({
    userId: "u4",
    workspaceId: "w",
    apiKeySource: "hosted",
    actualCostUsd: 0.05,
  })
  // And a BYOK call also must not debit.
  recordConsumption({
    userId: "u4",
    workspaceId: "w",
    apiKeySource: "byok",
    actualCostUsd: 0.05,
  })
  const after = planSummary(loadSubscription("u4", "w")).creditsRemaining
  assert.equal(after, before, "recordConsumption must not draw down credits in BYOK-only mode")
})

test("plan summary never leaks keys (shape is limits + credits only)", () => {
  setTier("enterprise")
  const summary = planSummary(loadSubscription("u5", "w"))
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      "allowManualModelSelection",
      "allowedModes",
      "creditsRemaining",
      "creditsTotal",
      "creditsUsed",
      "tier",
    ].sort(),
  )
})

test("classifyUpstreamFailure maps 401/403 to invalid_api_key", () => {
  const r1 = classifyUpstreamFailure(401, "Unauthorized")
  assert.equal(r1.code, "invalid_api_key")
  assert.equal(r1.reason, BYOK_MESSAGES.invalid)

  const r2 = classifyUpstreamFailure(403, "Forbidden")
  assert.equal(r2.code, "invalid_api_key")

  const r3 = classifyUpstreamFailure(404, "model not found")
  assert.equal(r3.code, "model_unavailable")
  assert.equal(r3.reason, BYOK_MESSAGES.invalid)

  const r4 = classifyUpstreamFailure(500, "server error")
  assert.equal(r4.code, "other")
})

test("Manual mode with provider-qualified id parses the provider", () => {
  _resetLedgerForTests()
  setTier("enterprise")
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    manualModelSelection: { patch: "anthropic:claude-sonnet-4-6" },
    byokApiKey: "sk-user-key",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    // The Manual map's provider wins over the byokProvider default.
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-sonnet-4-6")
  }
})
