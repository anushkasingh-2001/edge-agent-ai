"use client"

/**
 * Plan summary client helper. Fetches GET /api/plan — the SAFE view of
 * the user's subscription (tier, allowed modes, manual permission,
 * remaining credits). No provider keys are ever returned.
 *
 * The UI uses this to disable Pro/Max/Manual the plan doesn't include,
 * show Hosted credits, and (Manual) only offer plan-allowed models.
 */

import { useEffect, useState } from "react"

export interface PlanSummary {
  tier: "free" | "pro" | "enterprise"
  allowedModes: Array<"save" | "auto" | "pro" | "max" | "manual">
  allowManualModelSelection: boolean
  creditsTotal: number
  creditsUsed: number
  creditsRemaining: number
}

export async function fetchPlanSummary(signal?: AbortSignal): Promise<PlanSummary | null> {
  try {
    const res = await fetch("/api/plan", { signal })
    if (!res.ok) return null
    const json = (await res.json()) as { plan?: PlanSummary }
    return json.plan ?? null
  } catch {
    return null
  }
}

export function usePlanSummary(): { plan: PlanSummary | null; loading: boolean } {
  const [plan, setPlan] = useState<PlanSummary | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const c = new AbortController()
    fetchPlanSummary(c.signal)
      .then((p) => setPlan(p))
      .finally(() => setLoading(false))
    return () => c.abort()
  }, [])
  return { plan, loading }
}

/** True when the plan permits this intelligence mode. */
export function modeAllowedByPlan(
  plan: PlanSummary | null,
  mode: "save" | "auto" | "pro" | "max" | "manual",
): boolean {
  if (!plan) return true // optimistic until loaded; server still enforces
  return plan.allowedModes.includes(mode)
}
