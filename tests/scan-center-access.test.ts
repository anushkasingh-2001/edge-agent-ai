/**
 * Scan Center access-control tests.
 *
 * Covers the three states from the access spec:
 *
 *   1. Anonymous (no session)        → no hosted AI at all (every mode
 *                                       blocked with not_authenticated).
 *   2. Logged-in free user           → Auto allowed; Pro/Max/Manual locked.
 *   3. Paid user (pro / team)        → modes unlock per the saved tier.
 *
 * Plus the pure `effectiveAllowedModes` helper that the toggle consults.
 *
 * The resolver is the server-side source of truth; the UI mirrors it.
 * We isolate the file billing store under a temp EDGE_AGENT_HOME so the
 * test never touches the developer's real billing.json.
 *
 * Run with:
 *   node --import tsx --test tests/scan-center-access.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Isolate the file store BEFORE importing modules that resolve appDir().
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "eaai-access-"))
process.env.EDGE_AGENT_HOME = TMP_HOME

import { resolveAiProviderForRequest } from "../lib/server-ai-provider-resolver"
import { _resetLedgerForTests } from "../lib/server-subscription"
import { effectiveAllowedModes, type PlanSummary } from "../lib/plan-client"

function setHostedKeys() {
  process.env.OPENAI_API_KEY = "sk-hosted-test"
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  process.env.GEMINI_API_KEY = "sk-hosted-test"
}

function setTier(tier: "free" | "starter" | "pro" | "team" | "enterprise") {
  process.env.EDGE_AGENT_PLAN_TIER = tier
}

// ===================================================================
// 1. Anonymous — hosted AI is fully blocked (no credits ever spent).
// ===================================================================

test("anonymous: every AI mode is blocked with not_authenticated", () => {
  setHostedKeys()
  for (const mode of ["auto", "pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "",
      workspaceId: "",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, false, `anonymous must not access ${mode}`)
    if (!r.ok) assert.equal(r.code, "not_authenticated")
  }
})

test("anonymous: effective modes are deterministic-only (save)", () => {
  assert.deepEqual(effectiveAllowedModes(false, null), ["save"])
  // Even if a plan object leaks through, anonymous stays save-only.
  const proPlan = { allowedModes: ["save", "auto", "pro"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(false, proPlan), ["save"])
})

// ===================================================================
// 2. Logged-in free user — Auto on; Pro/Max/Manual locked.
// ===================================================================

test("free user: Auto allowed, Pro/Max/Manual blocked (mode_not_in_plan)", () => {
  setTier("free")
  setHostedKeys()
  _resetLedgerForTests()

  const auto = resolveAiProviderForRequest({
    userId: "u-free",
    workspaceId: "u-free",
    intelligenceMode: "auto",
    task: "explain",
  })
  assert.equal(auto.ok, true, "free plan must allow Auto")

  for (const mode of ["pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-free",
      workspaceId: "u-free",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, false, `free plan must block ${mode}`)
    if (!r.ok) assert.equal(r.code, "mode_not_in_plan")
  }
})

test("free user: effective modes are save + auto", () => {
  const freePlan = { allowedModes: ["save", "auto"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(true, freePlan), ["save", "auto"])
  // No plan loaded yet but authenticated → optimistic save+auto.
  assert.deepEqual(effectiveAllowedModes(true, null), ["save", "auto"])
})

// ===================================================================
// 3. Paid user — modes unlock per the saved tier.
// ===================================================================

test("paid pro user: Pro allowed, Max/Manual still locked", () => {
  setTier("pro")
  setHostedKeys()
  _resetLedgerForTests()

  for (const mode of ["auto", "pro"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-pro",
      workspaceId: "u-pro",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, true, `pro plan must allow ${mode}`)
  }
  for (const mode of ["max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-pro",
      workspaceId: "u-pro",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, false, `pro plan must block ${mode}`)
    if (!r.ok) assert.equal(r.code, "mode_not_in_plan")
  }
})

test("paid team user: Max unlocked", () => {
  setTier("team")
  setHostedKeys()
  _resetLedgerForTests()

  const max = resolveAiProviderForRequest({
    userId: "u-team",
    workspaceId: "u-team",
    intelligenceMode: "max",
    task: "explain",
  })
  assert.equal(max.ok, true, "team plan must allow Max")

  const manual = resolveAiProviderForRequest({
    userId: "u-team",
    workspaceId: "u-team",
    intelligenceMode: "manual",
    task: "explain",
  })
  assert.equal(manual.ok, false, "team plan must still block Manual")
})

test("effectiveAllowedModes reflects the plan tier for signed-in users", () => {
  const proPlan = { allowedModes: ["save", "auto", "pro"] } as unknown as PlanSummary
  const modes = effectiveAllowedModes(true, proPlan)
  assert.ok(modes.includes("pro"))
  assert.ok(!modes.includes("max"))
})
