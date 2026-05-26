/**
 * Step 6 tests — Max plan→patch→validate (Q8).
 *
 *   - validatePatchPlan: accepts a complete plan; rejects missing
 *     fields / empty files_to_change / non-objects.
 *   - renderPlanForPatch: emits an APPROVED PATCH PLAN prefix.
 *   - twoStep decision: Max patch is always two-step; Auto patch is
 *     two-step only at high complexity. The pipeline issues the plan
 *     call when decision.twoStep is true (then validates parse/test/
 *     re-scan as before).
 *
 * The plan phase degrades gracefully: a failed or invalid plan falls
 * back to single-shot patch rather than refusing.
 *
 * Run with:
 *   node --import tsx/esm --test tests/step6-max-plan.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  validatePatchPlan,
  renderPlanForPatch,
  type PatchPlan,
} from "../lib/server-patch-pipeline"
import { routeForMode } from "../lib/server-model-router-ext"

const GOOD: PatchPlan = {
  problem_statement: "Cypher injection from model output",
  root_cause: "f-string query built from completion content",
  invariants_to_preserve: ["query still returns the matched node"],
  guard_to_add: "parameterize the Cypher query",
  files_to_change: ["agent.py"],
}

test("validatePatchPlan accepts a complete plan", () => {
  const r = validatePatchPlan(GOOD)
  assert.equal(r.ok, true)
})

test("validatePatchPlan rejects incomplete / empty-files / non-object", () => {
  assert.equal(validatePatchPlan({ problem_statement: "x" }).ok, false)
  assert.equal(validatePatchPlan({ ...GOOD, files_to_change: [] }).ok, false)
  assert.equal(validatePatchPlan(null).ok, false)
  assert.equal(validatePatchPlan({ ...GOOD, guard_to_add: "" }).ok, false)
})

test("renderPlanForPatch emits an approved-plan prefix", () => {
  const prefix = renderPlanForPatch(GOOD)
  assert.ok(prefix.includes("APPROVED PATCH PLAN"))
  assert.ok(prefix.includes("parameterize the Cypher query"))
  assert.ok(prefix.includes("agent.py"))
})

test("Max patch is always two-step (plan→patch)", () => {
  for (const complexity of [0.05, 0.5, 0.95]) {
    assert.equal(
      routeForMode({ mode: "max", task: "patch", complexity, provider: "anthropic" }).twoStep,
      true,
    )
  }
})

test("Auto patch is two-step only at high complexity", () => {
  assert.equal(
    routeForMode({ mode: "auto", task: "patch", complexity: 0.1, provider: "openai_compatible" }).twoStep,
    false,
  )
  assert.equal(
    routeForMode({ mode: "auto", task: "patch", complexity: 0.85, provider: "openai_compatible" }).twoStep,
    true,
  )
})

test("Pro patch is single-shot (large context, no plan phase)", () => {
  assert.equal(
    routeForMode({ mode: "pro", task: "patch", complexity: 0.9, provider: "google" }).twoStep,
    false,
  )
})
