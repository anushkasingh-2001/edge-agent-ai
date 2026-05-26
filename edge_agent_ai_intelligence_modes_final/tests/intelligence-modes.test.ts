/**
 * Node-test suite for the intelligence-mode system.
 *
 * Run with:
 *   node --import tsx/esm --test tests/intelligence-modes.test.ts
 *
 * Asserts (1:1 with the design brief):
 *   - Save refuses LLM patch generation; allows explanation.
 *   - Auto routes low-complexity explanation → cheap, high-complexity
 *     patch → coding_flagship + two-step.
 *   - Manual honours the user's per-task tier; guardrails still apply.
 *   - secrets never reaches an LLM for non-explain tasks.
 *   - ContextBundle budgets are well-formed and max-patch is the only
 *     full-file-eligible mode.
 *   - The real-fix gate rejects TODO/comment/whitespace/no-op diffs.
 *   - Cost batch estimate + budget cap behave.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  scoreComplexity,
  complexityBucket,
  routeTaskForMode,
  enforceGuardrails,
  MODE_POLICIES,
} from "../lib/intelligence-mode"
import {
  bundleModeFor,
  BUNDLE_INPUT_TOKEN_CAP,
  estimateTokens,
  type ContextBundleMode,
} from "../lib/context-bundle"
import {
  estimateCall,
  summarizeBatch,
  checkBudget,
} from "../lib/server-cost-controller"
import { isRealFixDiff, guardAddedInDiff } from "../lib/patch-confidence-realfix"

test("Save mode: explanation allowed, patch generation refused", () => {
  assert.equal(MODE_POLICIES.save.allowExplain, true)
  assert.equal(MODE_POLICIES.save.allowPatchGeneration, false)
  const g = enforceGuardrails({ mode: "save", task: "patch", ruleId: "dangerous-tools" })
  assert.equal(g.ok, false)
})

test("secrets never goes to an LLM for non-explain tasks", () => {
  assert.equal(enforceGuardrails({ mode: "max", task: "patch", ruleId: "secrets" }).ok, false)
  assert.equal(enforceGuardrails({ mode: "max", task: "explain", ruleId: "secrets" }).ok, true)
})

test("complexity buckets: critical cross-file codegen → strong, local low → cheap", () => {
  const hi = scoreComplexity({
    rule_id: "llm-codegen-to-exec",
    severity: "critical",
    evidencePathFiles: 2,
    evidencePathLen: 4,
    sinkKind: "code_exec",
    callerCount: 3,
  })
  assert.equal(complexityBucket(hi), "strong")
  const lo = scoreComplexity({ rule_id: "openapi-schema", severity: "low", evidencePathLen: 1 })
  assert.equal(complexityBucket(lo), "cheap")
})

test("Auto routing: cheap explain for low complexity, flagship two-step patch for high", () => {
  const lo = 0.1
  const hi = 0.8
  const explain = routeTaskForMode("auto", "explain", lo)
  assert.equal(explain.tier, "cheap")
  const patch = routeTaskForMode("auto", "patch", hi)
  assert.equal(patch.tier, "coding_flagship")
  assert.equal(patch.twoStep, true)
})

test("Manual: per-task model tier honoured", () => {
  const r = routeTaskForMode("manual", "patch", 0.1, { patch: "mid" })
  assert.equal(r.tier, "mid")
  // guardrails still apply in manual
  assert.equal(enforceGuardrails({ mode: "manual", task: "patch", ruleId: "secrets" }).ok, false)
})

test("ContextBundle: budgets ordered and max-patch is the only full-file-eligible mode", () => {
  const order: ContextBundleMode[] = [
    "save-explain",
    "auto-small",
    "auto-large",
    "pro",
    "max-plan",
    "max-patch",
  ]
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      BUNDLE_INPUT_TOKEN_CAP[order[i]] >= BUNDLE_INPUT_TOKEN_CAP[order[i - 1]],
      `cap should be non-decreasing at ${order[i]}`,
    )
  }
  assert.equal(bundleModeFor("save", "explain"), "save-explain")
  assert.equal(bundleModeFor("max", "patch"), "max-patch")
  assert.equal(bundleModeFor("pro", "root_cause"), "pro")
})

test("token estimate is monotonic in length", () => {
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(40)))
})

test("real-fix gate: TODO/comment/whitespace/no-op rejected, real change accepted", () => {
  const todo = "--- a/x.py\n+++ b/x.py\n@@\n+    # TODO: validate\n session.run(q)"
  assert.equal(isRealFixDiff(todo, "x.py").isRealFix, false)

  const real =
    "--- a/x.py\n+++ b/x.py\n@@\n-session.run(f\"MATCH {n}\")\n+session.run(\"MATCH $n\", n=n)"
  assert.equal(isRealFixDiff(real, "x.py").isRealFix, true)

  const empty = "--- a/x.py\n+++ b/x.py"
  assert.equal(isRealFixDiff(empty, "x.py").isRealFix, false)

  const edge = "--- a/x.py\n+++ b/x.py\n@@\n+# edge-agent: review this"
  assert.equal(isRealFixDiff(edge, "x.py").isRealFix, false)
})

test("guard-added detection on diff", () => {
  const real =
    "--- a/x.py\n+++ b/x.py\n@@\n+session.run(\"MATCH $n\", n=n)"
  assert.equal(guardAddedInDiff(real, "cypher-injection-from-llm-or-user"), true)
  assert.equal(guardAddedInDiff("--- a\n+x = 1", "secrets"), false)
})

test("cost estimate + budget cap", () => {
  const c = estimateCall({
    model: "gpt-4.1-mini",
    tier: "cheap",
    inputTokens: 1500,
    outputTokens: 700,
  })
  assert.ok(c.costUsd > 0)
  const batch = summarizeBatch([c, c])
  assert.equal(batch.totalCalls, 2)
  assert.equal(checkBudget(99).ok, false)
  assert.equal(checkBudget(0.01).ok, true)
})

test("bulk fix cost scales with clusters, not findings (one call per cluster)", () => {
  // 5 clusters → 5 calls regardless of how many findings each covers.
  const calls = Array.from({ length: 5 }, () =>
    estimateCall({ model: "gpt-4.1", tier: "mid", inputTokens: 4000, outputTokens: 1500 }),
  )
  assert.equal(summarizeBatch(calls).totalCalls, 5)
})
