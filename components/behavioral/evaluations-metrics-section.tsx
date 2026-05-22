"use client"

import { AgentModelMetricsTable } from "@/components/behavioral/agent-model-metrics-table"
import type { BehavioralReport } from "@/lib/behavioral-report"

/**
 * Optional add-on section for the Evaluations view that renders per-agent and
 * per-model behavioral metrics from a {@link BehavioralReport}.
 *
 * This component is intentionally separate from `components/views/evaluations.tsx`
 * so the existing 1491-line view (with its eval runner UI, history, stash
 * handling, etc.) is preserved unchanged. The new metrics surface can be
 * dropped into the existing view as a side panel or under a new tab once the
 * behavioral runner is wired up to return a `BehavioralReport`.
 *
 * Pass `report = null` while the report is loading or absent; the component
 * renders an explanatory empty state instead of pretending to have data.
 */
export function EvaluationsMetricsSection({
  report,
}: {
  report: BehavioralReport | null
}) {
  return (
    <div className="space-y-4">
      {report?.harness_status !== "configured" && (
        <div className="rounded-2xl border p-4">
          <h3 className="font-semibold">Behavioral harness not configured</h3>
          <p className="mt-2 text-sm opacity-70">
            Edge Agent AI can generate probes, but real pass/fail accuracy and runtime
            require a runnable harness. Add{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">.edgeagent/evals.yaml</code>{" "}
            or run Auto Harness discovery.
          </p>
        </div>
      )}

      <AgentModelMetricsTable report={report} />
    </div>
  )
}
