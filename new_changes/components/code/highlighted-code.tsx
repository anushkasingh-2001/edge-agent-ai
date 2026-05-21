export function HighlightedCode({ code }: { code: string }) {
  return <pre className="overflow-auto rounded-lg border p-3 text-xs"><code>{code}</code></pre>
}
