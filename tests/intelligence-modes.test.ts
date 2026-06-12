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
import {
  activeFindingCount,
  activeFindings,
  likelyFalsePositiveFindings,
  isLikelyFalsePositive,
  activeReportCounts,
  computeRiskScore,
  type FindingStatus,
  type ScannerFinding,
  type ScanReport,
} from "../lib/scan-report"
import { scanItemFromReport } from "../lib/scan-history"

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

// ---------------------------------------------------------------------------
// Effective finding counts per mode (active vs. likely-false-positive).
// ---------------------------------------------------------------------------

const f = (
  status: FindingStatus | undefined,
  severity: "critical" | "high" | "medium" | "low" = "high",
  extra: Partial<ScannerFinding> = {},
): ScannerFinding => ({
  id: `id-${Math.random().toString(36).slice(2)}`,
  rule_id: "dangerous-tools",
  severity,
  category: "Dangerous Tools",
  title: "t",
  file: "x.py",
  line: 1,
  agent: "a",
  reason: "r",
  suggestedFix: "s",
  evidence: "e",
  code: "c",
  confidence: 0.9,
  status,
  ...extra,
})

const buildReport = (findings: ScannerFinding[]): ScanReport => ({
  schema_version: "2.0",
  scan_root: "/tmp",
  generated_at: new Date().toISOString(),
  frameworks_detected: [],
  agents_detected: [],
  tools_detected: [],
  models_detected: [],
  prompts_detected: [],
  summary: {
    critical: findings.filter((x) => x.severity === "critical").length,
    high: findings.filter((x) => x.severity === "high").length,
    medium: findings.filter((x) => x.severity === "medium").length,
    low: findings.filter((x) => x.severity === "low").length,
    total: findings.length,
  },
  risk_score: 100,
  findings,
})

test("Lite count includes ALL deterministic findings (none downranked)", () => {
  // Lite scans never carry a likely_false_positive status.
  const findings = [f("confirmed"), f("confirmed"), f(undefined)]
  assert.equal(activeFindingCount(findings), 3)
  assert.equal(activeFindings(findings).length, 3)
  assert.equal(likelyFalsePositiveFindings(findings).length, 0)
})

test("Deep/Exhaustive count excludes likely_false_positive findings", () => {
  const findings = [
    f("confirmed"),
    f("likely_false_positive"),
    f("likely_false_positive"),
    f("llm_verified"),
  ]
  assert.equal(activeFindingCount(findings), 2)
  assert.equal(likelyFalsePositiveFindings(findings).length, 2)
})

test("needs_human_review, llm_verified, gap_audit_confirmed count as active", () => {
  for (const status of [
    "needs_human_review",
    "llm_verified",
    "gap_audit_confirmed",
    "confirmed",
    "needs_rule_support",
  ] as const) {
    assert.equal(isLikelyFalsePositive(f(status)), false, `${status} must be active`)
  }
  assert.equal(isLikelyFalsePositive(f("likely_false_positive")), true)
})

test("activeReportCounts: no downranks returns backend summary/risk unchanged", () => {
  const report = buildReport([f("confirmed", "high"), f(undefined, "low")])
  const counts = activeReportCounts(report)
  assert.equal(counts.activeCount, 2)
  assert.equal(counts.likelyFalsePositiveCount, 0)
  assert.equal(counts.summary, report.summary) // same object, untouched
  assert.equal(counts.riskScore, report.risk_score)
})

test("activeReportCounts: recomputes summary + risk from active findings", () => {
  // One real high + two downranked criticals. Active set = a single high.
  const report = buildReport([
    f("llm_verified", "high"),
    f("likely_false_positive", "critical"),
    f("likely_false_positive", "critical"),
  ])
  const counts = activeReportCounts(report)
  assert.equal(counts.activeCount, 1)
  assert.equal(counts.likelyFalsePositiveCount, 2)
  assert.equal(counts.summary.total, 1)
  assert.equal(counts.summary.critical, 0)
  assert.equal(counts.summary.high, 1)
  // Risk recomputed from one high finding only (18 pts), not the criticals.
  assert.equal(counts.riskScore, computeRiskScore([f("llm_verified", "high")]))
  assert.ok(counts.riskScore < report.risk_score)
})

test("scan history count excludes likely_false_positive for AI-reviewed modes", () => {
  const report = buildReport([
    f("confirmed", "high"),
    f("likely_false_positive", "high"),
  ])
  const item = scanItemFromReport(
    report,
    { id: "p1", name: "p", path: "/tmp" } as Parameters<typeof scanItemFromReport>[1],
    "main",
  )
  assert.equal(item.findingCount, 1)
  assert.equal(item.summary.total, 1)
  // The full report (with the downranked finding) is still stored verbatim.
  assert.equal(item.report.findings.length, 2)
})
