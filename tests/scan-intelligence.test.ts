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
import { selectClustersForMode } from "../lib/scan-intelligence/select-clusters"
import { buildClusterContextBundle } from "../lib/scan-intelligence/build-scan-context-bundle"
import { confirmCandidate } from "../lib/scan-intelligence/deterministic-confirmation"
import { enhanceScanReport } from "../lib/scan-intelligence/enhance-scan-report"
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
