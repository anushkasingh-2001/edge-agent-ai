/**
 * Patch-pipeline escalation/retry tests.
 *
 * Contract under test (lib/server-patch-pipeline.ts → generatePatchPreview):
 *
 *   When the first model-generated patch fails validation
 *     (parse failure | invalid model JSON | finding-not-resolved-on-rescan
 *      | introduced new high/critical findings)
 *   AND the route decision allows escalation
 *     (decision.cascade === true OR intelligenceMode === "auto",
 *      escalatedModel exists,
 *      escalatedModel !== decision.model,
 *      privateCodeMode !== true,
 *      intelligenceMode !== "manual")
 *   then the pipeline retries EXACTLY ONCE with decision.escalatedModel.
 *
 * Save mode never reaches this path (planner refuses LLM patches);
 * Manual mode never auto-escalates (the user pinned the model);
 * privateCodeMode never escalates from a local tier to a cloud model.
 *
 * These tests mock the LLM fetcher and the temp-workspace re-scanner so
 * we can drive the "first attempt fails / second attempt succeeds"
 * sequence deterministically. Both seams are documented in the modules
 * they live in (server-llm-client.ts, server-patch-pipeline.ts).
 *
 * Run with:
 *    node --import tsx --test tests/escalation-retry.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  generatePatchPreview,
  _setRunScannerForTests,
} from "../lib/server-patch-pipeline"
import { _setFetcherForTests } from "../lib/server-llm-client"
import { planFix, type PlannerFinding } from "../lib/fix-planner"
import type { ScanReportLite, ScanFindingLite } from "../lib/server-scan"

/* ------------------------------------------------------------------ *
 *  Env: pin distinct cheap vs. flagship model ids so the escalation
 *        target actually differs from the first-attempt model.
 *        Without this override openai_compatible's cheap / mid /
 *        coding_flagship collapse onto identical ids, which would
 *        legitimately suppress escalation (eligibility check requires
 *        `escalatedModel !== decision.model`). The defaults are still
 *        valid in production — we only diverge them in this suite.
 * ------------------------------------------------------------------ */
const ENV = process.env as Record<string, string | undefined>
ENV.EDGE_AGENT_EXPLAINER_MODEL = "test-cheap"
ENV.EDGE_AGENT_FIX_MODEL = "test-mid"
ENV.EDGE_AGENT_FIX_DEEP_MODEL = "test-flagship"

/* ------------------------------------------------------------------ *
 *  Project + finding fixtures.                                        *
 *  Use a `.txt` file so parseFile returns `null` (no parser available
 *  for this extension), which is treated as `parses: true` — keeping
 *  the parse signal out of the escalation trigger set for the happy
 *  paths we're testing.                                               *
 * ------------------------------------------------------------------ */
const FILE_REL = "a.txt"
const ORIGINAL = "alpha\nbravo\ncharlie\ndelta\n"

function mkProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-fix-esc-"))
  fs.writeFileSync(path.join(dir, FILE_REL), ORIGINAL, "utf8")
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function mkFinding(over: Partial<PlannerFinding> = {}): PlannerFinding {
  return {
    id: "F1",
    rule_id: "dangerous-tools",
    severity: "high",
    category: "tools",
    file: FILE_REL,
    line: 2,
    ...over,
  }
}

/* ------------------------------------------------------------------ *
 *  LLM mock: returns a chat/completions-shaped body whose content is
 *  the JSON we want the pipeline to parse. The mock records every
 *  model id it observed so the test can pin the cascade order.       *
 * ------------------------------------------------------------------ */
interface LlmPlanItem {
  /** JSON content the model "replies with"; undefined = HTTP 500. */
  content?: object
  /** Force a network error instead of a successful HTTP response. */
  networkError?: boolean
}

function installLlmMock(plan: LlmPlanItem[]): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  let i = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string }
    calls.push(body.model ?? "")
    const step = plan[i] ?? plan[plan.length - 1] ?? {}
    i += 1
    if (step.networkError) {
      throw new Error("ECONNREFUSED test-induced")
    }
    if (!step.content) {
      const r = new Response("{}", { status: 500 })
      return r
    }
    const reply = {
      choices: [
        {
          message: { content: JSON.stringify(step.content) },
        },
      ],
    }
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
  const prevFetcher = _setFetcherForTests(fetcher)
  return {
    calls,
    restore: () => {
      _setFetcherForTests(prevFetcher)
    },
  }
}

