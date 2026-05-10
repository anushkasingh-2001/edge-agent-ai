/**
 * Typed fetchers for /api/policy/evaluate. Kept separate from
 * `lib/git-client.ts` so the policy plumbing stays a single concern.
 */

import type { ScanReport, WorkingTreeStatus } from "@/lib/scan-report"
import type {
  EvalMetrics,
  Policy,
  PolicyEvalContext,
  PolicyEvaluation,
} from "@/lib/policy"

export interface PolicyApiResponse {
  policy: Policy
  policySource: "file" | "default"
  policyErrors: string[]
  policyPath: string | null
  /** null on the GET endpoint, populated on POST. */
  evaluation: PolicyEvaluation | null
  /** Where the `baseReport` came from when evaluating. Lets the UI
   *  show "compared against main@abc1234" and explain why a card
   *  reads "block" when the user might think nothing changed. */
  baseSource?: "request" | "base_branch" | "snapshot" | "none"
  baseBranch?: string | null
  baseSha?: string | null
  /** ISO timestamp the base scan was captured. Shown as "scanned 5m ago"
   *  to help users spot a stale baseline. */
  baseCachedAt?: string | null
  /** Headline risk + summary of the base scan, mirrored back so the
   *  UI doesn't have to make a second round-trip to render the
   *  "main@abc1234 · risk 87 · high 5" comparison context. */
  baseRiskScore?: number | null
  baseSummary?: {
    critical: number
    high: number
    medium: number
    low: number
    total: number
  } | null
  /** Working-tree state captured at scan time on the *target* report.
   *  When `clean === false` the policy card surfaces a warning so users
   *  know the scan they're looking at includes uncommitted edits and
   *  isn't directly comparable to the base branch's pristine HEAD. */
  targetWorkingTree?: WorkingTreeStatus | null
  /** Server-side error string (only present on 4xx/5xx). */
  error?: string
  issues?: { path: string; message: string }[]
}

export async function loadPolicy(projectPath: string): Promise<PolicyApiResponse> {
  const url = `/api/policy/evaluate?projectPath=${encodeURIComponent(
    projectPath
  )}`
  const res = await fetch(url, { method: "GET" })
  return (await res.json()) as PolicyApiResponse
}

export async function evaluatePolicyApi(args: {
  projectPath: string
  targetReport: ScanReport
  baseReport?: ScanReport
  targetMetrics?: EvalMetrics
  baseMetrics?: EvalMetrics
  context?: PolicyEvalContext
  /** Force a fresh scan of the base branch, ignoring the on-disk
   *  cache. The "Re-scan main" button passes this. */
  refreshBase?: boolean
  /** Set to false to disable the auto-fetch of `baseReport` when
   *  the caller didn't supply one. Default true. */
  autoLoadBase?: boolean
}): Promise<PolicyApiResponse> {
  const res = await fetch("/api/policy/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return (await res.json()) as PolicyApiResponse
}
