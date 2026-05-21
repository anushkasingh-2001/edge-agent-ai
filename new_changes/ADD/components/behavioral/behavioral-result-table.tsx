export function BehavioralResultTable({ results = [] }: { results?: Array<{ title: string; status: string; reason?: string }> }) {
  return (
    <table className="w-full text-sm">
      <thead><tr><th className="text-left">Case</th><th>Status</th><th>Reason</th></tr></thead>
      <tbody>{results.map((r, i) => <tr key={i}><td>{r.title}</td><td>{r.status}</td><td>{r.reason}</td></tr>)}</tbody>
    </table>
  )
}