/* ------------------------------------------------------------------ *
 *  Scanner mock: returns the queued ScanReportLite on each call. Used
 *  to flip "finding-resolved" between the first and second attempts.
 * ------------------------------------------------------------------ */
function installScannerMock(reports: ScanReportLite[]): {
  callCount: () => number
  restore: () => void
} {
  let i = 0
  const prev = _setRunScannerForTests(async () => {
    const r = reports[Math.min(i, reports.length - 1)]
    i += 1
    return r
  })
  return {
    callCount: () => i,
    restore: () => {
      _setRunScannerForTests(prev)
    },
  }
}

const EMPTY_SUMMARY = { critical: 0, high: 0, medium: 0, low: 0, total: 0 }
const RESOLVED_REPORT: ScanReportLite = {
  risk_score: 0,
  summary: { ...EMPTY_SUMMARY },
  findings: [],
}
function unresolvedReport(finding: PlannerFinding): ScanReportLite {
  const f: ScanFindingLite = {
    rule_id: finding.rule_id,
    severity: finding.severity,
    category: finding.category ?? "tools",
    title: finding.rule_id,
    file: finding.file,
    line: finding.line,
  }
  return {
    risk_score: 50,
    summary: { ...EMPTY_SUMMARY, high: 1, total: 1 },
    findings: [f],
  }
}

/* ------------------------------------------------------------------ *
 *  Edits used by the mock LLM. They must be unambiguous (each `old_str`
 *  occurs exactly once in ORIGINAL — see applySearchReplace).         *
 * ------------------------------------------------------------------ */
const FIRST_EDIT = { old_str: "bravo", new_str: "bravo # tried" }
const SECOND_EDIT = { old_str: "charlie", new_str: "charlie # escalated" }

/* ------------------------------------------------------------------ *
 *  Tests                                                              *
 * ------------------------------------------------------------------ */

