"use client"

import { AgentModelMetricsTable } from "@/components/behavioral/agent-model-metrics-table"
import type { BehavioralReport } from "@/lib/behavioral-report"

// Merge this section into your existing Evaluations view instead of blindly
// replacing your whole file if you already have state/buttons/tabs there.
export function EvaluationsMetricsSection({ report }: { report: BehavioralReport | null }) {
  return (
    <div className="space-y-4">
      {report?.harness_status !== "configured" && (
        <div className="rounded-2xl border p-4">
          <h3 className="font-semibold">Behavioral harness not configured</h3>
          <p className="mt-2 text-sm opacity-70">
            Edge Agent AI can generate probes, but real pass/fail accuracy and runtime
            require a runnable harness. Add .edgeagent/evals.yaml or run Auto Harness discovery.
          </p>
        </div>
      )}

      <AgentModelMetricsTable report={report} />
    </div>
  )
}
