export function RepoTree({ files = [], onSelect }: { files?: string[]; onSelect?: (file: string) => void }) {
  return (
    <div className="text-sm">
      {files.map((f) => (
        <button key={f} className="block w-full text-left px-2 py-1 hover:bg-muted" onClick={() => onSelect?.(f)}>
          {f}
        </button>
      ))}
    </div>
  )
}
