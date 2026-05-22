import { SuggestedPatchView } from "@/components/code/suggested-patch-view"
import type { UiFinding } from "@/lib/scan-report"
import { parseFindingReason } from "@/lib/finding-explanations"

export function FindingDetailPanel({ finding }: { finding: UiFinding }) {
  const explanation = parseFindingReason(finding.reason)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">{finding.title}</h3>
        <p className="text-sm text-muted-foreground">{finding.file}:{finding.line}</p>
      </div>

      {explanation.structured ? (
        <div className="space-y-3 text-sm">
          {explanation.whatDetected && (
            <Section title="What was detected">{explanation.whatDetected}</Section>
          )}
          {explanation.whyRisky && (
            <Section title="Why it can be risky">{explanation.whyRisky}</Section>
          )}
          {explanation.whyMayBeOk && (
            <Section title="Why this may be okay">{explanation.whyMayBeOk}</Section>
          )}
          {explanation.whatToVerify && (
            <Section title="What to verify">{explanation.whatToVerify}</Section>
          )}
        </div>
      ) : (
        <p className="text-sm">{explanation.legacyReason}</p>
      )}

      <pre className="rounded-lg border p-3 text-xs overflow-auto">
        <code>{finding.code}</code>
      </pre>
      <div className="text-sm">
        <p className="font-medium mb-1">Suggested fix</p>
        <p className="text-muted-foreground">{finding.suggestedFix}</p>
      </div>
      <SuggestedPatchView diff={finding.suggestedPatch?.unified_diff ?? null} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground mt-0.5 leading-relaxed">{children}</p>
    </div>
  )
}
