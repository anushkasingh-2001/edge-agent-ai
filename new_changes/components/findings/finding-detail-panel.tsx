import { SuggestedPatchView } from "@/components/code/suggested-patch-view"
import type { UiFinding } from "@/lib/scan-report"

export function FindingDetailPanel({ finding }: { finding: UiFinding }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">{finding.title}</h3>
        <p className="text-sm text-muted-foreground">{finding.file}:{finding.line}</p>
      </div>
      <p className="text-sm">{finding.reason}</p>
      <pre className="rounded-lg border p-3 text-xs overflow-auto"><code>{finding.code}</code></pre>
      <SuggestedPatchView diff={finding.suggestedPatch?.unified_diff ?? null} />
    </div>
  )
}
