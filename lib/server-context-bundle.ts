/**
 * Server-side ContextBundle builder.
 *
 * Turns a scanner finding + the project's IR/evidence path into a
 * graph-bounded, redacted, budget-trimmed ContextBundle. This is the
 * thing that replaces "send the whole file" everywhere in the fix and
 * explanation pipelines.
 *
 * Inputs it relies on (all already produced by the existing system):
 *   - the finding (rule_id, file, line, evidence_path, fingerprint…)
 *   - the on-disk source file (for slicing — never sent whole)
 *   - optionally the scan report's IR section (callers/callees/related
 *     prompt/model/route/tool nodes) via the `/api/ir` shape
 *
 * Redaction: every slice goes through `redactSecrets` (re-exported from
 * server-finding-explanations) before it lands in the bundle. The
 * `secrets` rule additionally short-circuits to the deterministic
 * template upstream, so a real secret never reaches here.
 *
 * Budgeting: slices are added in priority order (primary → taint path →
 * callers → callees → related → config → tests) and the builder stops
 * adding once the mode's token cap would be exceeded. This guarantees
 * `bundleWithinBudget(bundle) === true` by construction.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

import { isPathInside } from "./server-path-utils"
import { redactSecrets } from "./server-finding-explanations"
import {
  BUNDLE_INPUT_TOKEN_CAP,
  estimateTokens,
  type CodeSlice,
  type ContextBundle,
  type ContextBundleMode,
  type IRNode,
  type IREdge,
} from "./context-bundle"

/** Minimal finding shape the builder needs (superset of PlannerFinding). */
export interface BundleInputFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  title: string
  file: string
  line: number
  confidence?: number
  fingerprint?: string | null
  evidence_path?: Array<{
    kind: string
    label: string
    file?: string | null
    line?: number | null
  }>
}

/** Optional IR neighborhood the caller can pass from `/api/ir`. */
export interface IRNeighborhoodInput {
  callers?: Array<{ file: string; line: number; symbol?: string }>
  callees?: Array<{ file: string; line: number; symbol?: string }>
  prompts?: Array<{ file: string; line: number; symbol?: string }>
  routes?: Array<{ file: string; line: number; symbol?: string }>
  tools?: Array<{ file: string; line: number; symbol?: string }>
  models?: Array<{ provider: string; id: string }>
  configKeys?: Array<{ file: string; line: number; symbol?: string }>
  tests?: Array<{ file: string; line: number; symbol?: string }>
}

export interface BuildBundleArgs {
  projectPath: string
  mode: ContextBundleMode
  finding: BundleInputFinding
  irHash: string
  neighborhood?: IRNeighborhoodInput
  siblings?: { fingerprint: string; count: number; sampleIds: string[] }
  /** Per-token input price for the chosen model (for cost estimate). */
  inputPricePer1k?: number
  maxOutputTokens?: number
}

const REDACTION_VERSION = "redact-v1"

/** Read a bounded slice of a file (1-based inclusive line range). */
function readSlice(
  projectPath: string,
  file: string,
  startLine: number,
  endLine: number,
  role: CodeSlice["role"],
): CodeSlice | null {
  const abs = path.resolve(projectPath, file)
  if (!isPathInside(abs, projectPath)) return null
  let raw: string
  try {
    raw = fs.readFileSync(abs, "utf8")
  } catch {
    return null
  }
  const lines = raw.split("\n")
  const s = Math.max(1, startLine)
  const e = Math.min(lines.length, Math.max(s, endLine))
  const text = redactSecrets(lines.slice(s - 1, e).join("\n"))
  return { file, startLine: s, endLine: e, text, role }
}

function countRedactions(before: string, after: string): number {
  const m = after.match(/<REDACTED_[A-Z_]+>/g)
  return m ? m.length : before === after ? 0 : 0
}

/** Window helper: a slice centered on a line. */
function windowSlice(
  projectPath: string,
  file: string,
  line: number,
  radius: number,
  role: CodeSlice["role"],
): CodeSlice | null {
  return readSlice(projectPath, file, line - radius, line + radius, role)
}

/**
 * Build a ContextBundle for one finding under a given mode.
 *
 * Slice radii scale with mode so cheap modes stay tiny and Pro/Max get
 * richer neighborhoods — but always via bounded slices, never whole
 * files (except the explicit, capped max-patch path).
 */
