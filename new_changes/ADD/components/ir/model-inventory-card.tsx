export function ModelInventoryCard({ models = [] }: { models?: Array<{ model: string; provider?: string | null; purpose?: string | null }> }) {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="font-semibold">Models</h3>
      {models.map((m, i) => (
        <div key={i} className="text-sm">{m.provider ?? "unknown"} / {m.model} — {m.purpose ?? "unknown purpose"}</div>
      ))}
    </div>
  )
}
