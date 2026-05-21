export function RuntimeMetricsCard({ p95, errorRate }: { p95?: number; errorRate?: number }) {
  return <div className="rounded-lg border p-4 text-sm">p95: {p95 ?? "—"} ms · error rate: {errorRate ?? "—"}</div>
}