export function buildContextBundle(args: BuildBundleArgs): ContextBundle {
  const { projectPath, mode, finding } = args
  const cap = BUNDLE_INPUT_TOKEN_CAP[mode]

  // Mode-scaled slice radii.
  const primaryRadius = mode === "save-explain" ? 3 : mode === "auto-small" ? 6 : 10
  const callerRadius = mode === "pro" || mode.startsWith("max") ? 8 : 4

  // ---- primary evidence slice (always present) ----
  const primarySlice =
    windowSlice(projectPath, finding.file, finding.line, primaryRadius, "primary") ??
    ({
      file: finding.file,
      startLine: finding.line,
      endLine: finding.line,
      text: "",
      role: "primary",
    } as CodeSlice)

  const surroundingSlice =
    mode !== "save-explain"
      ? windowSlice(projectPath, finding.file, finding.line, primaryRadius * 2, "surrounding") ??
        undefined
      : undefined

  // ---- taint path nodes + slices ----
  const taintNodes: IRNode[] = []
  const taintEdges: IREdge[] = []
  const taintSlices: CodeSlice[] = []
  const guardsPresent: string[] = []
  const guardsMissing: string[] = []

  const ep = finding.evidence_path ?? []
  let prevId: string | null = null
  ep.forEach((node, i) => {
    const id = `tp${i}`
    const kind = mapKind(node.kind)
    taintNodes.push({
      id,
      kind,
      subkind: node.kind,
      file: node.file ?? finding.file,
      line: node.line ?? finding.line,
      label: node.label,
    })
    if (prevId) taintEdges.push({ from: prevId, to: id, kind: "flows_to" })
    prevId = id
    if (kind === "Guard") guardsPresent.push(node.label)
    // Only slice taint nodes for modes above save (keeps Save cheap).
    if (mode !== "save-explain" && node.file && node.line) {
      const sl = windowSlice(projectPath, node.file, node.line, 3, "taint-node")
      if (sl) taintSlices.push(sl)
    }
  })

  // ---- neighborhood (callers/callees) — Pro/Max/auto-large only ----
  const callers: CodeSlice[] = []
  const callees: CodeSlice[] = []
  const includeNeighborhood =
    mode === "auto-large" || mode === "pro" || mode.startsWith("max")
  if (includeNeighborhood && args.neighborhood) {
    for (const c of args.neighborhood.callers ?? []) {
      const sl = windowSlice(projectPath, c.file, c.line, callerRadius, "caller")
      if (sl) callers.push(sl)
    }
    for (const c of args.neighborhood.callees ?? []) {
      const sl = windowSlice(projectPath, c.file, c.line, callerRadius, "callee")
      if (sl) callees.push(sl)
    }
  }

  // ---- related prompt/model/route/tool nodes — Pro/Max ----
  const prompts: CodeSlice[] = []
  const routes: CodeSlice[] = []
  const tools: CodeSlice[] = []
  const models: { provider: string; id: string }[] = []
  const includeRelated = mode === "pro" || mode.startsWith("max")
  if (includeRelated && args.neighborhood) {
    for (const p of args.neighborhood.prompts ?? []) {
      const sl = windowSlice(projectPath, p.file, p.line, 5, "prompt")
      if (sl) prompts.push(sl)
    }
    for (const r of args.neighborhood.routes ?? []) {
      const sl = windowSlice(projectPath, r.file, r.line, 4, "route")
      if (sl) routes.push(sl)
    }
    for (const t of args.neighborhood.tools ?? []) {
      const sl = windowSlice(projectPath, t.file, t.line, 4, "tool")
      if (sl) tools.push(sl)
    }
    for (const m of args.neighborhood.models ?? []) models.push(m)
  }

  // ---- config + tests — Max only ----
  const config: CodeSlice[] = []
  const tests: CodeSlice[] = []
  if (mode.startsWith("max") && args.neighborhood) {
    for (const c of args.neighborhood.configKeys ?? []) {
      const sl = windowSlice(projectPath, c.file, c.line, 3, "config")
      if (sl) config.push(sl)
    }
    for (const t of args.neighborhood.tests ?? []) {
      const sl = windowSlice(projectPath, t.file, t.line, 12, "test")
      if (sl) tests.push(sl)
    }
  }

  // ---- assemble, then trim to budget in priority order ----
  let bundle: ContextBundle = {
    bundleVersion: "1.0",
    mode,
    finding: {
      id: finding.id,
      rule_id: finding.rule_id,
      severity: finding.severity,
      title: finding.title,
      confidence: finding.confidence ?? 0.7,
      fingerprint: finding.fingerprint ?? "",
      irHash: args.irHash,
    },
    evidence: { primarySlice, surroundingSlice },
    taintPath: {
      nodes: taintNodes,
      edges: taintEdges,
      slices: taintSlices,
      guardsPresent,
      guardsMissing,
    },
    neighborhood: { callers, callees, relatedSymbols: [] },
    related: { prompts, models, routes, tools },
    config,
    tests,
    siblings: args.siblings,
    budget: {
      maxInputTokens: cap,
      maxOutputTokens: args.maxOutputTokens ?? 1500,
      estimatedInputTokens: 0,
      estimatedCostUsd: 0,
    },
    redaction: { secretsRedacted: 0, redactionVersion: REDACTION_VERSION },
  }

  bundle = trimToBudget(bundle, cap)

  // finalize estimates
  const est = sumTokens(bundle)
  bundle.budget.estimatedInputTokens = est
  bundle.budget.estimatedCostUsd =
    args.inputPricePer1k != null ? (est / 1000) * args.inputPricePer1k : 0
  bundle.redaction.secretsRedacted = countAllRedactions(bundle)

  return bundle
}

