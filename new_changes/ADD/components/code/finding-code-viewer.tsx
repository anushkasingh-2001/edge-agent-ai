export function FindingCodeViewer({ code, line }: { code: string; line?: number }) {
  return (
    <pre className="overflow-auto rounded-lg border p-3 text-xs">
      <code>{line ? `// line ${line}\n` : ""}{code}</code>
    </pre>
  )
}
