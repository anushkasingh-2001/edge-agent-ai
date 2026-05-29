/**
 * Anthropic model catalog + intelligence-mode mapping tests.
 *
 * Pins the contract introduced in the BYOK-only MVP:
 *
 *   - The Anthropic catalog exposes ONLY the three current default
 *     Claude models (claude-haiku-4-5, claude-sonnet-4-6,
 *     claude-opus-4-7). Legacy ids like claude-3-7-sonnet-latest
 *     must not appear in the dropdown — users who really need them
 *     can still type via "Custom model name…".
 *   - Intelligence-mode → Anthropic model mapping:
 *       Save  → claude-haiku-4-5
 *       Auto  → claude-sonnet-4-6
 *       Pro   → claude-sonnet-4-6
 *       Max   → claude-opus-4-7
 *       Manual → user-selected exact model id
 *   - The cost-controller has prices for the three new ids and does
 *     NOT carry the removed legacy ones (the fallback price still
 *     applies if a user types an unknown id).
 *
 * Run with:
 *   node --import tsx --test tests/anthropic-models.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { MODEL_CATALOG } from "../lib/model-catalog"
import { routeForMode } from "../lib/server-model-router-ext"
import { resolveAiProviderForRequest } from "../lib/server-ai-provider-resolver"
import { MODEL_PRICING } from "../lib/server-cost-controller"

function enterprise() {
  ;(process.env as Record<string, string | undefined>).EDGE_AGENT_PLAN_TIER = "enterprise"
}

// ===================================================================
// 1. Catalog only exposes the three current Anthropic ids
// ===================================================================

test("Anthropic catalog only lists the three current Claude defaults", () => {
  const ids = MODEL_CATALOG.anthropic.map((m) => m.id).sort()
  assert.deepEqual(
    ids,
    ["claude-haiku-4-5", "claude-opus-4-7", "claude-sonnet-4-6"],
    "catalog must contain exactly the three default Anthropic models",
  )
})

test("Anthropic catalog does NOT list any legacy claude-3-* model", () => {
  const ids = MODEL_CATALOG.anthropic.map((m) => m.id)
  for (const banned of [
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-20240229",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5-20250929",
  ]) {
    assert.equal(
      ids.includes(banned),
      false,
      `${banned} must not be in the default Anthropic dropdown`,
    )
  }
})

// ===================================================================
// 2. Intelligence-mode → Anthropic model mapping
// ===================================================================

test("Save mode → claude-haiku-4-5 (Anthropic)", () => {
  const r = routeForMode({
    mode: "save",
    task: "explain",
    complexity: 0.5,
    provider: "anthropic",
  })
  assert.equal(r.model, "claude-haiku-4-5")
})

test("Auto mode (mid bucket) → claude-sonnet-4-6 (Anthropic)", () => {
  const r = routeForMode({
    mode: "auto",
    task: "patch",
    complexity: 0.5,
    provider: "anthropic",
  })
  assert.equal(r.model, "claude-sonnet-4-6")
})

test("Pro mode → claude-sonnet-4-6 (Anthropic), single-shot", () => {
  const r = routeForMode({
    mode: "pro",
    task: "patch",
    complexity: 0.9,
    provider: "anthropic",
  })
  assert.equal(r.model, "claude-sonnet-4-6")
  assert.equal(r.twoStep, false, "Pro is single-shot")
})

test("Max mode → claude-opus-4-7 (Anthropic), two-step", () => {
  const r = routeForMode({
    mode: "max",
    task: "patch",
    complexity: 0.1,
    provider: "anthropic",
  })
  assert.equal(
    r.model,
    "claude-opus-4-7",
    "Max upgrades coding_flagship to Opus 4.7 for Anthropic",
  )
  assert.equal(r.twoStep, true, "Max patch is two-step plan→patch")
  // The cascade escalation target must NOT silently drop back to
  // Sonnet — Max stays on Opus throughout the cascade.
  assert.equal(r.escalatedModel, "claude-opus-4-7")
})

test("Manual mode honours the exact Anthropic id from the user", () => {
  enterprise()
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "manual",
    task: "patch",
    manualModelSelection: { patch: "anthropic:claude-haiku-4-5" },
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.provider, "anthropic")
    assert.equal(r.model, "claude-haiku-4-5", "Manual must not be overridden by Max upgrade")
  }
})

test("Max + Manual on Anthropic uses the user pick, not the auto-opus override", () => {
  enterprise()
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  // A user explicitly picking Sonnet in Manual mode under Max must
  // get Sonnet — the Max→Opus override only fires for the auto tier
  // lookup, never for an explicit Manual id.
  const r = resolveAiProviderForRequest({
    userId: "u",
    workspaceId: "w",
    intelligenceMode: "manual",
    task: "patch",
    manualModelSelection: { patch: "anthropic:claude-sonnet-4-6" },
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.model, "claude-sonnet-4-6")
})

// ===================================================================
// 3. Pricing covers the new ids and skips the removed legacy ones
// ===================================================================

test("MODEL_PRICING has entries for the three new Anthropic ids", () => {
  assert.ok(MODEL_PRICING["claude-haiku-4-5"], "haiku 4.5 must be priced")
  assert.ok(MODEL_PRICING["claude-sonnet-4-6"], "sonnet 4.6 must be priced")
  assert.ok(MODEL_PRICING["claude-opus-4-7"], "opus 4.7 must be priced")
  // Opus must be the most expensive of the three so the cost
  // estimate UI ranks them correctly.
  const haiku = MODEL_PRICING["claude-haiku-4-5"].outputPer1k
  const sonnet = MODEL_PRICING["claude-sonnet-4-6"].outputPer1k
  const opus = MODEL_PRICING["claude-opus-4-7"].outputPer1k
  assert.ok(haiku < sonnet)
  assert.ok(sonnet < opus)
})

test("MODEL_PRICING does NOT carry the removed legacy Anthropic ids", () => {
  for (const banned of [
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-20240229",
    "claude-opus-4-1-20250805",
    "claude-sonnet-4-5-20250929",
  ]) {
    assert.equal(
      MODEL_PRICING[banned],
      undefined,
      `${banned} must not have an explicit price entry`,
    )
  }
})