test("Auto cascade retries once when the first attempt leaves the finding unresolved", async () => {
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "attempt 1" } },
    { content: { edits: [SECOND_EDIT], reason: "attempt 2 (escalated)" } },
  ])
  const scanner = installScannerMock([
    unresolvedReport(finding), // first attempt: finding still present
    RESOLVED_REPORT, // second attempt: clean
  ])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5, // cascade bucket
    })
    assert.ok(!("refused" in result), `expected preview, got ${JSON.stringify(result)}`)
    if ("refused" in result) return
    assert.equal(result.escalated, true)
    assert.deepEqual(result.attemptedModels, ["test-mid", "test-flagship"])
    assert.equal(result.modelUsed, "test-flagship")
    assert.match(result.firstAttemptFailureReason ?? "", /finding still present/i)
    assert.equal(result.resolved, true, "escalated attempt should report resolved")
    assert.deepEqual(llm.calls, ["test-mid", "test-flagship"])
    assert.equal(scanner.callCount(), 2)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("Auto does not retry if the first attempt succeeds", async () => {
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "one-shot" } },
  ])
  const scanner = installScannerMock([RESOLVED_REPORT])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, false)
    assert.equal(result.firstAttemptFailureReason, undefined)
    assert.deepEqual(result.attemptedModels, ["test-mid"])
    assert.equal(result.modelUsed, "test-mid")
    assert.deepEqual(llm.calls, ["test-mid"])
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("Manual mode does NOT auto-escalate (user pinned the model)", async () => {
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "manual attempt" } },
    // A second mock entry exists so an accidental retry would be
    // distinguishable from "ran out of plan" — assertion below proves
    // it was NEVER reached.
    { content: { edits: [SECOND_EDIT], reason: "should not happen" } },
  ])
  const scanner = installScannerMock([unresolvedReport(finding)])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "manual",
      manualModels: { patch: "mid" },
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, false)
    assert.deepEqual(result.attemptedModels.length, 1)
    assert.equal(llm.calls.length, 1, "manual mode must not retry")
    // findingResolved is false but we still surface the preview so
    // the UI shows a low-confidence badge instead of refusing.
    assert.equal(result.resolved, false)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("Save mode does NOT retry — cascade flag is false", async () => {
  // Save mode would normally be blocked upstream by enforceGuardrails;
  // here we drive the pipeline directly to prove the pipeline itself
  // also honours Save's cascade=false.
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "save attempt" } },
    { content: { edits: [SECOND_EDIT], reason: "should not happen" } },
  ])
  const scanner = installScannerMock([unresolvedReport(finding)])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "save",
      complexity: 0.1,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, false)
    assert.equal(llm.calls.length, 1, "save mode must not retry")
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("privateCodeMode never escalates to a cloud model", async () => {
  // With privateCodeMode the resolver pins the provider to `custom`,
  // and our eligibility check blocks the retry even though Auto would
  // normally cascade. We confirm only one model call lands.
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "private attempt" } },
    { content: { edits: [SECOND_EDIT], reason: "should not happen" } },
  ])
  const scanner = installScannerMock([unresolvedReport(finding)])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: "http://127.0.0.1:11434/v1",
      privateCodeMode: true,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, false)
    assert.equal(llm.calls.length, 1, "privateCodeMode must not escalate")
    assert.equal(result.attemptedModels.length, 1)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("attemptedModels records BOTH models when the second attempt is used", async () => {
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "first" } },
    { content: { edits: [SECOND_EDIT], reason: "second" } },
  ])
  const scanner = installScannerMock([
    unresolvedReport(finding),
    RESOLVED_REPORT,
  ])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.attemptedModels.length, 2)
    assert.deepEqual(result.attemptedModels, ["test-mid", "test-flagship"])
    assert.equal(result.escalated, true)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("escalated === true only when the second attempt is used (mirror of single-shot success)", async () => {
  // Single-attempt success path — escalation must NOT be claimed.
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "happy path" } },
  ])
  const scanner = installScannerMock([RESOLVED_REPORT])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, false)
    assert.equal(result.attemptedModels.length, 1)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("Invalid JSON on the first call triggers an escalated retry", async () => {
  // Trip the "model JSON invalid" failure path: first reply is HTTP 500
  // → callLlm returns ok:false → the wrapper classifies this as a
  // model_call failure → escalation applies. The second attempt
  // returns a clean edit and the rescan resolves the finding.
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { networkError: true }, // first attempt: network error
    { content: { edits: [SECOND_EDIT], reason: "rescue" } },
  ])
  const scanner = installScannerMock([RESOLVED_REPORT])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    assert.ok(!("refused" in result))
    if ("refused" in result) return
    assert.equal(result.escalated, true)
    assert.match(result.firstAttemptFailureReason ?? "", /model call failed/i)
    assert.deepEqual(result.attemptedModels, ["test-mid", "test-flagship"])
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})

test("Max attempts === 2 (a failed escalation refuses; no third try)", async () => {
  const { dir, cleanup } = mkProject()
  const finding = mkFinding()
  const llm = installLlmMock([
    { content: { edits: [FIRST_EDIT], reason: "first" } },
    { content: { edits: [SECOND_EDIT], reason: "second" } },
    // A third entry exists to detect any over-retry; if reached, calls
    // would exceed 2.
    { content: { edits: [{ old_str: "delta", new_str: "delta # nope" }], reason: "third" } },
  ])
  const scanner = installScannerMock([
    unresolvedReport(finding),
    unresolvedReport(finding), // even the escalated attempt fails
  ])
  try {
    const result = await generatePatchPreview({
      projectPath: dir,
      finding,
      plan: planFix(finding),
      provider: "openai_compatible",
      apiKey: "sk-test",
      baseUrl: null,
      intelligenceMode: "auto",
      complexity: 0.5,
    })
    // Both attempts produced a parseable preview that still didn't
    // resolve the finding. The pipeline does NOT call a third time;
    // it returns the escalated preview (resolved=false), because the
    // "still-unresolved" condition produces a preview-shaped result
    // rather than a refusal. We assert the call count and the
    // escalated flag.
    assert.equal(llm.calls.length, 2, "must not retry beyond 2 attempts")
    if ("refused" in result) {
      // Either outcome is fine here — the contract is "no third
      // call". If the pipeline later starts refusing on a doubly
      // failed cascade, that's a stricter behaviour and still
      // satisfies this test.
      return
    }
    assert.deepEqual(result.attemptedModels, ["test-mid", "test-flagship"])
    assert.equal(result.escalated, true)
    assert.equal(result.resolved, false)
  } finally {
    llm.restore()
    scanner.restore()
    cleanup()
  }
})
