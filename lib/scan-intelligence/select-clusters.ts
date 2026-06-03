/**
 * Decide which finding clusters get sent to the LLM verifier for a given
 * mode. Cost control lives here: Lite selects nothing; Balanced selects
 * only risky/noisy clusters; Deep widens to medium/ambiguous/cross-file;
 * Exhaustive reviews broadly.
 *
 * Pure + deterministic — no LLM, no IO.
 */
import type { Cluster, RiskSurface, ScanMode } from "./types"

/** Rule families / categories whose findings are inherently high-risk
 *  and noisy enough to warrant verification (spec: Balanced "verifier
 *  checks only"). Matched loosely against rule_id + sink kind. */
const RISKY_PATTERNS =
  /prompt[-_ ]?inject|command|os\.system|subprocess|shell|eval|exec|dangerous[-_ ]?code|sql|cypher|injection|model[-_ ]?download|dependency|auth|mcp|tool/i

function clusterIsRisky(c: Cluster): boolean {
  return RISKY_PATTERNS.test(`${c.ruleId} ${c.sinkKind} ${c.representative.category}`)
}

function clusterIsWeakConfidence(c: Cluster): boolean {
  const conf = c.representative.confidence
  return typeof conf === "number" && conf < 0.6
}

function isHighOrCritical(c: Cluster): boolean {
  return c.maxSeverity === "critical" || c.maxSeverity === "high"
}

/** Clusters the verifier should review, ordered by severity. */
export function selectClustersForMode(clusters: Cluster[], mode: ScanMode): Cluster[] {
  if (mode === "lite") return []

  let selected: Cluster[]
  if (mode === "balanced") {
    // High/critical + known-risky/noisy + weak-confidence clusters only.
    selected = clusters.filter(
      (c) => isHighOrCritical(c) || clusterIsRisky(c) || clusterIsWeakConfidence(c),
    )
  } else if (mode === "deep") {
    // All high/critical + medium that touch risky surfaces + cross-file
    // + weak-confidence + ambiguous.
    selected = clusters.filter(
      (c) =>
        isHighOrCritical(c) ||
        c.crossFile ||
        clusterIsRisky(c) ||
        clusterIsWeakConfidence(c) ||
        c.maxSeverity === "medium",
    )
  } else {
    // exhaustive: review everything.
    selected = [...clusters]
  }

  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return selected.sort((a, b) => (rank[a.maxSeverity] ?? 9) - (rank[b.maxSeverity] ?? 9))
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
