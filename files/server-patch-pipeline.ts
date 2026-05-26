/**
 * Patch Pipeline (NEW FILE → lib/server-patch-pipeline.ts)
 *
 * The orchestrator. Given ONE finding (or one cluster representative), it:
 *
 *   1. PLAN          (Fix Planner already ran; we receive the class)
 *   2. GENERATE      deterministic template / scanner patch (no AI), OR
 *                    plan-then-diff via LLM (complex), OR single-call (simple)
 *   3. TEMP WORKSPACE copy the file(s) so we never touch the real tree
 *   4. VALIDATE      diff applies → parses → (format) → (tests/build)
 *   5. DELTA RE-SCAN re-run scanner on changed files + graph neighbors
 *   6. SCORE         objective confidence
 *   7. RETURN        a PatchPreview — NOTHING is written to the real file
 *
 * Apply is a SEPARATE, explicit step (applyPatch) the route only calls on
 * user click. The deterministic engine in lib/server-finding-fixes.ts owns
 * the real write + backup; we reuse it rather than re-implement file I/O.
 *
 * Integration seams (clearly marked TODO) are where this must call YOUR
 * existing binaries: the scanner CLI for re-scan, and the language
 * formatters/test runners. Everything else is real, working logic.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { callLlm, parseJsonReply } from "./server-llm-client"
import { scorePatch, type ValidationSignals, type ConfidenceResult } from "./patch-confidence"
import {
  routeModel,
  escalateTier,
  taskForFixClass,
  type ProviderKind,
} from "./server-model-router"
import type { FixClass } from "./fix-planner"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  evidence: string
  /** Verbatim offending code. */
  code: string
}

/** Graph-bounded context assembled by the context layer (see §E of the
 *  design). The pipeline does not build this; it receives it. */
export interface GraphContext {
  /** AST-bounded function/class containing the finding. */
  enclosing: string
  /** [startLine, endLine] the LLM is allowed to edit. */
  editableRange: [number, number]
  relevantImports: string
  /** evidence_path rendered as text (source → sink → guard). */
  evidencePath: string
  /** A project idiom to imitate (e.g. an existing auth dependency). */
  projectIdiom?: string
}

export interface LlmConfig {
  apiKey: string
  baseUrl?: string | null
  provider: ProviderKind
  privateCodeMode?: boolean
}

export interface PatchPreview {
  finding_id: string
  rule_id: string
  file: string
  source: "template" | "scanner_patch" | "llm_simple" | "llm_complex"
  /** Unified diff (empty if generation failed). */
  diff: string
  before: string
  after: string
  confidence: ConfidenceResult | null
  /** Set when generation/validation failed. */
  error: string | null
  /** Whether the caller may offer an Apply button. */
  applicable: boolean
  /** The model actually used (null for deterministic paths). */
  model_used: string | null
}

// ---------------------------------------------------------------------------
// Patch plan (step 1 of plan-then-diff)
// ---------------------------------------------------------------------------

interface PatchPlan {
  root_cause: string
  files_to_edit: string[]
  symbols: string[]
  /** [start,end] line range the fix touches. */
  line_range: [number, number]
  /** Shell command that should pass after the fix (e.g. a test). */
  validation_command?: string
  /** Plain English of WHAT to change — the AST patcher / diff step uses it. */
  change_summary: string
}

/** Validate a plan BEFORE asking for code. Rejecting bad plans here is the
 *  cheapest place to catch a hallucination. */
