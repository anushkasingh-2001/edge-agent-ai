/**
 * Tiny localStorage-backed cache of the *most recent* real policy
 * evaluation. This is what powers the "Export Policy Report" button
 * across the app — without it, every export site would have to keep
 * its own copy of the last gate result and they'd drift out of sync
 * the first time the user navigated between views.
 *
 * Design notes:
 *   - One global cache (per browser) keyed by `projectPath`. Multi-
 *     project users still see the report for the *currently opened*
 *     project, and switching projects flips which entry is "latest".
 *   - We only ever store a single result per project (most recent
 *     wins). Older results are not interesting because the policy or
 *     scan would have changed underneath them.
 *   - The shape is a strict superset of `PolicyApiResponse` — every
 *     existing renderer that takes a `PolicyApiResponse` will still
 *     work. The `meta` fields just describe the *operation* that
 *     produced the result (Branch Compare / Commit / Push / PR) and a
 *     few snippets of context the API response doesn't already carry.
 */

import type { PolicyApiResponse } from "@/lib/policy-client"
import type { ScanReport } from "@/lib/scan-report"

const STORAGE_KEY = "edge-agent-ai.latestPolicyResult"
const SCHEMA_VERSION = 1

export type PolicyOperation =
  | "branch-compare"
  | "commit"
  | "push"
  | "create-pr"
  | "test"

export interface LatestPolicyResultMeta {
  /** Project the gate ran against. Required so we never show a stale
   *  result from a different project after the user switches. */
  projectPath: string
  /** Display name of the project (best-effort; falls back to last
   *  path segment). */
  projectName: string | null
  /** Operation that produced this result. */
  operation: PolicyOperation
  /** When the gate ran (server's "evaluation time", not when this
   *  cache entry was written). */
  generatedAt: string
  /** Branches involved. `base`/`target` for branch-compare; for
   *  commit/push/PR `target` is the current branch and `base` is the
   *  configured base branch. */
  baseBranch: string | null
  targetBranch: string | null
  /** Short commit SHAs for the same. */
  baseSha: string | null
  targetSha: string | null
  /** Whether the gate also scanned stashed work alongside committed
   *  code. Branch Compare exposes this per-side; for commit/push it's
   *  always true (the scanner folds `stash@{0}` into the in-place
   *  scan by default). */
  baseIncludesStashes: boolean
  targetIncludesStashes: boolean
  /** Was the Git action actually performed? Only set when the
   *  operation followed through (e.g. commit succeeded, PR was
   *  opened). `null` for observational gates like branch-compare. */
  actionTaken: {
    commitCreated?: boolean
    pushed?: boolean
    prCreated?: boolean
    prNumber?: number | null
    prUrl?: string | null
  } | null
}

export interface LatestPolicyResult extends LatestPolicyResultMeta {
  /** The real PolicyApiResponse from /api/policy/evaluate (or the
   *  PR-create / commit / push routes which embed the same shape). */
  policy: PolicyApiResponse
  /** Snapshot of the target ScanReport at gate time, so the export
   *  can include risk-score / severity numbers without re-fetching
   *  the API. Stored lite (risk_score + summary + findings.slice) to
   *  keep localStorage small. */
  targetReport: {
    risk_score: number
    summary: ScanReport["summary"]
    generated_at: string
    findings: ScanReport["findings"]
  } | null
}

interface StoredEnvelope {
  version: number
  byProject: Record<string, LatestPolicyResult>
}

function readAll(): StoredEnvelope {
  if (typeof window === "undefined") {
    return { version: SCHEMA_VERSION, byProject: {} }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: SCHEMA_VERSION, byProject: {} }
    const parsed = JSON.parse(raw) as Partial<StoredEnvelope>
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== SCHEMA_VERSION ||
      !parsed.byProject ||
      typeof parsed.byProject !== "object"
    ) {
      // Wrong shape / older version → discard. Cache misses are
      // safe; the user simply needs to re-run a gate.
      return { version: SCHEMA_VERSION, byProject: {} }
    }
    return { version: SCHEMA_VERSION, byProject: parsed.byProject }
  } catch {
    return { version: SCHEMA_VERSION, byProject: {} }
  }
}

function writeAll(envelope: StoredEnvelope): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    /* localStorage full / unavailable — silently drop */
  }
}

/**
 * Persist a new latest-policy-result for a given project. Overwrites
 * any previous entry for the same project (we only ever care about
 * the most recent gate run).
 */
export function saveLatestPolicyResult(result: LatestPolicyResult): void {
  if (!result.projectPath) return
  const all = readAll()
  all.byProject[result.projectPath] = result
  writeAll(all)
  // Also broadcast for in-tab subscribers so the Export button can
  // re-enable itself without polling localStorage. Cross-tab is
  // already handled by the native `storage` event.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("edge-agent-ai:policy-result-saved"))
  }
}

/**
 * Read the latest policy result for a given project, or null when
 * nothing has been run yet.
 */
export function getLatestPolicyResult(
  projectPath: string | null | undefined
): LatestPolicyResult | null {
  if (!projectPath) return null
  const all = readAll()
  return all.byProject[projectPath] ?? null
}

/**
 * Clear the cache for a single project (or all projects when no path
 * is supplied). Useful for the "I'm done with this scan, don't
 * surface stale gate results" case.
 */
export function clearLatestPolicyResult(projectPath?: string): void {
  const all = readAll()
  if (projectPath) {
    delete all.byProject[projectPath]
  } else {
    all.byProject = {}
  }
  writeAll(all)
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("edge-agent-ai:policy-result-saved"))
  }
}
