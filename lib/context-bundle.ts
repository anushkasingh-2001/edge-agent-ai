/**
 * ContextBundle — the graph-bounded payload we send to an LLM INSTEAD
 * of whole files or whole repos.
 *
 * Core principle (enforced in server-context-bundle.ts): every byte that
 * reaches a model is a deliberately-selected, redacted slice anchored to
 * a finding's taint path and its IR neighborhood. There is no code path
 * that puts a full file into a bundle except the explicit, capped
 * `max-patch` escape hatch — and even that is gated by mode + token cap.
 *
 * This file is the SCHEMA + budgets only (no IO), so it can be imported
 * by both client and server, and asserted against in tests.
 */

export type IntelligenceMode = "save" | "auto" | "pro" | "max" | "manual"

/**
 * Hosted (Edge-Agent-operated key, plan-billed) vs BYOK (caller's own
 * key, billed to their provider account). Exported from this module
 * — instead of the server-only resolver — so client + server can
 * share a single wire-level definition without React Server / Client
 * boundary leaks.
 */
export type AiProviderMode = "hosted" | "byok"

export type ContextBundleMode =
  | "save-explain" // ≤ 1.5k tokens — finding + 3-line slice
  | "auto-small" // ≤ 4k — taint path + slices + 1-hop callers
  | "auto-large" // ≤ 12k — + 2-hop callers + callees + tests
  | "pro" // ≤ 12k — + related prompt/model/route/tool nodes
  | "max-plan" // ≤ 24k — full neighborhood + config + tests
  | "max-patch" // ≤ 24k — plan + neighborhood (full file only here, capped)
  | "manual" // user-selected, capped at 24k unless explicitly raised

/** Per-mode input-token caps. Output caps live in the model router. */
export const BUNDLE_INPUT_TOKEN_CAP: Record<ContextBundleMode, number> = {
  "save-explain": 1_500,
  "auto-small": 4_000,
  "auto-large": 12_000,
  pro: 12_000,
  "max-plan": 24_000,
  "max-patch": 24_000,
  manual: 24_000,
}

/** Rough chars→tokens divisor used for budgeting (no tokenizer dep). */
export const CHARS_PER_TOKEN = 4

export interface CodeSlice {
  file: string
  startLine: number
  endLine: number
  /** Redacted source text. NEVER raw — passes through ir/redact. */
  text: string
  /** IR node this slice anchors to, when known. */
  irNodeId?: string
  /** Why this slice is in the bundle (telemetry / debugging). */
  role?:
    | "primary"
    | "surrounding"
    | "taint-node"
    | "caller"
    | "callee"
    | "prompt"
    | "route"
    | "tool"
    | "config"
    | "test"
}

export interface IRNode {
  id: string
  kind:
    | "Source"
    | "Sink"
    | "Guard"
    | "Prompt"
    | "Model"
    | "Route"
    | "Tool"
    | "Config"
    | "Test"
    | "Function"
  subkind?: string // e.g. "UserInputSource", "CypherSink", "EnvMutationSink"
  file: string
  line: number
  symbol?: string
  label?: string
}

export interface IREdge {
  from: string
  to: string
  kind:
    | "taints"
    | "calls"
    | "guards"
    | "binds"
    | "renders"
    | "reads"
    | "writes"
    | "flows_to"
}

export interface BundleFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  title: string
  confidence: number
  /** Structural fingerprint (matches scanner finding_grouping). */
  fingerprint: string
  /** IR hash for caching across runs. */
  irHash: string
}

export interface ContextBundle {
  bundleVersion: "1.0"
  mode: ContextBundleMode
  finding: BundleFinding
  evidence: {
    primarySlice: CodeSlice
    surroundingSlice?: CodeSlice
  }
  taintPath: {
    nodes: IRNode[]
    edges: IREdge[]
    slices: CodeSlice[]
    guardsPresent: string[]
    guardsMissing: string[]
  }
  neighborhood: {
    callers: CodeSlice[]
    callees: CodeSlice[]
    relatedSymbols: string[]
  }
  related: {
    prompts: CodeSlice[]
    models: { provider: string; id: string }[]
    routes: CodeSlice[]
    tools: CodeSlice[]
  }
  config: CodeSlice[]
  tests: CodeSlice[]
  siblings?: {
    fingerprint: string
    count: number
    sampleIds: string[]
  }
  budget: {
    maxInputTokens: number
    maxOutputTokens: number
    estimatedInputTokens: number
    estimatedCostUsd: number
  }
  redaction: {
    secretsRedacted: number
    redactionVersion: string
  }
}

/** Map a user-facing mode + task into the concrete bundle mode. */
export function bundleModeFor(
  mode: IntelligenceMode,
  task: "explain" | "root_cause" | "suggest" | "patch" | "bulk",
): ContextBundleMode {
  switch (mode) {
    case "save":
      return "save-explain"
    case "auto":
      if (task === "explain") return "auto-small"
      if (task === "patch") return "auto-large"
      return "auto-small"
    case "pro":
      return "pro"
    case "max":
      return task === "patch" ? "max-patch" : "max-plan"
    case "manual":
      return "manual"
  }
}

/** Cheap char-based token estimate (no tokenizer dependency). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Total estimated tokens for a bundle's textual content. */
export function bundleInputTokens(bundle: ContextBundle): number {
  const slices: CodeSlice[] = [
    bundle.evidence.primarySlice,
    ...(bundle.evidence.surroundingSlice ? [bundle.evidence.surroundingSlice] : []),
    ...bundle.taintPath.slices,
    ...bundle.neighborhood.callers,
    ...bundle.neighborhood.callees,
    ...bundle.related.prompts,
    ...bundle.related.routes,
    ...bundle.related.tools,
    ...bundle.config,
    ...bundle.tests,
  ]
  const sliceTokens = slices.reduce((sum, s) => sum + estimateTokens(s.text), 0)
  const metaTokens = estimateTokens(
    JSON.stringify(bundle.finding) + bundle.finding.title,
  )
  return sliceTokens + metaTokens
}

/** True iff the bundle respects its mode's input token cap. */
export function bundleWithinBudget(bundle: ContextBundle): boolean {
  return bundle.budget.estimatedInputTokens <= bundle.budget.maxInputTokens
}

/** Assert no full-file slice leaked into a non-max bundle. A slice is
 *  considered "full file" if it spans more than this many lines. The
 *  max-patch mode is the only mode allowed to exceed it. */
export const MAX_NON_FULLFILE_SLICE_LINES = 80

export function bundleHasNoFullFiles(bundle: ContextBundle): boolean {
  if (bundle.mode === "max-patch") return true // explicitly allowed, still capped by tokens
  const all = [
    bundle.evidence.primarySlice,
    ...(bundle.evidence.surroundingSlice ? [bundle.evidence.surroundingSlice] : []),
    ...bundle.taintPath.slices,
    ...bundle.neighborhood.callers,
    ...bundle.neighborhood.callees,
    ...bundle.related.prompts,
    ...bundle.related.routes,
    ...bundle.related.tools,
    ...bundle.config,
    ...bundle.tests,
  ]
  return all.every((s) => s.endLine - s.startLine + 1 <= MAX_NON_FULLFILE_SLICE_LINES)
}