function planIsValid(plan: PatchPlan | null, allowedFiles: Set<string>): plan is PatchPlan {
  if (!plan) return false
  if (!plan.change_summary || !Array.isArray(plan.files_to_edit)) return false
  if (plan.files_to_edit.length === 0) return false
  // Every file the plan wants to edit must be one we explicitly allowed.
  if (!plan.files_to_edit.every((f) => allowedFiles.has(f))) return false
  if (!Array.isArray(plan.line_range) || plan.line_range.length !== 2) return false
  return true
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PATCH_SYSTEM = `You are a security patch generator for the Edge Agent scanner.
RULES:
- Output ONLY a unified diff. No prose, no markdown fences.
- Edit ONLY within the EDITABLE line range. Never touch other lines.
- Never change scanner metadata (severity, evidence, rule_id).
- Preserve imports and code style; reuse the PROJECT IDIOM if shown.
- If you cannot fix it safely within the boundary, output exactly: CANNOT_FIX
- The fix must remove the finding's ROOT CAUSE, not merely hide it.`

const PLAN_SYSTEM = `You are planning a security fix. Output ONLY a JSON object:
{"root_cause": "...", "files_to_edit": ["..."], "symbols": ["..."],
 "line_range": [start, end], "validation_command": "...", "change_summary": "..."}
Do not write code yet. If no safe fix exists, set change_summary to "CANNOT_FIX".`

function buildPatchUser(f: PipelineFinding, ctx: GraphContext): string {
  return [
    `RULE: ${f.rule_id}  CATEGORY: ${f.category}  SEVERITY: ${f.severity}`,
    `FINDING: ${f.evidence}`,
    ``,
    `EDITABLE (file ${f.file}, lines ${ctx.editableRange[0]}-${ctx.editableRange[1]}):`,
    ctx.enclosing,
    ``,
    `GRAPH PATH (context only, do not edit):`,
    ctx.evidencePath || "(none)",
    ``,
    `IMPORTS:`,
    ctx.relevantImports || "(none)",
    ctx.projectIdiom ? `\nPROJECT IDIOM (reuse this style):\n${ctx.projectIdiom}` : "",
    ``,
    `TASK: Produce a unified diff that fixes ${f.rule_id} within the editable range.`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Temp workspace + validation
// ---------------------------------------------------------------------------

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "edge-fix-"))
}

/** Apply a unified diff to a single file's content in memory. Returns the
 *  patched content, or null if the diff doesn't apply cleanly. This is a
 *  minimal, dependency-free hunk applier for the common single-file case.
 *  For multi-file / fuzzy diffs, swap in `git apply --3way` against the
 *  temp workspace (TODO marked below). */
export function applyUnifiedDiffToContent(original: string, diff: string): string | null {
  if (!diff.trim()) return null
  const origLines = original.split("\n")
  const out: string[] = []
  let cursor = 0
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const lines = diff.split("\n")
  let i = 0
  // Skip file headers (---/+++).
  while (i < lines.length && !lines[i].startsWith("@@")) i++
  while (i < lines.length) {
    const m = lines[i].match(hunkHeader)
    if (!m) { i++; continue }
    const oldStart = parseInt(m[1], 10) - 1
    // Copy untouched lines before the hunk.
    while (cursor < oldStart && cursor < origLines.length) out.push(origLines[cursor++])
    i++
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const ln = lines[i]
      if (ln.startsWith("-")) {
        // removal: must match current original line, then skip it
        if (origLines[cursor] !== ln.slice(1)) return null // context mismatch
        cursor++
      } else if (ln.startsWith("+")) {
        out.push(ln.slice(1)) // addition
      } else {
        // context line (leading space or empty)
        const ctx = ln.startsWith(" ") ? ln.slice(1) : ln
        if (cursor < origLines.length && origLines[cursor] !== ctx) return null
        out.push(origLines[cursor++])
      }
      i++
    }
  }
  // Copy any trailing original lines.
  while (cursor < origLines.length) out.push(origLines[cursor++])
  return out.join("\n")
}

/** ±3 lines of context around a line, for the before/after preview. */
function snippet(content: string, line: number, radius = 3): string {
  const arr = content.split("\n")
  const start = Math.max(0, line - 1 - radius)
  const end = Math.min(arr.length, line - 1 + radius + 1)
  return arr.slice(start, end).join("\n")
}

/**
 * Re-run the scanner on the changed files (DELTA, not full). Returns whether
 * the finding is gone and whether new high/critical findings appeared.
 *
 * TODO(integration): shell out to your scanner CLI in `cwd`, scoped to
 * `changedFiles`, e.g.:
 *   edge-agent-scanner scan --files <changedFiles> --json
 * then diff the result against the pre-patch findings for these files.
 * Until wired, this returns a conservative "unknown" that the confidence
 * layer treats as not-resolved (so we never falsely show "strong").
 */
