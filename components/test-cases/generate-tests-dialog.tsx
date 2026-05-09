"use client"

/**
 * Generate-tests dialog.
 *
 * The whole point is "no surprise tokens" — generation defaults to a
 * rule-based path that turns real scan findings/agents into tests without
 * any LLM call. Generated tests are listed for review (with inline edits
 * and per-row delete) so the user has to consciously click "Save suite"
 * before anything is persisted.
 *
 * Source choices:
 *   - selected_finding   — focused tests for one finding
 *   - all_high_findings  — coverage for every critical/high finding
 *   - selected_agent     — smoke + tool-routing tests for one agent
 *   - blank              — a minimal smoke test seeded by the user prompt
 */

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group"
import { Sparkles, Trash2, RefreshCw, Save } from "lucide-react"
import type { ScanReport, ScannerFinding } from "@/lib/scan-report"
import {
  defaultSuiteName,
  generateRuleBasedTests,
  newSuiteId,
  saveSuite,
  type GeneratorSource,
  type TestCase,
  type TestSuite,
  TEST_TYPES,
} from "@/lib/test-cases"

type SourceKind = GeneratorSource["kind"]

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  scanReport: ScanReport | null
  /** Active project id — pinned to the saved suite. */
  projectId?: string
  /** Pre-select an agent if the user opened the dialog from an agent context. */
  preselectedAgent?: string | null
  /** Pre-select a finding if the user opened from the findings drawer. */
  preselectedFinding?: ScannerFinding | null
  onSuiteReady?: (suite: TestSuite) => void
}

