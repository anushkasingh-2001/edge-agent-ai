/**
 * Step 2 tests — the patch pipeline now routes the model by intelligence
 * mode + complexity (routeForMode), not by fix_class alone (routeModel).
 *
 * routeForMode is pure, so we assert the mode→tier→model contract that
 * the pipeline consumes. (The pipeline itself does real temp-workspace
 * I/O + scanner runs, so model-selection is verified at this boundary;
 * an integration test with a mocked callLlm is tracked for later.)
 *
 * Run with:
 *   node --import tsx/esm --test tests/step2-mode-routing.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { routeForMode } from "../lib/server-model-router-ext"

test("Auto escalates tier by complexity for patch", () => {
  const lo = routeForMode({ mode: "auto", task: "patch", complexity: 0.1, provider: "openai_compatible" })
  const hi = routeForMode({ mode: "auto", task: "patch", complexity: 0.85, provider: "openai_compatible" })
  assert.notEqual(lo.tier, hi.tier, "low and high complexity must pick different tiers")
  assert.equal(hi.tier, "coding_flagship")
  assert.equal(hi.twoStep, true, "high-complexity Auto patch is plan-then-diff")
})

test("Pro always uses the flagship tier regardless of complexity", () => {
  const a = routeForMode({ mode: "pro", task: "patch", complexity: 0.05, provider: "google" })
  const b = routeForMode({ mode: "pro", task: "patch", complexity: 0.95, provider: "google" })
  assert.equal(a.tier, "coding_flagship")
  assert.equal(b.tier, "coding_flagship")
  assert.equal(a.bundleMode, "pro")
})

test("Manual per-task override wins over mode default", () => {
  const r = routeForMode({
    mode: "manual",
    task: "patch",
    complexity: 0.1,
    provider: "anthropic",
    manual: { patch: "mid" },
  })
  assert.equal(r.tier, "mid")
})

test("routeForMode resolves a concrete model id for every wired provider", () => {
  for (const provider of ["openai_compatible", "anthropic", "google", "custom"] as const) {
    const r = routeForMode({ mode: "pro", task: "patch", complexity: 0.5, provider })
    assert.ok(typeof r.model === "string" && r.model.length > 0, `no model for ${provider}`)
  }
})

test("bundleMode is carried so Step 4 can size the context per mode", () => {
  assert.equal(
    routeForMode({ mode: "save", task: "explain", complexity: 0, provider: "openai_compatible" }).bundleMode,
    "save-explain",
  )
  assert.equal(
    routeForMode({ mode: "max", task: "patch", complexity: 0.9, provider: "anthropic" }).bundleMode,
    "max-patch",
  )
})
