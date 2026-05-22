"use client"

import { useEffect, useRef, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  MessageSquare,
  Eye,
  X,
  TestTube,
  FileCode,
  AlertTriangle,
  Lightbulb,
  Code,
  Sparkles,
  Loader2,
} from "lucide-react"
import type { Finding } from "@/components/views/findings"
import { FindingFixButton } from "@/components/finding-fix-button"
import type { FixTarget, RunFixesResult } from "@/lib/finding-fixes-client"
import {
  isPresenceWarningCategory,
  parseFindingReason,
  presenceWarningBadgeLabel,
} from "@/lib/finding-explanations"
import {
  type AIExplanationResponse,
  explanationSourceBadge,
  explanationSourceTone,
  fetchFindingExplanation,
} from "@/lib/finding-explanation-client"

interface FindingDrawerProps {
  finding: Finding | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Required for the fix engine to find the file on disk. When absent
   *  the "Fix this" dropdown is disabled with a helpful tooltip. */
  projectPath?: string | null
  /** Called after a successful apply so the parent can re-scan / refresh
   *  the findings list. */
  onFixApplied?: (result: RunFixesResult) => void
}

export function FindingDrawer({
  finding,
  open,
  onOpenChange,
  projectPath = null,
  onFixApplied,
}: FindingDrawerProps) {
  // AI explanation state. Lives at the drawer level so it resets whenever
  // the user closes the drawer or opens a different finding — we never
  // bleed one finding's explanation into another's panel.
  const [aiExplanation, setAiExplanation] = useState<AIExplanationResponse | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const lastRequestKey = useRef<string | null>(null)

  // Trigger AI explanation exactly when the drawer becomes visible for a
  // specific finding. The effect is keyed on the scanner finding id so
  // opening the SAME finding twice in a row deduplicates the call.
  //
  // Note: this is the ONLY place in the app that calls /api/finding/explain.
  // List rendering, scan completion, and detail-panel mount do NOT trigger
  // it on their own — opening a finding is the explicit consent gesture.
  useEffect(() => {
    if (!open || !finding || !projectPath) {
      return
    }
    const key = `${projectPath}::${finding.scannerFindingId ?? finding.id}`
    if (lastRequestKey.current === key && (aiExplanation || aiError)) {
      return
    }
    lastRequestKey.current = key

    const controller = new AbortController()
    setAiExplanation(null)
    setAiError(null)
    setAiLoading(true)

    fetchFindingExplanation({
      projectPath,
      finding,
      signal: controller.signal,
    })
      .then((res) => {
        setAiExplanation(res)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setAiError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setAiLoading(false)
      })

    return () => controller.abort()
    // We intentionally do NOT re-fetch when projectPath/finding identity
    // is stable — only on real open transitions or finding switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, finding?.scannerFindingId, finding?.id, projectPath])

  // Reset when drawer fully closes so a future open re-fetches cleanly.
  useEffect(() => {
    if (!open) {
      lastRequestKey.current = null
      setAiExplanation(null)
      setAiError(null)
      setAiLoading(false)
    }
  }, [open])

  if (!finding) return null

  const templateExplanation = parseFindingReason(finding.reason)
  const presenceWarning = isPresenceWarningCategory(finding.category)
  const presenceBadge = presenceWarningBadgeLabel(finding.category)

  const severityBadgeClass = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-500/10 text-red-400 border-red-500/20"
      case "high":
        return "bg-orange-500/10 text-orange-400 border-orange-500/20"
      case "medium":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
      case "low":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20"
      default:
        return ""
    }
  }

  const severityIcon = (severity: string) => {
    const colorClass =
      severity === "critical"
        ? "text-red-400"
        : severity === "high"
          ? "text-orange-400"
          : severity === "medium"
            ? "text-yellow-400"
            : "text-blue-400"
    return <AlertTriangle className={`h-5 w-5 ${colorClass}`} />
  }

  // The fix engine needs a scanner rule_id to pick a template. We
  // require it before showing the Fix dropdown — better than offering
  // an option that always falls back to the generic TODO marker.
  const target: FixTarget | null = finding.ruleId
    ? {
        ref_id: finding.scannerFindingId ?? String(finding.id),
        rule_id: finding.ruleId,
        file: finding.file,
        line: finding.line,
        title: finding.title,
      }
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[600px] sm:max-w-[600px] bg-card border-border overflow-y-auto">
        <SheetHeader className="space-y-4">
          <div className="flex items-start gap-3">
            {severityIcon(finding.severity)}
            <div className="flex-1">
              <SheetTitle className="text-lg font-semibold leading-tight">
                {finding.title}
              </SheetTitle>
              <div className="flex items-center gap-2 mt-2">
                <Badge variant="outline" className={severityBadgeClass(finding.severity)}>
                  {finding.severity}
                </Badge>
                <Badge variant="outline" className="bg-secondary/50">
                  {finding.category}
                </Badge>
                {presenceBadge && (
                  <Badge
                    variant="outline"
                    className="bg-blue-500/10 text-blue-300 border-blue-500/25"
                  >
                    {presenceBadge}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Location */}
          <div className="flex items-center gap-4 p-3 rounded-lg bg-secondary/30">
            <FileCode className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1">
              <div className="font-mono text-sm">{finding.file}:{finding.line}</div>
              <div className="text-xs text-muted-foreground">
                Agent: {finding.agent && finding.agent !== "—" ? finding.agent : "unknown"}
              </div>
              {presenceWarning && (
                <p className="text-xs text-blue-300/90 mt-1 leading-snug">
                  No agent in this project is linked to this call. Severity reflects code
                  presence only — not a confirmed agent exploit path.
                </p>
              )}
            </div>
          </div>

          <Separator className="bg-border" />

          {/*
            Explanation block. Behaviour:
            - While the AI request is in flight, show a single "Generating
              project-specific explanation…" skeleton — we do NOT show the
              deterministic template as the main explanation up front because
              that would teach users to ignore the AI panel.
            - When AI returns, show ITS sections with an "AI explanation" /
              "Cached AI explanation" badge.
            - If AI fails / key missing / timeout, show the deterministic
              template sections with a "Template fallback" badge so the user
              still gets the scanner's explanation.
            - If no projectPath is available (user hasn't selected a project
              yet), there is nothing to personalize against, so we just show
              the deterministic template silently — no badge, no loading.
          */}
          <ExplanationBlock
            ai={aiExplanation}
            loading={aiLoading}
            error={aiError}
            template={templateExplanation}
            hasProjectPath={!!projectPath}
          />

          {/* Evidence */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Eye className="h-4 w-4 text-blue-400" />
              Evidence
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {finding.evidence}
            </p>
          </div>

          {/* Code Involved.
              The scanner now plumbs the verbatim call expression (e.g.
              `os.system("rm -rf " + user_input)`) into `finding.code`,
              not just the normalized sink name (`os.system`). When the
              title carries the normalized sink (the standalone-sink
              titles look like "OS command call: <label> (...)"), we
              surface it as a small sub-label so the developer can see
              both the canonical sink id AND the exact call. */}
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Code className="h-4 w-4 text-muted-foreground" />
              Code Involved
            </h3>
            {(() => {
              const sinkLabel = extractSinkLabel(finding.title)
              // Only render the sink-label sub-line when it adds
              // information beyond the code block itself. If the code
              // we'd render IS the sink label (e.g. extractor couldn't
              // recover the call expression and fell back to the
              // label), we don't repeat it twice.
              const codeText = finding.code || sinkLabel || ""
              const showSinkLine =
                sinkLabel && codeText.trim() !== sinkLabel.trim()
              return (
                <>
                  {showSinkLine && (
                    <p className="text-xs text-muted-foreground">
                      Normalized sink: <code className="font-mono">{sinkLabel}</code>
                    </p>
                  )}
                  <pre className="p-4 rounded-lg bg-[#0d0d0d] border border-border text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
                    <code className="text-green-400">{codeText}</code>
                  </pre>
                </>
              )
            })()}
          </div>

          {/* Suggested Fix — scanner's static text. Only shown when the
              AI explanation block isn't already rendering its own
              "Suggested fix" section (which happens for both AI-success
              and template-fallback payloads). Avoids duplicating the same
              advice twice in the panel. */}
          {!aiExplanation && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-yellow-400" />
                Suggested Fix
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {finding.suggestedFix}
              </p>
            </div>
          )}

          <Separator className="bg-border" />

          {/* Actions — the "Fix this" dropdown replaces the previous
              static Preview Fix / Apply Fix pair, which were placeholders
              that did nothing. The dropdown wires the real fix engine
              with "Provide suggestion" vs "Fix it" options. */}
          <div className="grid grid-cols-2 gap-3 items-stretch">
            <Button variant="outline" className="justify-start">
              <MessageSquare className="h-4 w-4 mr-2" />
              Ask Chat
            </Button>
            <FindingFixButton
              targets={target ? [target] : []}
              projectPath={projectPath}
              label="Fix this"
              dialogTitle={`Fix: ${finding.title}`}
              size="default"
              variant="default"
              className="justify-start w-full"
              onApplied={onFixApplied}
            />
            <Button variant="outline" className="justify-start text-muted-foreground">
              <X className="h-4 w-4 mr-2" />
              Ignore
            </Button>
            <Button variant="outline" className="justify-start">
              <TestTube className="h-4 w-4 mr-2" />
              Create Test
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Pull the normalized sink label out of a standalone-sink title.
 *
 * The scanner generates titles like
 *   "OS command call: os.system (presence warning)"
 *   "Data export call: audio.export (presence warning)"
 * — i.e. `<prefix>: <sink> (<qualifier>)`. We recover `<sink>` so the
 * Code Involved panel can show both the normalized callee AND the full
 * call expression (which now lives in `finding.code`).
 *
 * Returns `null` when the title doesn't match the standalone-sink
 * pattern (e.g. agent-callable tool findings, which use a different
 * title structure entirely). In that case the panel falls back to
 * showing only the code block.
 */
function extractSinkLabel(title: string | undefined | null): string | null {
  if (!title) return null
  const m = /:\s*([A-Za-z_$][\w$.]*)\s*\(/.exec(title)
  if (!m) return null
  return m[1]
}

function ExplanationSection({
  title,
  icon,
  children,
}: {
  title: string
  icon: "info" | "risk" | "ok" | "verify" | "fix"
  children: string
}) {
  const iconEl =
    icon === "risk" ? (
      <AlertTriangle className="h-4 w-4 text-orange-400 shrink-0" />
    ) : icon === "ok" ? (
      <Lightbulb className="h-4 w-4 text-emerald-400 shrink-0" />
    ) : icon === "verify" ? (
      <Eye className="h-4 w-4 text-blue-400 shrink-0" />
    ) : icon === "fix" ? (
      <Lightbulb className="h-4 w-4 text-violet-300 shrink-0" />
    ) : (
      <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
    )

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium flex items-center gap-2">{iconEl}{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{children}</p>
    </div>
  )
}

interface ExplanationBlockProps {
  ai: AIExplanationResponse | null
  loading: boolean
  error: string | null
  template: ReturnType<typeof parseFindingReason>
  hasProjectPath: boolean
}

function ExplanationBlock({ ai, loading, error, template, hasProjectPath }: ExplanationBlockProps) {
  // 1. AI / template-fallback payload arrived → render with source badge.
  if (ai) {
    const tone = explanationSourceTone(ai.source)
    const label = explanationSourceBadge(ai.source)
    const badgeClass =
      tone === "ai"
        ? "bg-violet-500/10 text-violet-300 border-violet-500/25"
        : "bg-amber-500/10 text-amber-300 border-amber-500/25"
    const isFallback = ai.source === "template_fallback" || ai.source === "unavailable"
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={badgeClass}>
            <Sparkles className="h-3 w-3 mr-1" />
            {label}
          </Badge>
          {ai.model_used && tone === "ai" && (
            <span className="text-[11px] text-muted-foreground font-mono">
              {ai.model_used}
            </span>
          )}
        </div>

        {/* Always show the three project-specific sections. On AI success
            these are the ONLY explanation sections; on template fallback
            we additionally render the scanner's deterministic
            why_may_be_okay / what_to_verify / confidence_note below so
            the user still gets the structured reason. */}
        {ai.what_detected && (
          <ExplanationSection title="What was detected" icon="info">
            {ai.what_detected}
          </ExplanationSection>
        )}
        {ai.why_risky && (
          <ExplanationSection title="Why it can be risky" icon="risk">
            {ai.why_risky}
          </ExplanationSection>
        )}
        {ai.suggested_fix && (
          <ExplanationSection title="Suggested fix" icon="fix">
            {ai.suggested_fix}
          </ExplanationSection>
        )}

        {isFallback && ai.why_may_be_okay && (
          <ExplanationSection title="Why this may be okay" icon="ok">
            {ai.why_may_be_okay}
          </ExplanationSection>
        )}
        {isFallback && ai.what_to_verify && ai.what_to_verify.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Eye className="h-4 w-4 text-blue-400 shrink-0" />
              What to verify
            </h3>
            <ul className="text-sm text-muted-foreground leading-relaxed list-disc pl-5 space-y-1">
              {ai.what_to_verify.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {isFallback && ai.confidence_note && (
          <p className="text-xs text-muted-foreground italic leading-snug">
            {ai.confidence_note}
          </p>
        )}
        {/* Dev-only: when the route returned `source: template_fallback`
            because the AI call failed, surface the (key-redacted) reason so
            the developer can fix the underlying cause (wrong model id,
            missing entitlement, etc.). Stripped in production builds. */}
        {ai.source === "template_fallback" && ai.debug_error && (
          <p className="text-[11px] font-mono text-amber-300/80 leading-snug">
            debug: {ai.debug_error}
          </p>
        )}
      </div>
    )
  }

  // 2. AI request failed → degrade to the template with a clear fallback badge.
  if (error) {
    return (
      <div className="space-y-4">
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-300 border-amber-500/25"
        >
          Template fallback
        </Badge>
        <p className="text-xs text-muted-foreground">
          AI explainer unavailable; showing the scanner&apos;s structured explanation.
        </p>
        <DeterministicSections template={template} />
      </div>
    )
  }

  // 3. AI request in flight → loading skeleton. We deliberately do NOT show
  //    the template here so the user clearly waits for the personalized one.
  if (loading && hasProjectPath) {
    return (
      <div className="space-y-3 rounded-lg border border-violet-500/20 bg-violet-500/5 p-4">
        <div className="flex items-center gap-2 text-sm text-violet-200">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Generating project-specific explanation…</span>
        </div>
        <div className="space-y-2">
          <div className="h-3 w-3/4 bg-violet-500/10 rounded animate-pulse" />
          <div className="h-3 w-5/6 bg-violet-500/10 rounded animate-pulse" />
          <div className="h-3 w-2/3 bg-violet-500/10 rounded animate-pulse" />
        </div>
      </div>
    )
  }

  // 4. No project path selected → silently show the deterministic template.
  return <DeterministicSections template={template} />
}

function DeterministicSections({ template }: { template: ReturnType<typeof parseFindingReason> }) {
  if (template.structured) {
    return (
      <>
        {template.whatDetected && (
          <ExplanationSection title="What was detected" icon="info">
            {template.whatDetected}
          </ExplanationSection>
        )}
        {template.whyRisky && (
          <ExplanationSection title="Why it can be risky" icon="risk">
            {template.whyRisky}
          </ExplanationSection>
        )}
        {template.whyMayBeOk && (
          <ExplanationSection title="Why this may be okay" icon="ok">
            {template.whyMayBeOk}
          </ExplanationSection>
        )}
        {template.whatToVerify && (
          <ExplanationSection title="What to verify" icon="verify">
            {template.whatToVerify}
          </ExplanationSection>
        )}
      </>
    )
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-orange-400" />
        Explanation
      </h3>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {template.legacyReason}
      </p>
    </div>
  )
}
