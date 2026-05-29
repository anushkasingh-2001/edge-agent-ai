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
  /** Owning agent name (e.g. "research-agent") if the scanner ties this
   *  finding to an agent. Used to rank related-prompt/tool/route slices
   *  by same-agent proximity before falling back to same-file. */
  agent?: string | null
  /** Taint flow from the scanner's IR analyzer. Order is source → … →
   *  sink; each node carries kind/label and a (file, line) anchor when
   *  the analyzer could pin one. Guard nodes have kind containing
   *  "guard"; missing-guard sentinels are kinds containing "missing". */
  evidence_path?: Array<{
    kind: string
    label: string
    file?: string | null
    line?: number | null
  }>
  /** Optional pre-derived list of guard NAMES the analyzer says are
   *  absent for this finding (e.g. ["parameterization", "auth-check"]).
   *  When omitted, the builder derives a best-effort list from
   *  evidence_path nodes whose kind contains "missing". */
  guardsMissing?: string[]
}

/** A single (file, line) IR hit. `agent` lets the proximity sort
 *  rank same-agent hits above generic ones; `symbol` is informational. */
export interface IRHit {
  file: string
  line: number
  symbol?: string
  agent?: string | null
}

/** Optional IR neighborhood the caller can pass from `/api/ir` (or the
 *  scan report's top-level inventories). All arrays default to empty. */
