/**
 * v2 all-mode wiring regression tests.
 *
 * Focuses on the places that were broken in the first bundle:
 *   - Manual sends real model ids, not incompatible tier-only names.
 *   - Hosted/BYOK resolver returns the exact manual model selected.
 *   - Save refuses patch generation.
 *   - BYOK does not consume hosted credits.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  resolveAiProviderForRequest,
  recordConsumption,
} from "../lib/server-ai-provider-resolver"
import { _resetLedgerForTests, loadSubscription, planSummary } from "../lib/server-subscription"

function enterprise() {
  process.env.EDGE_AGENT_PLAN_TIER = "enterprise"
}

test("manual mode honours an actual provider-qualified model id", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    byokApiKey: "sk-user",
    manualModelSelection: {
      patch: "anthropic:claude-sonnet-4-5-20250929",
    },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-sonnet-4-5-20250929")
    assert.equal(r.apiKeySource, "byok")
  }
})

test("manual mode also accepts the old tier override format", () => {
  _resetLedgerForTests()
  enterprise()
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "byok",
    intelligenceMode: "manual",
    task: "patch",
    byokApiKey: "sk-user",
    byokProvider: "google",
    manualModelSelection: { patch: "coding_flagship" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "google")
    assert.equal(r.model, "gemini-2.5-pro")
  }
})

test("save mode refuses patch generation", () => {
  _resetLedgerForTests()
  process.env.EDGE_AGENT_PLAN_TIER = "free"
  process.env.EDGE_AGENT_HOSTED_OPENAI_KEY = "sk-hosted"
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    aiProviderMode: "hosted",
    intelligenceMode: "save",
    task: "patch",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, "task_not_allowed_in_mode")
})

test("hosted consumption reduces credits but BYOK does not", () => {
  _resetLedgerForTests()
  enterprise()
  const before = planSummary(loadSubscription("u2", "w")).creditsRemaining
  recordConsumption({ userId: "u2", workspaceId: "w", apiKeySource: "hosted", actualCostUsd: 0.02 })
  const afterHosted = planSummary(loadSubscription("u2", "w")).creditsRemaining
  assert.ok(afterHosted < before)
  recordConsumption({ userId: "u2", workspaceId: "w", apiKeySource: "byok", actualCostUsd: 1000 })
  const afterByok = planSummary(loadSubscription("u2", "w")).creditsRemaining
  assert.equal(afterByok, afterHosted)
})
