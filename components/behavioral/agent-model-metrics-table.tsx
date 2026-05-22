"use client"

import type { BehavioralReport } from "@/lib/behavioral-report"

function fmtPct(v?: number | null) {
  if (v === null || v === undefined) return "—"
  return `${Math.round(v * 100)}%`
}

function fmtMs(v?: number | null) {
  if (v === null || v === undefined) return "—"
  return `${Math.round(v)} ms`
}

function fmtUsd(v?: number | null) {
  if (v === null || v === undefined) return "—"
  return `$${v.toFixed(4)}`
}

export function AgentModelMetricsTable({ report }: { report: BehavioralReport | null }) {
  if (!report) return null

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border p-4">
        <h3 className="text-lg font-semibold">Overall behavioral metrics</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Metric label="Accuracy" value={fmtPct(report.overall_metrics?.accuracy)} />
          <Metric label="p95 runtime" value={fmtMs(report.overall_metrics?.p95_runtime_ms)} />
          <Metric label="Model calls" value={String(report.overall_metrics?.total_model_calls ?? 0)} />
          <Metric label="Tool calls" value={String(report.overall_metrics?.total_tool_calls ?? 0)} />
          <Metric label="Cost" value={fmtUsd(report.overall_metrics?.total_cost_usd)} />
        </div>
      </section>

      <section className="rounded-2xl border p-4">
        <h3 className="text-lg font-semibold">By agent</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-70">
                <th className="py-2">Agent</th>
                <th>Accuracy</th>
                <th>p95 runtime</th>
                <th>Model calls</th>
                <th>Tool calls</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(report.agent_metrics ?? []).map((m) => (
                <tr key={m.agent_id} className="border-t">
                  <td className="py-2">{m.agent_name ?? m.agent_id}</td>
                  <td>{fmtPct(m.accuracy)}</td>
                  <td>{fmtMs(m.p95_runtime_ms)}</td>
                  <td>{m.model_calls}</td>
                  <td>{m.tool_calls}</td>
                  <td>{fmtUsd(m.total_cost_usd)}</td>
                </tr>
              ))}
              {(!report.agent_metrics || report.agent_metrics.length === 0) && (
                <tr>
                  <td className="py-4 opacity-60" colSpan={6}>
                    No agent metrics yet. Run behavioral tests with tracing enabled.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border p-4">
        <h3 className="text-lg font-semibold">By helper model</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left opacity-70">
                <th className="py-2">Agent</th>
                <th>Model</th>
                <th>Purpose</th>
                <th>Calls</th>
                <th>p95 latency</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {(report.model_metrics ?? []).map((m) => (
                <tr key={`${m.agent_id ?? "unknown"}:${m.model_id}`} className="border-t">
                  <td className="py-2">{m.agent_name ?? m.agent_id ?? "unknown"}</td>
                  <td>{m.model_name ?? m.model_id}</td>
                  <td>{m.model_purpose ?? "—"}</td>
                  <td>{m.calls}</td>
                  <td>{fmtMs(m.p95_latency_ms)}</td>
                  <td>{(m.input_tokens ?? 0) + (m.output_tokens ?? 0)}</td>
                  <td>{fmtUsd(m.total_cost_usd)}</td>
                </tr>
              ))}
              {(!report.model_metrics || report.model_metrics.length === 0) && (
                <tr>
                  <td className="py-4 opacity-60" colSpan={7}>
                    No model metrics yet. Runtime traces must include model_call events.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-xs opacity-60">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  )
}
