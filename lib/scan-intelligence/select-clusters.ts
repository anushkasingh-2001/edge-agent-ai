/**
 * Decide which finding clusters get sent to the LLM verifier for a given
 * mode, and in what ORDER. Cost control + harm-aware routing live here.
 *
 * This replaces the old simple "matches a risky pattern? select it" logic
 * with a deterministic PRIORITY SCORE (see `priorityScore`). Per mode:
 *   - Lite selects nothing (0 AI calls).
 *   - Balanced selects only top high-value clusters: critical/high, risky
 *     side-effect surfaces, weak confidence, agent-reachable.
 *   - Deep adds medium findings near risky tools/routes/prompts, cross-file
 *     flows, short/vague prompts, and ambiguous clusters.
 *   - Exhaustive reviews broadly.
 * In every non-lite mode the returned list is ordered by descending
 * priority so the AI-call budget (enforced in enhance-scan-report) is spent
 * on the highest-harm clusters first.
 *
 * Pure + deterministic — no LLM, no IO.
 */
import type { Cluster, RiskSurface, ScanMode, ScanFinding } from "./types"

/** Optional signals the caller may supply to refine ordering. */
export interface SelectionContext {
  /** Project-relative paths that were added/modified (branch diff / working
   *  tree). When provided, clusters in changed files are prioritised. Entries
   *  should be normalised via `normalizeRelPath`; lookups normalise too. */
  changedFiles?: ReadonlySet<string>
}

/**
 * Normalise a path to a canonical project-relative form for comparison:
 *   - backslashes -> "/"
 *   - duplicate slashes collapsed
 *   - leading "./" segments stripped
 *   - absolute paths returned as null UNLESS they sit inside `root`, in
 *     which case they are made relative to it.
 *
 * Returns `null` when the path cannot be safely normalised to a relative
 * path (empty, or absolute-and-outside-root) — callers must NOT guess.
 */
export function normalizeRelPath(p: unknown, root?: string): string | null {
  if (typeof p !== "string") return null
  let s = p.trim()
  if (s === "") return null
  s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/")
  s = s.replace(/^(?:\.\/)+/, "")
  const isAbs = s.startsWith("/") || /^[a-zA-Z]:\//.test(s)
  if (isAbs) {
    if (!root) return null
    const r = root.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "")
    if (s === r) return null
    if (!s.startsWith(r + "/")) return null
    s = s.slice(r.length + 1).replace(/^(?:\.\/)+/, "")
  }
  return s === "" ? null : s
}

// ---------------------------------------------------------------------------
// Component signals (all deterministic, derived from scanner-owned fields)
// ---------------------------------------------------------------------------

/** Rule families / categories whose findings are inherently high-risk and
 *  noisy enough to warrant verification. Matched loosely against
 *  rule_id + sink kind + category. */
const RISKY_PATTERNS =
  /prompt[-_ ]?inject|command|os\.system|subprocess|shell|eval|exec|dangerous[-_ ]?code|sql|cypher|injection|model[-_ ]?download|dependency|auth|mcp|tool|vague|underspecified/i

/** Surfaces/categories that point at prompt / tool / route proximity. */
const PROMPT_TOOL_ROUTE_PATTERNS =
  /prompt|tool|route|api|mcp|llm|model|agent/i

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 100,
  high: 60,
  medium: 30,
  low: 10,
}

const WEAK_CONFIDENCE_THRESHOLD = 0.6

function clusterText(c: Cluster): string {
  return `${c.ruleId} ${c.sinkKind} ${c.representative.category}`
}

/** Harm score by the kind of damage the surface can do. Highest for
 *  command exec / payments, then DB writes / auth bypass, then external
 *  side effects (email/calendar/github/deploy), MCP, supply-chain, prompt
 *  injection. */
export function harmScore(c: Cluster): number {
  const t = clusterText(c).toLowerCase()
  if (/os\.system|subprocess|\bshell\b|\bexec\b|\beval\b|command[-_ ]?exec|command[-_ ]?inject/.test(t))
    return 40
  if (/refund|charge|payment|transfer|wire\b|invoice/.test(t)) return 40
  if (/\bsql\b|cypher|db[-_ ]?write|database|\bquery\b|injection/.test(t)) return 35
  if (/auth|authorization|authentication|permission|access[-_ ]?control/.test(t)) return 35
  if (/email|calendar|github|deploy|rollback|release|delete|remove/.test(t)) return 30
  if (/\bmcp\b/.test(t)) return 25
  if (/model[-_ ]?download|supply|dependency|deserial|pickle/.test(t)) return 25
  if (/prompt[-_ ]?inject|prompt[-_ ]?contract|vague|underspecified/.test(t)) return 20
  return 0
}

export function clusterIsRisky(c: Cluster): boolean {
  return RISKY_PATTERNS.test(clusterText(c))
}

export function clusterIsWeakConfidence(c: Cluster): boolean {
  const conf = c.representative.confidence
  return typeof conf === "number" && conf < WEAK_CONFIDENCE_THRESHOLD
}