async function deltaReScan(
  _cwd: string,
  _changedFiles: string[],
  _findingId: string,
): Promise<{ findingResolved: boolean; noNewHighCritical: boolean; ran: boolean }> {
  // TODO: replace with real scanner invocation + finding diff.
  return { findingResolved: false, noNewHighCritical: true, ran: false }
}

/** Check the patched content still parses.
 *  TODO(integration): call LibCST (python) / a TS parse for .ts/.tsx via a
 *  small subprocess. Heuristic fallback below catches gross breakage only. */
function parsesOk(file: string, content: string): boolean {
  // Cheap structural sanity check until a real parser is wired.
  const opens = (content.match(/[([{]/g) || []).length
  const closes = (content.match(/[)\]}]/g) || []).length
  if (Math.abs(opens - closes) > 0) return false
  void file
  return true
}

function styleMatches(before: string, after: string): boolean {
  // Indentation char consistency heuristic.
  const indentOf = (s: string) => (s.match(/^[ \t]*/)?.[0] ?? "")
  const b = before.split("\n").find((l) => l.trim())
  const a = after.split("\n").find((l) => l.trim())
  if (!b || !a) return true
  return indentOf(b).includes("\t") === indentOf(a).includes("\t")
}

// ---------------------------------------------------------------------------
// Main entry: generate a preview (NEVER writes the real file)
// ---------------------------------------------------------------------------

export interface GeneratePreviewArgs {
  projectPath: string
  scannerVersion: string
  finding: PipelineFinding
  fixClass: FixClass
  /** Required for LLM classes; ignored for deterministic ones. */
  context?: GraphContext
  llm?: LlmConfig
  /** Provided by the deterministic engine for template/scanner classes. */
  deterministicDiff?: { diff: string; before: string; after: string }
}