export interface IRNeighborhoodInput {
  callers?: IRHit[]
  callees?: IRHit[]
  prompts?: IRHit[]
  routes?: IRHit[]
  tools?: IRHit[]
  models?: Array<{ provider: string; id: string }>
  configKeys?: IRHit[]
  tests?: IRHit[]
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
 * Per-mode shape (what gets included, before budget trimming):
 *   save-explain  primary + immediate taint nodes (no slices for hops).
 *   auto-small    primary + surrounding + taint-source/sink slices +
 *                 1-hop callers (small radius).
 *   auto-large    everything above, plus 2-hop callers + callees, plus
 *                 the rest of the taint path.
 *   pro           auto-large set + related prompts / routes / tools /
 *                 model inventory.
 *   max-plan      pro set + config keys + nearby tests.
 *   max-patch     same shape as max-plan, but the prompt that *uses*
 *                 this bundle is allowed to attach the full file
 *                 separately (capped by token budget). The bundle
 *                 builder itself still slices everything.
 *
 * Slices are added in the priority order listed in the spec and the
 * trimmer drops them in reverse-priority when the budget is tight, so
 * the irreducible core (primary line + taint source + taint sink) is
 * always preserved.
 */
export function buildContextBundle(args: BuildBundleArgs): ContextBundle {
  const { projectPath, mode, finding } = args
  const cap = BUNDLE_INPUT_TOKEN_CAP[mode]

  // Mode-scaled slice radii. Caps are deliberately well under the
  // MAX_NON_FULLFILE_SLICE_LINES = 80 guard so a single fat function
  // body can't blow through the per-mode budget by itself.
  const primaryRadius =
    mode === "save-explain"
      ? 3
      : mode === "auto-small"
        ? 6
        : mode === "auto-large"
          ? 10
          : 12
  const callerRadius =
    mode === "save-explain"
      ? 0
      : mode === "auto-small"
        ? 3 // tight 1-hop window
        : mode === "auto-large"
          ? 5
          : 8
  const taintRadius =
    mode === "save-explain"
      ? 0 // save: nodes only, no slices
      : mode === "auto-small"
        ? 2
        : mode === "auto-large"
          ? 4
          : 5

  // ---- primary evidence slice (always present, never dropped) ------
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

  // ---- taint path nodes + slices -----------------------------------
  // Build IR nodes first, then materialise slices in source → sink →
  // guard → other order so the trimmer can preserve the irreducible
  // core (source + sink) when budget is tight.
  const taintNodes: IRNode[] = []
  const taintEdges: IREdge[] = []
  const guardsPresent: string[] = []
  const guardsMissingDerived: string[] = []

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
    if (kind === "Guard") {
      guardsPresent.push(node.label)
    }
    // Scanner convention: kinds containing "missing" represent a guard
    // the analyzer expected but did NOT find. They're emitted as
    // sentinels in evidence_path so the bundle can carry the
    // "missing guards" summary the prompt template surfaces.
    if (/missing/i.test(node.kind)) {
      guardsMissingDerived.push(node.label)
    }
  })

  // Rank slice creation by IR role: Source first, Sink last, Guard +
  // others in between. This is the order the trimmer drops in REVERSE
  // (function/guard first, sink before source). save-explain
  // intentionally skips slice creation entirely.
  const ROLE_FOR_KIND: Record<IRNode["kind"], CodeSlice["role"]> = {
    Source: "taint-source",
    Sink: "taint-sink",
    Guard: "taint-guard",
    Prompt: "taint-node",
    Model: "taint-node",
    Route: "taint-node",
    Tool: "taint-node",
    Config: "taint-node",
    Test: "taint-node",
    Function: "taint-node",
  }
  const PRIORITY_FOR_KIND: Record<IRNode["kind"], number> = {
    Source: 0,
    Sink: 1,
    Guard: 2,
    Prompt: 3,
    Model: 3,
    Route: 3,
    Tool: 3,
    Config: 3,
    Test: 3,
    Function: 4,
  }
  const taintSlices: CodeSlice[] =
    mode === "save-explain"
      ? []
      : taintNodes
          .filter((n) => n.file && Number.isFinite(n.line))
          .sort((a, b) => PRIORITY_FOR_KIND[a.kind] - PRIORITY_FOR_KIND[b.kind])
          .map((n) => {
            const sl = windowSlice(projectPath, n.file, n.line, taintRadius, ROLE_FOR_KIND[n.kind])
            if (sl) sl.irNodeId = n.id
            return sl
          })
          .filter((s): s is CodeSlice => s !== null)

  // Caller-supplied list always wins, otherwise we surface the names
  // the scanner sentinel-tagged as missing.
  const guardsMissing: string[] = Array.isArray(finding.guardsMissing)
    ? [...finding.guardsMissing]
    : guardsMissingDerived

  // ---- neighborhood (callers / callees) ---------------------------
  // Save mode never includes a neighborhood (too noisy for the budget).
  // Auto-small carries 1-hop callers at a tight radius (catches the
  // "who passes this tainted value in?" question without ballooning
  // the prompt). Auto-large / Pro / Max get callers + callees, both
  // potentially at 2-hop, supplied by the caller.
  const callers: CodeSlice[] = []
  const callees: CodeSlice[] = []
  const includeCallers = mode !== "save-explain"
  const includeCallees =
    mode === "auto-large" || mode === "pro" || mode.startsWith("max") || mode === "manual"

  if (includeCallers && args.neighborhood) {
    const callerHits = sortByProximity(args.neighborhood.callers ?? [], finding)
    for (const c of callerHits) {
      const sl = windowSlice(projectPath, c.file, c.line, callerRadius, "caller")
      if (sl) callers.push(sl)
    }
  }
  if (includeCallees && args.neighborhood) {
    const calleeHits = sortByProximity(args.neighborhood.callees ?? [], finding)
    for (const c of calleeHits) {
      const sl = windowSlice(projectPath, c.file, c.line, callerRadius, "callee")
      if (sl) callees.push(sl)
    }
  }

  // ---- related prompt/model/route/tool nodes — Pro / Max ----------
  // Sorted same way: same-agent first, then same-file as the finding,
  // then anything else. This gives the LLM the most-relevant context
  // first, so when the budget trim drops the tail it loses the least
  // useful slices.
  const prompts: CodeSlice[] = []
  const routes: CodeSlice[] = []
  const tools: CodeSlice[] = []
  const models: { provider: string; id: string }[] = []
  const includeRelated =
    mode === "pro" || mode.startsWith("max") || mode === "manual"
  if (includeRelated && args.neighborhood) {
    for (const p of sortByProximity(args.neighborhood.prompts ?? [], finding)) {
      const sl = windowSlice(projectPath, p.file, p.line, 5, "prompt")
      if (sl) prompts.push(sl)
    }
    for (const r of sortByProximity(args.neighborhood.routes ?? [], finding)) {
      const sl = windowSlice(projectPath, r.file, r.line, 4, "route")
      if (sl) routes.push(sl)
    }
    for (const t of sortByProximity(args.neighborhood.tools ?? [], finding)) {
      const sl = windowSlice(projectPath, t.file, t.line, 4, "tool")
      if (sl) tools.push(sl)
    }
    for (const m of args.neighborhood.models ?? []) models.push(m)
  }

  // ---- config + tests — Max only ----------------------------------
  const config: CodeSlice[] = []
  const tests: CodeSlice[] = []
  if (mode.startsWith("max") && args.neighborhood) {
    for (const c of sortByProximity(args.neighborhood.configKeys ?? [], finding)) {
      const sl = windowSlice(projectPath, c.file, c.line, 3, "config")
      if (sl) config.push(sl)
    }
    for (const t of sortByProximity(args.neighborhood.tests ?? [], finding)) {
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

/**
 * Order an array of `(file, line)` IR hits by relevance to a finding:
 *   1. same-agent (when both finding and hit declare an agent),
 *   2. same-file as the finding,
 *   3. otherwise stable original order.
 *
 * This is a deterministic preference function used everywhere we have
 * a list of related IR nodes — it stops the trimmer from accidentally
 * dropping the only same-file related slice while keeping ten
 * unrelated ones.
 */
function sortByProximity<
  T extends { file: string; line: number; agent?: string | null | undefined },
>(items: T[], finding: BundleInputFinding): T[] {
  const findingAgent = (finding.agent ?? "").trim()
  const score = (t: T): number => {
    let s = 0
    if (findingAgent && (t.agent ?? "").trim() === findingAgent) s -= 2
    if (t.file === finding.file) s -= 1
    return s
  }
  return [...items].sort((a, b) => score(a) - score(b))
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
 * Drop the lowest-priority slices until the bundle fits the cap.
 *
 * Spec priority (high → low; trimmer drops in REVERSE):
 *
 *   1. primary finding line               — NEVER dropped
 *   2. source/sink taint slices           — dropped last, sinks before sources
 *   3. guards present/missing             — dropped after intermediate hops
 *   4. direct caller/callee               — dropped after related/config/tests
 *   5. related prompt/tool/route/config   — Pro/Max tail
 *   6. tests                              — first to go
 *
 * Within taint slices we drop function/intermediate nodes first,
 * then guards, then sinks, never sources unless absolutely necessary.
 * The surroundingSlice is treated as "context for the primary line"
 * and dropped just before we'd start cutting into the taint sinks.
 */
function trimToBudget(b: ContextBundle, cap: number): ContextBundle {
  // Drop one slice of a given internal-role from a CodeSlice array.
  // Stable: walks from the END (least relevant after proximity sort).
  const dropOneByRole = (arr: CodeSlice[], roles: Array<CodeSlice["role"]>): boolean => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (roles.includes(arr[i].role)) {
        arr.splice(i, 1)
        return true
      }
    }
    return false
  }
  const dropOneFromEnd = (arr: CodeSlice[]): boolean => {
    if (arr.length === 0) return false
    arr.pop()
    return true
  }

  const droppers: Array<() => boolean> = [
    // 6. tests
    () => dropOneFromEnd(b.tests),
    // 5b. config
    () => dropOneFromEnd(b.config),
    // 5a. related (tools → routes → prompts; lowest signal first)
    () => dropOneFromEnd(b.related.tools),
    () => dropOneFromEnd(b.related.routes),
    () => dropOneFromEnd(b.related.prompts),
    // 4. direct caller/callee
    () => dropOneFromEnd(b.neighborhood.callees),
    () => dropOneFromEnd(b.neighborhood.callers),
    // 2/3. taint intermediate nodes first, then guards
    () => dropOneByRole(b.taintPath.slices, ["taint-node"]),
    () => dropOneByRole(b.taintPath.slices, ["taint-guard"]),
    // Surrounding evidence is context for the primary line — drop it
    // just before we'd start cutting into the source/sink slices.
    () => {
      if (b.evidence.surroundingSlice) {
        b.evidence.surroundingSlice = undefined
        return true
      }
      return false
    },
    // 2a. taint sinks (still preserves sources when possible)
    () => dropOneByRole(b.taintPath.slices, ["taint-sink"]),
    // 2b. taint sources — last resort
    () => dropOneByRole(b.taintPath.slices, ["taint-source"]),
  ]

  let guard = 0
  while (sumTokens(b) > cap && guard < 5000) {
    let droppedSomething = false
    for (const drop of droppers) {
      if (sumTokens(b) <= cap) break
      if (drop()) droppedSomething = true
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
