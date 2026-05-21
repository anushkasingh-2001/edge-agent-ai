export function SuggestedPatchView({ diff }: { diff?: string | null }) {
  if (!diff) return <p className="text-sm text-muted-foreground">No patch suggestion available.</p>
  return <pre className="overflow-auto rounded-lg border p-3 text-xs"><code>{diff}</code></pre>
}