export function isHighOrCritical(c: Cluster): boolean {
  return c.maxSeverity === "critical" || c.maxSeverity === "high"
}

/** Agent-reachable when the representative finding is attributed to a known
 *  agent (the Python attribution pass fills `agent`; "unknown" means not
 *  attributed). */
export function isAgentReachable(c: Cluster): boolean {
  const agent = (c.representative as ScanFinding).agent
  return typeof agent === "string" && agent.trim() !== "" && agent !== "unknown"
}

function isPromptToolRouteProximal(c: Cluster): boolean {
  return PROMPT_TOOL_ROUTE_PATTERNS.test(clusterText(c))
}

function isVagueOrPrompt(c: Cluster): boolean {
  return /vague|prompt/i.test(`${c.ruleId} ${c.representative.category}`)
}

/**
 * Deterministic priority score for verification routing. Higher = review
 * sooner. All inputs are scanner-owned facts; no LLM involved.
 *
 *   priorityScore =
 *       severityWeight
 *     + harmScore(riskSurface)
 *     + weakConfidenceBonus
 *     + agentReachableBonus
 *     + externalSideEffectBonus
 *     + crossFileBonus
 *     + promptToolRouteProximityBonus
 *     + changedCodeBonusIfAvailable
 *     - duplicateClusterPenalty
 */
export function priorityScore(c: Cluster, ctx: SelectionContext = {}): number {
  let score = SEVERITY_WEIGHT[c.maxSeverity] ?? 0
  const harm = harmScore(c)
  score += harm
  if (clusterIsWeakConfidence(c)) score += 25
  if (isAgentReachable(c)) score += 20
  // External side-effect proxy: a harmful sink category implies an external
  // side effect (exec/db-write/network/payments/etc).
  if (harm > 0) score += 10
  if (c.crossFile) score += 15
  if (isPromptToolRouteProximal(c)) score += 10
  if (ctx.changedFiles) {
    const norm = normalizeRelPath(c.file)
    if (norm && ctx.changedFiles.has(norm)) score += 20
  }
  // Duplicate-cluster penalty: a cluster that merely repeats the same root
  // cause many times has low marginal review value. The representative
  // already stands for the group; lightly deprioritise very large groups.
  const dups = Math.max(0, c.findings.length - 1)
  score -= Math.min(dups * 2, 10)
  return score
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

/** Stable deterministic ordering: priority desc, then severity, file, line. */
function orderByPriority(clusters: Cluster[], ctx: SelectionContext): Cluster[] {
  return [...clusters].sort((a, b) => {
    const pb = priorityScore(b, ctx) - priorityScore(a, ctx)
    if (pb !== 0) return pb
    const sev = (SEV_RANK[a.maxSeverity] ?? 9) - (SEV_RANK[b.maxSeverity] ?? 9)
    if (sev !== 0) return sev
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return (a.representative.line ?? 0) - (b.representative.line ?? 0)
  })
}

/** Clusters the verifier should review for a mode, ordered by priority. */
export function selectClustersForMode(
  clusters: Cluster[],
  mode: ScanMode,
  ctx: SelectionContext = {},
): Cluster[] {
  if (mode === "lite") return []

  let candidates: Cluster[]
  if (mode === "balanced") {
    // Top high-value only: critical/high, risky side-effect surfaces, weak
    // confidence, agent-reachable.
    candidates = clusters.filter(
      (c) =>
        isHighOrCritical(c) ||
        clusterIsRisky(c) ||
        clusterIsWeakConfidence(c) ||
        isAgentReachable(c),
    )
  } else if (mode === "deep") {
    // All Balanced candidates PLUS medium near risky tools/routes/prompts,
    // cross-file flows, short/vague prompts, and ambiguous clusters.
    candidates = clusters.filter(
      (c) =>
        isHighOrCritical(c) ||
        clusterIsRisky(c) ||
        clusterIsWeakConfidence(c) ||
        isAgentReachable(c) ||
        c.crossFile ||
        c.maxSeverity === "medium" ||
        isVagueOrPrompt(c),
    )
  } else {
    // exhaustive: review everything, still ordered by priority.
    candidates = [...clusters]
  }

  return orderByPriority(candidates, ctx)
}

/** Risky surfaces the gap auditor should review for a mode, capped by
 *  `maxSurfaces`. Higher-risk kinds are prioritised. */
export function selectSurfacesForMode(
  surfaces: RiskSurface[],
  mode: ScanMode,
  maxSurfaces: number,
): RiskSurface[] {
  if (mode === "lite" || maxSurfaces <= 0) return []

  const priority: Record<string, number> = {
    prompt_template: 0,
    llm_call: 1,
    tool_definition: 2,
    mcp_handler: 3,
    subprocess_wrapper: 4,
    db_query: 5,
    auth_route: 6,
    api_route: 7,
    model_download: 8,
    config_env_file: 9,
  }
  const ordered = [...surfaces].sort(
    (a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99),
  )
  return ordered.slice(0, maxSurfaces)
}