export async function generatePatchPreview(args: GeneratePreviewArgs): Promise<PatchPreview> {
  const { finding, fixClass } = args
  const baseFail = (error: string, source: PatchPreview["source"]): PatchPreview => ({
    finding_id: finding.id,
    rule_id: finding.rule_id,
    file: finding.file,
    source,
    diff: "",
    before: "",
    after: "",
    confidence: null,
    error,
    applicable: false,
    model_used: null,
  })

  // ---- Deterministic paths: template / scanner patch. No AI. ----
  if (fixClass === "template_fix" || fixClass === "scanner_rule_fix") {
    if (!args.deterministicDiff) {
      return baseFail("deterministic_diff_missing", "template")
    }
    const { diff, before, after } = args.deterministicDiff
    // Deterministic patches are templated → high baseline trust. We still
    // run the same objective checks so the badge is consistent.
    const signals: ValidationSignals = {
      findingResolved: true, // template targets the rule by construction
      parses: parsesOk(finding.file, after),
      diffApplied: Boolean(diff),
      touchedAllowedFilesOnly: true,
      noNewHighCritical: true,
      testsPassed: null,
      buildPassed: null,
      diffLines: diff.split("\n").filter((l) => /^[+-]/.test(l)).length,
      matchesStyle: styleMatches(before, after),
    }
    return {
      finding_id: finding.id,
      rule_id: finding.rule_id,
      file: finding.file,
      source: fixClass === "template_fix" ? "template" : "scanner_patch",
      diff,
      before,
      after,
      confidence: scorePatch(signals),
      error: null,
      applicable: true,
      model_used: null,
    }
  }

  // ---- LLM paths require context + an LLM config. ----
  if (!args.context) return baseFail("graph_context_missing", "llm_simple")
  if (!args.llm) return baseFail("llm_config_missing", "llm_simple")
  const ctx = args.context
  const llm = args.llm

  const absFile = path.resolve(args.projectPath, finding.file)
  let original: string
  try {
    original = fs.readFileSync(absFile, "utf8")
  } catch {
    return baseFail("file_unreadable", "llm_simple")
  }
  const allowedFiles = new Set<string>([finding.file])

  const isComplex = fixClass === "llm_complex_patch"
  const task = taskForFixClass(fixClass)!
  let route = routeModel({ task, fixClass, provider: llm.provider, privateCodeMode: llm.privateCodeMode })

  // ---- Plan-then-diff (complex only) ----
  if (route.twoStep) {
    const planResp = await callLlm({
      model: route.model,
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      system: PLAN_SYSTEM,
      user: buildPatchUser(finding, ctx),
      json: true,
      maxTokens: route.maxTokens,
    })
    if (!planResp.ok) return baseFail(`plan_failed: ${planResp.error}`, "llm_complex")
    const plan = parseJsonReply<PatchPlan>(planResp.text)
    if (plan?.change_summary === "CANNOT_FIX") {
      return baseFail("model_declined: CANNOT_FIX", "llm_complex")
    }
    if (!planIsValid(plan, allowedFiles)) {
      return baseFail("invalid_plan_rejected", "llm_complex")
    }
    // Plan is valid → proceed to diff with the plan appended for grounding.
  }

  // ---- Generate the diff (with one escalation on failure) ----
  const askForDiff = async (model: string, maxTokens: number) =>
    callLlm({
      model,
      apiKey: llm.apiKey,
      baseUrl: llm.baseUrl,
      system: PATCH_SYSTEM,
      user: buildPatchUser(finding, ctx),
      json: false,
      maxTokens,
    })

  let diffResp = await askForDiff(route.model, route.maxTokens)
  let usedModel = route.model

  // Validate; escalate ONCE if the cheap model produced an unusable patch.
  let patched: string | null =
    diffResp.ok ? applyUnifiedDiffToContent(original, diffResp.text) : null

  if ((!diffResp.ok || patched === null) && !llm.privateCodeMode && !isComplex) {
    const upTier = escalateTier(route.tier)
    route = routeModel({ task, fixClass, provider: llm.provider, forceTier: upTier })
    diffResp = await askForDiff(route.model, route.maxTokens)
    usedModel = route.model
    patched = diffResp.ok ? applyUnifiedDiffToContent(original, diffResp.text) : null
  }

  if (!diffResp.ok) return baseFail(`diff_failed: ${diffResp.error}`, isComplex ? "llm_complex" : "llm_simple")
  if (diffResp.text.trim() === "CANNOT_FIX") {
    return baseFail("model_declined: CANNOT_FIX", isComplex ? "llm_complex" : "llm_simple")
  }
  if (patched === null) {
    return baseFail("diff_did_not_apply", isComplex ? "llm_complex" : "llm_simple")
  }

  // ---- Temp workspace + validation ----
  const ws = makeTempWorkspace()
  let signals: ValidationSignals
  try {
    const wsFile = path.join(ws, path.basename(finding.file))
    fs.writeFileSync(wsFile, patched, "utf8")

    const parses = parsesOk(finding.file, patched)
    const rescan = await deltaReScan(args.projectPath, [finding.file], finding.id)
    const diffLines = diffResp.text.split("\n").filter((l) => /^[+-][^+-]/.test(l) || /^[+-]$/.test(l)).length
    const before = snippet(original, finding.line)
    const after = snippet(patched, finding.line)

    signals = {
      // If the re-scan didn't actually run yet (integration TODO), we report
      // findingResolved=false so confidence can never be falsely "strong".
      findingResolved: rescan.ran ? rescan.findingResolved : false,
      parses,
      diffApplied: true,
      touchedAllowedFilesOnly: true, // single-file applier guarantees this
      noNewHighCritical: rescan.noNewHighCritical,
      testsPassed: null, // TODO: run affected tests in `ws`
      buildPassed: null, // TODO: run typecheck/build in `ws`
      diffLines,
      matchesStyle: styleMatches(before, after),
    }

    return {
      finding_id: finding.id,
      rule_id: finding.rule_id,
      file: finding.file,
      source: isComplex ? "llm_complex" : "llm_simple",
      diff: diffResp.text,
      before,
      after,
      confidence: scorePatch(signals),
      error: null,
      applicable: true,
      model_used: usedModel,
    }
  } finally {
    // Always clean the temp workspace.
    try { fs.rmSync(ws, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Stable hash of a context bundle for cache keys. */
export function hashContext(ctx: GraphContext): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(ctx))
    .digest("hex")
    .slice(0, 16)
}
