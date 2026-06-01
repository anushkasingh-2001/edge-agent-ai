/**
 * Scan Center access-control tests.
 *
 * Modes are NOT plan-gated. The only access rule is sign-in:
 *
 *   1. Anonymous (no session)  → no hosted AI at all (every mode blocked
 *                                with not_authenticated; effective = save).
 *   2. Any signed-in user      → EVERY mode runs (free included). A heavier
 *                                mode just spends more credits; the plan tier
 *                                governs the credit allowance, not access.
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
  const anyPlan = { allowedModes: ["save", "auto", "pro"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(false, anyPlan), ["save"])
})

// ===================================================================
// 2. Any signed-in user — every mode runs (modes are credit-priced).
// ===================================================================

test("free user: EVERY mode is allowed (not plan-gated)", () => {
  setTier("free")
  setHostedKeys()
  _resetLedgerForTests()

  for (const mode of ["save", "auto", "pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-free",
      workspaceId: "u-free",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, true, `free plan must allow ${mode}`)
  }
})

test("paid pro user: every mode allowed too", () => {
  setTier("pro")
  setHostedKeys()
  _resetLedgerForTests()

  for (const mode of ["save", "auto", "pro", "max", "manual"] as const) {
    const r = resolveAiProviderForRequest({
      userId: "u-pro",
      workspaceId: "u-pro",
      intelligenceMode: mode,
      task: "explain",
    })
    assert.equal(r.ok, true, `pro plan must allow ${mode}`)
  }
})

// ===================================================================
// 3. effectiveAllowedModes — all modes for any signed-in user.
// ===================================================================

test("effectiveAllowedModes: signed-in users get every mode regardless of tier", () => {
  const all = ["save", "auto", "pro", "max", "manual"]
  // Plan tier doesn't matter — modes are not gated by it.
  const freePlan = { allowedModes: ["save", "auto"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(true, freePlan), all)
  // No plan loaded yet but authenticated → still all modes.
  assert.deepEqual(effectiveAllowedModes(true, null), all)
})
