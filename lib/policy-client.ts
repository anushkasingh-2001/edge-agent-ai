/**
 * Typed fetchers for /api/policy/evaluate. Kept separate from
 * `lib/git-client.ts` so the policy plumbing stays a single concern.
 */

import type { ScanReport } from "@/lib/scan-report"
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
}): Promise<PolicyApiResponse> {
  const res = await fetch("/api/policy/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return (await res.json()) as PolicyApiResponse
}
