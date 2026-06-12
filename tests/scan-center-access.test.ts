/**
 * Scan Center access-control tests.
 *
 * Mode access depends on login + subscription tier:
 *
 *   1. Anonymous (no session)  → no hosted AI at all (every mode blocked
 *                                with not_authenticated; effective = save).
 *   2. free / starter          → Lite + Balanced (save, auto) only.
 *   3. pro                      → + Deep (save, auto, pro).
 *   4. team / enterprise (Max)  → all modes + Custom (manual).
 *
 * Plus the pure `effectiveAllowedModes` helper that the toggle consults,
 * and a source check that the UI passes `allowedModes` to the toggle.
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
import {
  _resetLedgerForTests,
  PLAN_ENTITLEMENTS,
} from "../lib/server-subscription"
import { effectiveAllowedModes, type PlanSummary } from "../lib/plan-client"

function setHostedKeys() {
  process.env.OPENAI_API_KEY = "sk-hosted-test"
  process.env.ANTHROPIC_API_KEY = "sk-hosted-test"
  process.env.GEMINI_API_KEY = "sk-hosted-test"
}

type Tier = "free" | "starter" | "pro" | "team" | "enterprise"

function setTier(tier: Tier) {
  process.env.EDGE_AGENT_PLAN_TIER = tier
  setHostedKeys()
  // Reset the store so the next loadSubscription re-reads the env tier.
  _resetLedgerForTests()
}

/** Resolve `mode` for a fresh user on the current tier. */
function resolveMode(mode: "save" | "auto" | "pro" | "max" | "manual") {
  return resolveAiProviderForRequest({
    userId: `u-${mode}`,
    workspaceId: `u-${mode}`,
    intelligenceMode: mode,
    task: "explain",
    manualModelSelection: mode === "manual" ? { explain: "openai:gpt-4.1-mini" } : undefined,
  })
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
// 2. Per-tier entitlements (the source of truth the resolver uses).
// ===================================================================

test("entitlements: free/starter allow Save + Auto only", () => {
  assert.deepEqual(PLAN_ENTITLEMENTS.free.allowedModes, ["save", "auto"])
  assert.deepEqual(PLAN_ENTITLEMENTS.starter.allowedModes, ["save", "auto"])
  assert.equal(PLAN_ENTITLEMENTS.free.allowManualModelSelection, false)
  assert.equal(PLAN_ENTITLEMENTS.starter.allowManualModelSelection, false)
})

test("entitlements: pro allows Save + Auto + Pro only", () => {
  assert.deepEqual(PLAN_ENTITLEMENTS.pro.allowedModes, ["save", "auto", "pro"])
  assert.equal(PLAN_ENTITLEMENTS.pro.allowManualModelSelection, false)
})

test("entitlements: team/enterprise (Max-tier) allow every mode + manual", () => {
  const all = ["save", "auto", "pro", "max", "manual"]
  assert.deepEqual(PLAN_ENTITLEMENTS.team.allowedModes, all)
  assert.deepEqual(PLAN_ENTITLEMENTS.enterprise.allowedModes, all)
  assert.equal(PLAN_ENTITLEMENTS.team.allowManualModelSelection, true)
  assert.equal(PLAN_ENTITLEMENTS.enterprise.allowManualModelSelection, true)
})

// ===================================================================
// 3. Resolver enforcement — free/starter (Save + Auto only).
// ===================================================================

test("free user: Save + Auto allowed; Pro/Max/Manual blocked (mode_not_in_plan)", () => {
  setTier("free")
  for (const mode of ["save", "auto"] as const) {
    const r = resolveMode(mode)
    // Save refuses patches but explain is allowed; both are "in plan".
    assert.equal(r.ok, true, `free must allow ${mode}`)
  }
  for (const mode of ["pro", "max", "manual"] as const) {
    const r = resolveMode(mode)
    assert.equal(r.ok, false, `free must NOT allow ${mode}`)
    if (!r.ok) assert.equal(r.code, "mode_not_in_plan", `${mode} must be mode_not_in_plan`)
  }
})

test("starter user: Pro/Max blocked the same as free", () => {
  setTier("starter")
  assert.equal(resolveMode("auto").ok, true)
  const pro = resolveMode("pro")
  assert.equal(pro.ok, false)
  if (!pro.ok) assert.equal(pro.code, "mode_not_in_plan")
})

// ===================================================================
// 4. Resolver enforcement — pro (Save + Auto + Pro).
// ===================================================================

test("pro user: Save/Auto/Pro allowed; Max/Manual blocked", () => {
  setTier("pro")
  for (const mode of ["save", "auto", "pro"] as const) {
    assert.equal(resolveMode(mode).ok, true, `pro must allow ${mode}`)
  }
  const max = resolveMode("max")
  assert.equal(max.ok, false, "pro must NOT allow Max")
  if (!max.ok) assert.equal(max.code, "mode_not_in_plan")

  const manual = resolveMode("manual")
  assert.equal(manual.ok, false, "pro must NOT allow Manual")
  if (!manual.ok) {
    // Manual is not in the pro plan at all → mode_not_in_plan (the spec
    // accepts manual_not_in_plan OR mode_not_in_plan).
    assert.ok(
      manual.code === "mode_not_in_plan" || manual.code === "manual_not_in_plan",
      `manual rejection must be a plan code, got ${manual.code}`,
    )
  }
})

// ===================================================================
// 5. Resolver enforcement — team/enterprise (Max-tier): everything.
// ===================================================================

test("team user (Max-tier): every mode allowed incl. Manual", () => {
  setTier("team")
  for (const mode of ["save", "auto", "pro", "max", "manual"] as const) {
    assert.equal(resolveMode(mode).ok, true, `team must allow ${mode}`)
  }
})

test("enterprise user (Max-tier): every mode allowed incl. Manual", () => {
  setTier("enterprise")
  for (const mode of ["save", "auto", "pro", "max", "manual"] as const) {
    assert.equal(resolveMode(mode).ok, true, `enterprise must allow ${mode}`)
  }
})

// ===================================================================
// 6. effectiveAllowedModes mirrors the plan for signed-in users.
// ===================================================================

test("effectiveAllowedModes: signed-in users get exactly their plan's modes", () => {
  const freePlan = { allowedModes: ["save", "auto"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(true, freePlan), ["save", "auto"])

  const proPlan = { allowedModes: ["save", "auto", "pro"] } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(true, proPlan), ["save", "auto", "pro"])

  const maxPlan = {
    allowedModes: ["save", "auto", "pro", "max", "manual"],
  } as unknown as PlanSummary
  assert.deepEqual(effectiveAllowedModes(true, maxPlan), [
    "save",
    "auto",
    "pro",
    "max",
    "manual",
  ])

  // No plan loaded yet but authenticated → conservative save-only (no
  // optimistic unlock; the server still enforces).
  assert.deepEqual(effectiveAllowedModes(true, null), ["save"])
})

// ===================================================================
// 7. UI wiring — Scan Center and Findings pass allowedModes to the toggle.
// ===================================================================

test("UI: Scan Center and Findings pass allowedModes to IntelligenceModeToggle", () => {
  const scanSrc = fs.readFileSync(
    path.join(process.cwd(), "components/views/scan-center.tsx"),
    "utf8",
  )
  const findingsSrc = fs.readFileSync(
    path.join(process.cwd(), "components/views/findings.tsx"),
    "utf8",
  )
  assert.match(scanSrc, /allowedModes=\{allowedModes\}/, "Scan Center must gate the toggle")
  assert.match(findingsSrc, /allowedModes=\{allowedModes\}/, "Findings must gate the toggle")
})