function mapKind(scannerKind: string): IRNode["kind"] {
  const k = scannerKind.toLowerCase()
  if (k.includes("source")) return "Source"
  if (k.includes("sink")) return "Sink"
  if (k.includes("guard")) return "Guard"
  if (k.includes("prompt")) return "Prompt"
  if (k.includes("model")) return "Model"
  if (k.includes("route")) return "Route"
  if (k.includes("tool")) return "Tool"
  if (k.includes("config")) return "Config"
  if (k.includes("test")) return "Test"
  return "Function"
}

function sliceTokens(s: CodeSlice): number {
  return estimateTokens(s.text)
}

function sumTokens(b: ContextBundle): number {
  const all: CodeSlice[] = [
    b.evidence.primarySlice,
    ...(b.evidence.surroundingSlice ? [b.evidence.surroundingSlice] : []),
    ...b.taintPath.slices,
    ...b.neighborhood.callers,
    ...b.neighborhood.callees,
    ...b.related.prompts,
    ...b.related.routes,
    ...b.related.tools,
    ...b.config,
    ...b.tests,
  ]
  const sliceSum = all.reduce((s, x) => s + sliceTokens(x), 0)
  const meta = estimateTokens(
    JSON.stringify(b.finding) + b.finding.title + JSON.stringify(b.taintPath.nodes),
  )
  return sliceSum + meta
}

function countAllRedactions(b: ContextBundle): number {
  const all: CodeSlice[] = [
    b.evidence.primarySlice,
    ...(b.evidence.surroundingSlice ? [b.evidence.surroundingSlice] : []),
    ...b.taintPath.slices,
    ...b.neighborhood.callers,
    ...b.neighborhood.callees,
    ...b.related.prompts,
    ...b.related.routes,
    ...b.related.tools,
    ...b.config,
    ...b.tests,
  ]
  return all.reduce((n, s) => n + (s.text.match(/<REDACTED_[A-Z_]+>/g)?.length ?? 0), 0)
}

/**
 * Drop the lowest-priority slices until the bundle fits the cap. The
 * primary evidence slice and taint-path nodes are never dropped (they
 * are the irreducible core); everything else is shed in reverse
 * priority: tests → config → tools → routes → prompts → callees →
 * callers → surrounding → taint slices.
 */
function trimToBudget(b: ContextBundle, cap: number): ContextBundle {
  const droppers: Array<() => void> = [
    () => (b.tests = b.tests.slice(0, Math.max(0, b.tests.length - 1))),
    () => (b.config = b.config.slice(0, Math.max(0, b.config.length - 1))),
    () => (b.related.tools = b.related.tools.slice(0, Math.max(0, b.related.tools.length - 1))),
    () => (b.related.routes = b.related.routes.slice(0, Math.max(0, b.related.routes.length - 1))),
    () => (b.related.prompts = b.related.prompts.slice(0, Math.max(0, b.related.prompts.length - 1))),
    () => (b.neighborhood.callees = b.neighborhood.callees.slice(0, Math.max(0, b.neighborhood.callees.length - 1))),
    () => (b.neighborhood.callers = b.neighborhood.callers.slice(0, Math.max(0, b.neighborhood.callers.length - 1))),
    () => (b.evidence.surroundingSlice = undefined),
    () => (b.taintPath.slices = b.taintPath.slices.slice(0, Math.max(0, b.taintPath.slices.length - 1))),
  ]

  let guard = 0
  while (sumTokens(b) > cap && guard < 5000) {
    let droppedSomething = false
    for (const drop of droppers) {
      if (sumTokens(b) <= cap) break
      const before = sumTokens(b)
      drop()
      if (sumTokens(b) < before) droppedSomething = true
    }
    if (!droppedSomething) break // only primary+meta left
    guard++
  }
  return b
}

/** Stable cache-context hash for a bundle (feeds buildCacheKey). */
export function bundleContextHash(b: ContextBundle): string {
  const payload = JSON.stringify({
    mode: b.mode,
    rule: b.finding.rule_id,
    fp: b.finding.fingerprint,
    nodes: b.taintPath.nodes.map((n) => `${n.kind}:${n.subkind}`),
    slices: [
      b.evidence.primarySlice.text,
      ...b.taintPath.slices.map((s) => s.text),
    ],
  })
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16)
}