export function GenerateTestsDialog({
  open,
  onOpenChange,
  scanReport,
  projectId,
  preselectedAgent = null,
  preselectedFinding = null,
  onSuiteReady,
}: Props) {
  const agents = useMemo(
    () => scanReport?.agents_detected ?? [],
    [scanReport]
  )
  const highFindings = useMemo(
    () =>
      (scanReport?.findings ?? []).filter(
        (f) => f.severity === "critical" || f.severity === "high"
      ),
    [scanReport]
  )

  // Source state -------------------------------------------------------
  const [sourceKind, setSourceKind] = useState<SourceKind>("blank")
  const [findingId, setFindingId] = useState<string>("")
  const [agentName, setAgentName] = useState<string>("")
  const [prompt, setPrompt] = useState<string>("")
  const [suiteName, setSuiteName] = useState<string>("")

  // Output state -------------------------------------------------------
  const [generated, setGenerated] = useState<TestCase[]>([])
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Reset on open. We seed defaults from any preselected context so opening
  // from a finding row immediately produces relevant tests.
  useEffect(() => {
    if (!open) return
    setStatusMsg(null)
    setErrorMsg(null)
    setGenerated([])
    setSuiteName("")
    setPrompt("")
    if (preselectedFinding) {
      setSourceKind("selected_finding")
      setFindingId(preselectedFinding.id)
      setAgentName(
        preselectedFinding.agent !== "unknown" ? preselectedFinding.agent : ""
      )
    } else if (preselectedAgent) {
      setSourceKind("selected_agent")
      setAgentName(preselectedAgent)
      setFindingId("")
    } else if (highFindings.length > 0) {
      setSourceKind("all_high_findings")
      setFindingId("")
      setAgentName("")
    } else if (agents.length > 0) {
      setSourceKind("selected_agent")
      setAgentName(agents[0].name)
      setFindingId("")
    } else {
      setSourceKind("blank")
      setFindingId("")
      setAgentName("")
    }
    // We deliberately exclude `agents`/`highFindings` so the dialog doesn't
    // flip selections as scan state churns underneath us; callers re-mount it
    // (via `open`) when they want a clean state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function buildSource(): GeneratorSource | null {
    if (!scanReport) return null
    switch (sourceKind) {
      case "selected_finding": {
        const f =
          scanReport.findings.find((x) => x.id === findingId) ??
          preselectedFinding ??
          null
        if (!f) return null
        return { kind: "selected_finding", finding: f }
      }
      case "all_high_findings":
        return { kind: "all_high_findings" }
      case "selected_agent": {
        const a = agents.find((x) => x.name === agentName) ?? null
        if (!a) return null
        return { kind: "selected_agent", agent: a }
      }
      case "blank":
        return { kind: "blank" }
    }
  }

  function handleGenerate() {
    setErrorMsg(null)
    setStatusMsg(null)
    if (!scanReport) {
      setErrorMsg("Run a scan first — the generator needs real findings/agents.")
      return
    }
    const source = buildSource()
    if (!source) {
      setErrorMsg("Pick a source for generation.")
      return
    }
    const tests = generateRuleBasedTests({
      source,
      scanReport,
      prompt,
      maxTests: 12,
    })
    if (tests.length === 0) {
      setErrorMsg(
        "No tests produced for this source. Try a different source or write a custom prompt."
      )
      return
    }
    setGenerated(tests)
    if (!suiteName.trim()) {
      setSuiteName(defaultSuiteName(source, scanReport))
    }
  }

  function updateTest(idx: number, patch: Partial<TestCase>) {
    setGenerated((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t))
    )
  }

  function removeTest(idx: number) {
    setGenerated((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleSave() {
    if (generated.length === 0) {
      setErrorMsg("No tests to save.")
      return
    }
    const now = new Date().toISOString()
    const suite: TestSuite = {
      id: newSuiteId(),
      version: "1",
      name: suiteName.trim() || "Generated suite",
      createdAt: now,
      updatedAt: now,
      source: "rule_generated",
      projectId,
      tests: generated,
    }
    saveSuite(suite)
    setStatusMsg(
      `Saved "${suite.name}" with ${suite.tests.length} test${suite.tests.length === 1 ? "" : "s"}. Run Selected Checks remains a separate action — generated tests are stored, not executed.`
    )
    onSuiteReady?.(suite)
    setTimeout(() => onOpenChange(false), 600)
  }

  const sourceDescription = describeSource(
    sourceKind,
    scanReport,
    findingId,
    agentName,
    preselectedFinding
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Layout: fixed header + footer, scrollable body. Without this the
       * source picker + review list together overflow on short viewports
       * (~700px) and the Save button gets pushed off-screen, making the
       * dialog look broken. */}
      <DialogContent
        className="sm:max-w-3xl p-0 flex flex-col max-h-[90vh] gap-0"
      >
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>Define checks (AI)</DialogTitle>
          <DialogDescription>
            AI-assisted draft of checks from your latest scan. Runs locally —
            no external LLM call is made yet, so no tokens are spent. Review
            the drafts, tweak them, then save as a reusable suite.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">

        {!scanReport && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">
            Run a scan first. The generator turns real detected agents and
            findings into starter tests.
          </div>
        )}

        {/* ---- Source picker --------------------------------------------- */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">Source</p>
          <RadioGroup
            value={sourceKind}
            onValueChange={(v) => setSourceKind(v as SourceKind)}
            className="grid grid-cols-2 gap-2"
          >
            <SourceOption
              value="selected_finding"
              label="Selected finding"
              hint={
                preselectedFinding
                  ? `Pre-selected: ${truncate(preselectedFinding.title, 60)}`
                  : "Pick one finding from the latest scan"
              }
              disabled={!scanReport || scanReport.findings.length === 0}
            />
            <SourceOption
              value="all_high_findings"
              label="All high findings"
              hint={`${highFindings.length} critical/high finding${highFindings.length === 1 ? "" : "s"}`}
              disabled={highFindings.length === 0}
            />
            <SourceOption
              value="selected_agent"
              label="Selected agent"
              hint={
                agents.length > 0
                  ? `${agents.length} detected agent${agents.length === 1 ? "" : "s"}`
                  : "No agents detected yet"
              }
              disabled={agents.length === 0}
            />
            <SourceOption
              value="blank"
              label="Blank suite"
              hint="Start with a smoke test seeded by your prompt"
            />
          </RadioGroup>

          {sourceKind === "selected_finding" && scanReport && (
            <Select value={findingId} onValueChange={setFindingId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a finding" />
              </SelectTrigger>
              <SelectContent>
                {scanReport.findings.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    [{f.severity}] {truncate(f.title, 70)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {sourceKind === "selected_agent" && agents.length > 0 && (
            <Select value={agentName} onValueChange={setAgentName}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={`${a.name}-${a.file}-${a.line}`} value={a.name}>
                    {a.name} · {a.framework ?? a.kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Optional: describe what the tests should cover (e.g. 'cover refund + cancel guardrails for angry customers'). Threaded into test notes only — no AI call."
            className="min-h-[64px] text-xs"
          />

          {sourceDescription && (
            <p className="text-[11px] text-muted-foreground">
              {sourceDescription}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={!scanReport}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4" />
              Generate
            </Button>
            {generated.length > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={handleGenerate}
                className="gap-2"
                title="Regenerate from the same source"
              >
                <RefreshCw className="h-4 w-4" />
                Regenerate
              </Button>
            )}
          </div>
        </div>

        {/* ---- Review --------------------------------------------------- */}
        {generated.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs font-medium text-muted-foreground">
                Review {generated.length} generated test
                {generated.length === 1 ? "" : "s"}
              </p>
              <Input
                placeholder="Suite name"
                value={suiteName}
                onChange={(e) => setSuiteName(e.target.value)}
                className="max-w-[260px] h-8 text-xs"
              />
            </div>
            <div className="rounded-md border bg-muted/10 p-2">
              <ul className="space-y-2">
                {generated.map((t, idx) => (
                  <li
                    key={t.id}
                    className="rounded-md border bg-background p-2 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Select
                        value={t.type}
                        onValueChange={(v) =>
                          updateTest(idx, { type: v as TestCase["type"] })
                        }
                      >
                        <SelectTrigger className="h-7 text-[11px] w-[170px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TEST_TYPES.map((tt) => (
                            <SelectItem key={tt} value={tt}>
                              {tt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {t.severity_if_fail && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1 py-0"
                        >
                          fail = {t.severity_if_fail}
                        </Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground font-mono truncate flex-1">
                        {t.id}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => removeTest(idx)}
                        title="Remove this test"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <Textarea
                      value={t.input}
                      onChange={(e) => updateTest(idx, { input: e.target.value })}
                      className="text-xs min-h-[44px]"
                    />
                    {t.notes && (
                      <p className="text-[10px] text-muted-foreground italic">
                        {t.notes}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {errorMsg && (
          <p className="text-xs text-destructive border border-destructive/30 rounded-md p-2">
            {errorMsg}
          </p>
        )}
        {statusMsg && (
          <p className="text-xs text-emerald-500">{statusMsg}</p>
        )}

        </div>

        <DialogFooter className="gap-2 px-6 py-4 border-t shrink-0 bg-background">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={generated.length === 0}
            className="gap-2"
          >
            <Save className="h-4 w-4" />
            Save suite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SourceOption({
  value,
  label,
  hint,
  disabled,
}: {
  value: SourceKind
  label: string
  hint: string
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:bg-muted/40 transition-colors ${
        disabled ? "opacity-40 cursor-not-allowed" : ""
      }`}
    >
      <RadioGroupItem value={value} disabled={disabled} className="mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground truncate">{hint}</p>
      </div>
    </label>
  )
}

function describeSource(
  kind: SourceKind,
  report: ScanReport | null,
  findingId: string,
  agentName: string,
  preselectedFinding: ScannerFinding | null
): string | null {
  if (!report) return null
  switch (kind) {
    case "selected_finding": {
      const f =
        report.findings.find((x) => x.id === findingId) ?? preselectedFinding
      if (!f) return "Pick a finding above to generate tests for it."
      return `Will produce one focused test based on rule "${f.rule_id}".`
    }
    case "all_high_findings":
      return "Walks every critical/high finding and produces a starter test for each (capped at 12)."
    case "selected_agent": {
      const a = report.agents_detected?.find((x) => x.name === agentName)
      if (!a) return "Pick an agent above."
      return `Smoke + tool-routing tests for ${a.name}.`
    }
    case "blank":
      return "Single smoke test using your prompt as the input — useful as a starting point."
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
