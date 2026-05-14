"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Play,
  Square,
  Sparkles,
  Clock,
  CheckCircle2,
  Loader2,
  TestTube,
  ChevronDown,
  FileCode,
  FolderOpen,
  X,
  Pencil,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ExportReportButton } from "@/components/export-report-button"
import { ImportTestsDialog } from "@/components/test-cases/import-tests-dialog"
import { GenerateTestsDialog } from "@/components/test-cases/generate-tests-dialog"
import { DefineUserInputsDialog } from "@/components/test-cases/define-user-inputs-dialog"
import type { ScanReport } from "@/lib/scan-report"
import type { Project } from "@/lib/projects"
import type { PolicyApiResponse } from "@/lib/policy-client"
import {
  formatScanTime,
  type ScanHistoryItem,
} from "@/lib/scan-history"
import {
  deriveRulesFromSuite,
  extractRelatedFindingIdsFromSuite,
  extractRuleFileTuplesFromSuite,
  extractRuleIdsFromSuite,
  extractTargetFilesFromSuite,
  type TestSuite,
} from "@/lib/test-cases"
import { SECURITY_CHECKS } from "@/lib/security-checks"

const securityChecks = SECURITY_CHECKS

interface ScanCenterProps {
  selectedAgents?: string[]
  /** Triggers a scan. `narrow` lets the parent post-filter the resulting
   * report so the UI only shows findings the active user-defined suite was
   * generated from. Prefer `findingIds` when available (most precise — one
   * test ⇒ one finding); fall back to `files` for older suites that don't
   * carry finding ids. Without this the suite was decorative.
   *
   * Stash contents are NEVER a separate scan mode — the scan API folds
   * `stash@{0}` into every regular scan automatically, so a "Run Full
   * Scan" already covers committed code + working tree + stashed WIP. */
  onRunScan: (
    selectedCheckIds: string[],
    narrow?: {
      findingIds?: string[]
      files?: string[]
      ruleIds?: string[]
      ruleFileTuples?: Array<{ ruleId: string; file: string }>
      /** Hint to the parent: when true the user expressed intent to
       *  run only their custom + suite tests in the Behavioral panel.
       *  The parent flips the per-project `userOnly` flag so the
       *  Behavioral panel's next run skips the built-in pool. The
       *  static scan itself is unaffected — this is purely a
       *  Behavioral-tab signal. */
      hintUserOnlyBehavioral?: boolean
    }
  ) => Promise<{ beforeCount: number; afterCount: number; narrowed: boolean }>
  isScanning?: boolean
  /** Cancels the in-flight scan request via an AbortController owned
   * by the parent. The Scan Center can't abort fetches it didn't
   * issue, so the parent exposes this. No-op when nothing is running. */
  onStopScan?: () => void
  scanError?: string | null
  lastIssueCount?: number | null
  lastScanTime?: string | null
  hasProject?: boolean
  projectLabel?: string
  /** Latest scan report — drives the Export Report button. */
  scanReport?: ScanReport | null
  /** Selected project — used in the export filename / markdown header. */
  project?: Project | null
  /** Selected branch — included in the markdown header. */
  branch?: string | null
  /** Latest policy evaluation. When present the Export Report dropdown
   *  grows two extra "Export policy report" options. */
  policyResponse?: PolicyApiResponse | null
  /** Scoped to the selected project, newest-first. */
  scanHistory?: ScanHistoryItem[]
  /** Load a historical scan back into the current UI state. */
  onLoadScan?: (item: ScanHistoryItem) => void
  /** Lifted state: the user-defined suite that's queued for the next scan.
   * Lives in the parent so other views (Overview) can read it and stay in
   * sync. */
  activeSuite?: TestSuite | null
  onActiveSuiteChange?: (suite: TestSuite | null) => void
  /** Wired by the parent to switch to Findings → Behavioral Tests.
   *  The "Run user-defined + AI tests" button selects all 14 checks,
   *  triggers a full scan, and then calls this so the Behavioral
   *  panel (which merges AI-generated probes + user-authored ones)
   *  is what the user sees as soon as the scan finishes. */
  onShowUserDefinedAndAiTests?: () => void
}

export function ScanCenter({
  selectedAgents = ["all"],
  onRunScan,
  isScanning = false,
  onStopScan,
  scanError = null,
  lastIssueCount = null,
  lastScanTime = null,
  hasProject = false,
  projectLabel,
  scanReport = null,
  project = null,
  branch = null,
  policyResponse = null,
  scanHistory = [],
  onLoadScan,
  activeSuite: activeSuiteProp,
  onActiveSuiteChange,
  onShowUserDefinedAndAiTests,
}: ScanCenterProps) {
  const [selectedChecks, setSelectedChecks] = useState<string[]>(securityChecks.map((c) => c.id))
  const [allSelected, setAllSelected] = useState(true)
  const [scanProgress, setScanProgress] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  // Controls which tab the Import dialog opens on. The "User-defined checks"
  // menu has two entry points into the same dialog: "Use saved checks" lands
  // on the Saved tab; "Define checks (script format)" lands on the Paste tab.
  const [importDefaultTab, setImportDefaultTab] = useState<
    "saved" | "file" | "paste"
  >("saved")
  const [generateOpen, setGenerateOpen] = useState(false)
  /** Primary builder — replaces the old "User-defined checks" dropdown
   *  with a single repo-aware multi-row authoring flow. The dropdown
   *  options (AI / Saved) are still reachable as compact secondary
   *  buttons next to this one. */
  const [defineInputsOpen, setDefineInputsOpen] = useState(false)
  // When non-null, the `DefineUserInputsDialog` opens in *edit* mode
  // against this suite (Save changes / Save as new / Delete suite).
  // When null AND `defineInputsOpen` is true, the dialog is in
  // *create* mode (the existing "Define user-defined inputs"
  // button entry). Reset to null whenever the dialog closes so the
  // next Create click doesn't accidentally edit the previous suite.
  const [editingSuite, setEditingSuite] = useState<TestSuite | null>(null)
  const [lastSuiteToast, setLastSuiteToast] = useState<string | null>(null)
  // The user-defined suite chosen for the next scan. Lifted to the parent
  // so the Overview "User-Defined Tests" tile shows whatever is currently
  // queued instead of summing across every saved suite. Internal local
  // fallback exists so this component is still usable without the props.
  const [activeSuiteLocal, setActiveSuiteLocal] = useState<TestSuite | null>(null)
  const activeSuite =
    activeSuiteProp !== undefined ? activeSuiteProp : activeSuiteLocal
  const setActiveSuite = (s: TestSuite | null) => {
    if (onActiveSuiteChange) onActiveSuiteChange(s)
    else setActiveSuiteLocal(s)
  }

  const openImport = (tab: "saved" | "file" | "paste") => {
    setImportDefaultTab(tab)
    setImportOpen(true)
  }

  const handleSuiteReady = (suite: TestSuite) => {
    setActiveSuite(suite)
    setLastSuiteToast(
      `"${suite.name}" is now the active user-defined check suite (${suite.tests.length} test${suite.tests.length === 1 ? "" : "s"}). They are stored locally — execution remains opt-in via Run Selected Checks.`
    )
    // Auto-clear so the toast doesn't linger forever.
    setTimeout(() => setLastSuiteToast(null), 6000)
  }

  const handleAllChange = (checked: boolean) => {
    setAllSelected(checked)
    if (checked) {
      setSelectedChecks(securityChecks.map((c) => c.id))
    } else {
      setSelectedChecks([])
    }
  }

  const handleCheckChange = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedChecks([...selectedChecks, id])
    } else {
      setSelectedChecks(selectedChecks.filter((c) => c !== id))
      setAllSelected(false)
    }
  }

  // Rules implied by the active suite — drives both the button label and the
  // actual filter we send to the scanner. Memoized so we don't recompute it
  // on every render of the row.
  const suiteRules = useMemo(
    () => deriveRulesFromSuite(activeSuite),
    [activeSuite]
  )
  // What the suite actually narrows to. Prefer the suite-level `scope`
  // captured at generation time (works for blank suites + agent suites
  // where individual tests don't carry locators); fall back to extracting
  // from each test's locator/notes for older suites that pre-date scope.
  //
  // We also surface two precise dimensions specific to *manually*
  // authored suites:
  //   • `suiteRuleFileTuples`: (rule_id, file) pairs derived from each
  //      test's `expected.rule_id_hint` + `expected.agents_file_hints`.
  //      Lets us reduce a "1 test ⇒ 1 row" suite to exactly the
  //      findings it cares about instead of "every finding in those
  //      files".
  //   • `suiteRuleIds`: rule_id-only narrowing for tests that picked a
  //      category but no agent/file.
  const {
    suiteFiles,
    suiteFindingIds,
    suiteRuleFileTuples,
    suiteRuleIds,
  } = useMemo(() => {
    if (!activeSuite) {
      return {
        suiteFiles: [],
        suiteFindingIds: [],
        suiteRuleFileTuples: [],
        suiteRuleIds: [],
      }
    }
    const tuples = extractRuleFileTuplesFromSuite(activeSuite)
    const ruleIds = extractRuleIdsFromSuite(activeSuite)
    const scope = activeSuite.scope
    if (scope && (scope.files?.length || scope.findingIds?.length)) {
      return {
        suiteFiles: scope.files ?? [],
        suiteFindingIds: scope.findingIds ?? [],
        suiteRuleFileTuples: tuples,
        suiteRuleIds: ruleIds,
      }
    }
    return {
      suiteFiles: extractTargetFilesFromSuite(activeSuite),
      suiteFindingIds: extractRelatedFindingIdsFromSuite(activeSuite),
      suiteRuleFileTuples: tuples,
      suiteRuleIds: ruleIds,
    }
  }, [activeSuite])

  /**
   * Three scan flavors. Which one runs depends on whether a user-defined
   * suite is active:
   *
   *  - No suite + "full":      send `[]` → scanner runs every rule.
   *  - No suite + "selected":  send the ticked rule IDs.
   *  - Suite active + "full":  send the rule IDs implied by the suite, so
   *                            the report is narrowed to what the suite
   *                            actually tests for. (This was the user's
   *                            complaint — picking a suite then clicking
   *                            "Run Full Scan" used to still produce 65
   *                            unrelated findings.)
   *  - Suite active + "selected":  intersection of ticked rules and suite
   *                                rules. Lets users tighten further.
   */
  const startScan = async (
    mode: "full" | "selected",
    /** When `true`, ignore the active suite entirely: run every rule
     *  and emit no narrowing dimensions. Used by the "Run user-defined
     *  + AI tests" button — that flow wants AI probes + custom probes
     *  to share a *real* full scan as their data source, otherwise the
     *  built-in probes get pointed at zero findings and skip. */
    opts?: { ignoreSuite?: boolean }
  ) => {
    const ignoreSuite = opts?.ignoreSuite === true
    let ids: string[]
    if (!ignoreSuite && activeSuite && suiteRules.length > 0) {
      if (mode === "selected" && selectedChecks.length > 0) {
        ids = suiteRules.filter((r) => selectedChecks.includes(r))
        if (ids.length === 0) {
          // No overlap → nothing to run. Bail with a clear message instead
          // of silently turning into a full scan.
          setLastSuiteToast(
            `None of the ticked checks are covered by suite "${activeSuite.name}". Tick a relevant rule (e.g. ${suiteRules.slice(0, 2).join(", ")}) or run Full Scan.`
          )
          setTimeout(() => setLastSuiteToast(null), 6000)
          return
        }
      } else {
        ids = suiteRules
      }
    } else {
      ids = mode === "full" ? [] : selectedChecks
    }
    // Pass every narrowing dimension we have up to the parent. The
    // parent picks the tightest one that actually matches anything in
    // the fresh report:
    //   findingIds → ruleFileTuples → (files ∧ ruleIds) → files →
    //   ruleIds → no narrow.
    // Including all four lets a single manual test ("Prompt injection
    // on RefundAgent") survive as exactly one finding instead of
    // dragging every prompt-injection finding back in.
    // "Only my tests" hint for the Behavioral panel. Triggered when
    // the user has a suite active and has unchecked every built-in
    // category — the intent we read is "run only what I defined,
    // not the 11 baseline probes". We attach it to the narrow object
    // (purely a Behavioral-tab signal; the static scan ignores it).
    // `ignoreSuite` (Run user-defined + AI tests) suppresses both
    // the hint and the narrow so the scan is a *true* full scan and
    // the Behavioral panel runs the merged AI + user pool.
    const hintUserOnlyBehavioral =
      !ignoreSuite && activeSuite != null && selectedChecks.length === 0
    const narrow = ignoreSuite
      ? undefined
      : activeSuite &&
          (suiteFindingIds.length > 0 ||
            suiteRuleFileTuples.length > 0 ||
            suiteRuleIds.length > 0 ||
            suiteFiles.length > 0)
        ? {
            findingIds: suiteFindingIds,
            files: suiteFiles,
            ruleIds: suiteRuleIds,
            ruleFileTuples: suiteRuleFileTuples,
            hintUserOnlyBehavioral,
          }
        : hintUserOnlyBehavioral
          ? { hintUserOnlyBehavioral }
          : undefined
    setScanProgress(10)
    try {
      const result = await onRunScan(ids, narrow)
      setScanProgress(100)
      // When `ignoreSuite` is on (Run user-defined + AI tests) we
      // skipped narrowing entirely, so the suite-aware toast would
      // lie about what happened. Fall through to the generic "scan
      // completed" UI path instead.
      if (activeSuite && !ignoreSuite) {
        const { beforeCount, afterCount, narrowed } = result
        // Short, accurate phrase describing what the narrower used.
        // Picks the same precedence the parent's `narrowReport()`
        // does so the toast doesn't lie about which filter ran.
        const dimensionPhrase =
          suiteFindingIds.length > 0
            ? `${suiteFindingIds.length} finding id${suiteFindingIds.length === 1 ? "" : "s"}`
            : suiteRuleFileTuples.length > 0
              ? `${suiteRuleFileTuples.length} (rule, file) pair${suiteRuleFileTuples.length === 1 ? "" : "s"}`
              : suiteRuleIds.length > 0
                ? `${suiteRuleIds.length} rule${suiteRuleIds.length === 1 ? "" : "s"}`
                : `${suiteFiles.length} file${suiteFiles.length === 1 ? "" : "s"}`
        if (!narrowed) {
          setLastSuiteToast(
            `Scan completed (${afterCount} findings). Suite "${activeSuite.name}" has no narrowable scope — regenerate via Define checks → AI from a finding/agent to enable narrowing.`
          )
        } else if (afterCount === 0) {
          // Empty result is correct for a tight manual suite that
          // doesn't intersect any of this scan's findings — say so
          // explicitly instead of leaving the user staring at an
          // empty list.
          setLastSuiteToast(
            `Suite narrowing: ${beforeCount} → 0 findings. None of the scan's findings matched the suite's ${dimensionPhrase}. The static scanner found nothing in that scope — your behavioral tests still run in Findings → Behavioral Tests.`
          )
        } else if (beforeCount === afterCount) {
          setLastSuiteToast(
            `Scan completed but suite narrowing did not reduce the count (${afterCount} findings). Every finding matched the suite's ${dimensionPhrase} — try a more specific test (single rule × single agent) for a tighter scope.`
          )
        } else {
          setLastSuiteToast(
            `Suite narrowing: ${beforeCount} → ${afterCount} findings (-${beforeCount - afterCount}). Scan ran ${ids.length === 0 ? "all backend rules" : `${ids.length} rule${ids.length === 1 ? "" : "s"}`}, then kept findings matching the suite's ${dimensionPhrase}.`
          )
        }
        setTimeout(() => setLastSuiteToast(null), 12000)
      }
    } finally {
      setTimeout(() => setScanProgress(0), 400)
    }
  }

  const stopScan = () => {
    // Tell the parent to abort the in-flight request. The parent will
    // flip `isScanning` back to false on the AbortError, which causes
    // this card to swap the Stop button back for "Run Selected" /
    // "Run Full Scan". We also reset the local progress meter so the
    // user gets immediate visual feedback without waiting for the
    // round-trip.
    onStopScan?.()
    setScanProgress(0)
  }

  const agentLabel = selectedAgents.includes("all")
    ? "All Agents"
    : selectedAgents.length === 1
      ? selectedAgents[0]
      : `${selectedAgents.length} agents`

  if (!hasProject) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Scan Center</h1>
          <p className="text-muted-foreground">Choose a project first.</p>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a local project or clone from GitHub before running a scan.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scan Center</h1>
          <p className="text-muted-foreground">
            Configure and run security scans on {agentLabel}
            {projectLabel ? ` (${projectLabel})` : ""}
          </p>
        </div>
      </div>

      {lastSuiteToast && (
        <p className="text-xs text-emerald-500 border border-emerald-500/30 rounded-md p-2 bg-emerald-500/5">
          {lastSuiteToast}
        </p>
      )}

      {scanError ? (
        <p className="text-sm text-destructive border border-destructive/30 rounded-md p-3 bg-destructive/10">
          {scanError}
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Security Checks</CardTitle>
              <CardDescription>Select which checks to include in the scan</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
                <Checkbox id="all" checked={allSelected} onCheckedChange={(v) => handleAllChange(!!v)} />
                <div className="flex-1">
                  <label htmlFor="all" className="text-sm font-medium cursor-pointer">
                    All checks
                  </label>
                  <p className="text-xs text-muted-foreground">Run all available security and quality checks</p>
                </div>
                <Badge variant="outline" className="text-xs">
                  {selectedChecks.length}/{securityChecks.length}
                </Badge>
                {activeSuite && (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs px-2 py-1 max-w-[280px]"
                    title={`Active user-defined suite: ${activeSuite.name} (${activeSuite.tests.length} test${activeSuite.tests.length === 1 ? "" : "s"})`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{activeSuite.name}</span>
                    <span className="text-emerald-500/70 shrink-0">
                      · {activeSuite.tests.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        // Open the suite editor against the active
                        // suite. The dialog is the same one as the
                        // "Define user-defined inputs" button, just
                        // pre-loaded with these rows for edit mode.
                        setEditingSuite(activeSuite)
                        setDefineInputsOpen(true)
                      }}
                      className="ml-0.5 text-emerald-500/70 hover:text-emerald-200 shrink-0"
                      title="Edit this suite — add / remove tests, save as new, or delete"
                      aria-label="Edit user-defined suite"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveSuite(null)}
                      className="ml-0.5 text-emerald-500/70 hover:text-emerald-300 shrink-0"
                      title="Clear selected user-defined checks (does not delete the suite — find it under More → Use saved checks)"
                      aria-label="Clear selected user-defined checks"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                {/* User-defined inputs live next to the built-in
                 * checks so the "I want to add my own" workflow is
                 * co-located with the "pick built-in scanner rules"
                 * workflow. The primary button opens a repo-aware
                 * builder; AI/Saved entry points stay as compact
                 * secondary buttons so power users keep one-click
                 * access to them. */}
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    // Force *create* mode — otherwise the previous
                    // edit target would still be set and the dialog
                    // would open with last-edited rows.
                    setEditingSuite(null)
                    setDefineInputsOpen(true)
                  }}
                  title="Author tests row-by-row: pick category, agents, scenario, inputs, expected outputs, and accuracy"
                >
                  <TestTube className="h-3.5 w-3.5" />
                  Define user-defined inputs
                </Button>
                {/* Compact secondary entries — same dialogs as before,
                 * just smaller so they don't compete with the primary
                 * builder. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      title="More: AI draft from the latest scan, paste a script, or pick a saved suite"
                    >
                      More
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel className="text-xs">
                      Other ways to add user-defined checks
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setGenerateOpen(true)}
                      disabled={!scanReport}
                      className="gap-2"
                      title={
                        scanReport
                          ? "AI-assisted draft of checks from the latest scan"
                          : "Run a scan first — needs real findings/agents"
                      }
                    >
                      <Sparkles className="h-4 w-4" />
                      <div className="flex flex-col">
                        <span>Draft with AI from latest scan</span>
                        <span className="text-[10px] text-muted-foreground">
                          AI-assisted from real findings
                        </span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => openImport("paste")}
                      className="gap-2"
                    >
                      <FileCode className="h-4 w-4" />
                      <div className="flex flex-col">
                        <span>Paste structured suite (no AI)</span>
                        <span className="text-[10px] text-muted-foreground">
                          Author or paste in our open JSON format
                        </span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => openImport("saved")}
                      className="gap-2"
                    >
                      <FolderOpen className="h-4 w-4" />
                      <div className="flex flex-col">
                        <span>Use saved checks</span>
                        <span className="text-[10px] text-muted-foreground">
                          Pick from your last saved suites
                        </span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {securityChecks.map((check) => (
                  <div
                    key={check.id}
                    className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/30 transition-colors"
                  >
                    <Checkbox
                      id={check.id}
                      checked={selectedChecks.includes(check.id)}
                      onCheckedChange={(checked) => handleCheckChange(check.id, checked as boolean)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <label htmlFor={check.id} className="text-sm font-medium cursor-pointer">
                        {check.label}
                      </label>
                      <p className="text-xs text-muted-foreground truncate">{check.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {isScanning && (
            <Card className="bg-card border-border border-accent/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    Scanning repository…
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">{scanProgress > 0 ? scanProgress : "…"}%</span>
                </div>
              </CardHeader>
              <CardContent>
                <Progress value={scanProgress || 66} className="h-2 animate-pulse" />
                <p className="text-sm text-muted-foreground mt-2">
                  Running Python scanner on the project root ({selectedChecks.length} UI checks selected).
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="bg-card border-border">
            <CardContent className="pt-6 space-y-3">
              {!isScanning ? (
                <>
                  {/* When a suite is active the primary button narrows to
                   * the rules the suite covers, so the label switches to
                   * "Run Suite Scan" to set the right expectation. */}
                  <Button
                    className="w-full"
                    onClick={() => void startScan("full")}
                    title={
                      activeSuite
                        ? suiteFindingIds.length > 0
                          ? `Run a scan and narrow to the ${suiteFindingIds.length} finding${suiteFindingIds.length === 1 ? "" : "s"} this suite was generated from`
                          : suiteRuleFileTuples.length > 0
                            ? `Run a scan and narrow to the ${suiteRuleFileTuples.length} (rule, file) pair${suiteRuleFileTuples.length === 1 ? "" : "s"} this suite targets`
                            : suiteRuleIds.length > 0
                              ? `Run a scan and narrow to the ${suiteRuleIds.length} rule${suiteRuleIds.length === 1 ? "" : "s"} this suite targets`
                              : suiteFiles.length > 0
                                ? `Run a scan and narrow to the ${suiteFiles.length} file${suiteFiles.length === 1 ? "" : "s"} this suite targets`
                                : `Run a scan; suite has no narrowable targets — regenerate via Define checks → AI`
                        : "Run every available scanner rule"
                    }
                  >
                    <Play className="h-4 w-4 mr-2" />
                    {activeSuite ? "Run Suite Scan" : "Run Full Scan"}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void startScan("selected")}
                    disabled={selectedChecks.length === 0}
                    title={
                      selectedChecks.length === 0
                        ? "Tick at least one check above to run a filtered scan"
                        : activeSuite && suiteRules.length > 0
                          ? `Run the intersection of ticked checks and suite rules`
                          : `Run ${selectedChecks.length} selected check${selectedChecks.length === 1 ? "" : "s"}`
                    }
                  >
                    <TestTube className="h-4 w-4 mr-2" />
                    Run Selected Checks
                  </Button>
                  {/* Run user-defined + AI tests
                   * ─────────────────────────────
                   * Ticks every check (the merged "all 14" set the
                   * user asked for), runs a full scan so the
                   * Behavioral runner has fresh findings to point
                   * its probes at, and routes the user to Findings
                   * → Behavioral Tests where AI-generated probes
                   * AND user-authored ones are merged into one
                   * view. */}
                  <Button
                    variant="secondary"
                    className="w-full bg-accent/15 hover:bg-accent/25 border border-accent/40 text-accent-foreground"
                    onClick={async () => {
                      // 1) Make sure every check is ticked so the
                      //    scan covers all 14 categories.
                      setSelectedChecks(securityChecks.map((c) => c.id))
                      setAllSelected(true)
                      // 2) Kick off a *true* full scan — explicitly
                      //    bypass suite narrowing here. Without
                      //    `ignoreSuite: true`, an active suite would
                      //    still trim the scan down to the suite's
                      //    rules and the built-in probes (which point
                      //    at scanner findings) would all skip with
                      //    "No scanner finding in this category".
                      await startScan("full", { ignoreSuite: true })
                      // 3) Switch over to the Behavioral subtab. We
                      //    do this *after* the scan resolves so the
                      //    Behavioral runner has the new report
                      //    available the moment the tab mounts.
                      onShowUserDefinedAndAiTests?.()
                    }}
                    disabled={!onShowUserDefinedAndAiTests}
                    title="Tick all 14 checks, run a full scan, and open Findings → Behavioral Tests (AI-generated probes + your custom tests merged)"
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Run user-defined + AI tests
                  </Button>
                </>
              ) : (
                <Button className="w-full" variant="destructive" onClick={stopScan}>
                  <Square className="h-4 w-4 mr-2" />
                  Stop
                </Button>
              )}
              <ExportReportButton
                report={scanReport}
                project={project}
                branch={branch}
                policy={policyResponse}
                fullWidth
              />
              <p className="text-xs text-muted-foreground text-center">
                {activeSuite
                  ? suiteFindingIds.length > 0
                    ? `Suite "${activeSuite.name}" narrows to ${suiteFindingIds.length} finding${suiteFindingIds.length === 1 ? "" : "s"}`
                    : suiteRuleFileTuples.length > 0
                      ? `Suite "${activeSuite.name}" narrows to ${suiteRuleFileTuples.length} (rule, file) pair${suiteRuleFileTuples.length === 1 ? "" : "s"}`
                      : suiteRuleIds.length > 0
                        ? `Suite "${activeSuite.name}" narrows to ${suiteRuleIds.length} rule${suiteRuleIds.length === 1 ? "" : "s"}`
                        : suiteFiles.length > 0
                          ? `Suite "${activeSuite.name}" narrows to ${suiteFiles.length} file${suiteFiles.length === 1 ? "" : "s"}`
                          : `Suite "${activeSuite.name}" attached — no narrowable targets`
                  : `${selectedChecks.length} check${selectedChecks.length === 1 ? "" : "s"} selected`}
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between">
                <span>Recent Scans</span>
                {scanHistory.length > 0 && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {scanHistory.length} stored
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {scanHistory.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    No scans yet for this project.
                  </p>
                ) : (
                  // Show the 5 most recent for this project. The full history
                  // (capped at 20 by lib/scan-history) is still accessible by
                  // re-opening the project.
                  scanHistory.slice(0, 5).map((scan, idx) => (
                    <button
                      key={scan.id}
                      type="button"
                      onClick={() => onLoadScan?.(scan)}
                      disabled={!onLoadScan}
                      className="w-full text-left p-3 rounded-lg bg-secondary/30 space-y-2 border border-accent/20 hover:bg-secondary/50 hover:border-accent/40 transition-colors disabled:cursor-default disabled:hover:bg-secondary/30 disabled:hover:border-accent/20"
                      title={
                        onLoadScan
                          ? "Load this scan into the current view"
                          : undefined
                      }
                    >
                      {(() => {
                        // Pull the stash-only flag once so the title,
                        // status badge, and tooltips all stay in sync.
                        // A stash-only scan inspects ONLY the files
                        // inside the stash entry — the rest of the
                        // branch is NOT scanned. That's a critical
                        // distinction: a "Clean" stash scan does NOT
                        // mean the branch is clean, and the issue
                        // count isn't comparable with branch scans.
                        const isStashOnly =
                          scan.report?.working_tree?.stash_scan === true
                        const stashFileCount =
                          scan.report?.working_tree?.stash_file_count ?? 0
                        const titleText = isStashOnly
                          ? idx === 0
                            ? "Latest stash scan"
                            : "Stash scan"
                          : idx === 0
                            ? "Latest scan"
                            : `Scan ${scanHistory.length - idx}`
                        return (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <CheckCircle2
                                className={`h-4 w-4 shrink-0 ${
                                  isStashOnly
                                    ? "text-blue-300"
                                    : "text-green-400"
                                }`}
                              />
                              <span
                                className="text-sm font-medium truncate"
                                title={
                                  isStashOnly
                                    ? `Stash-only scan: only the ${stashFileCount} file${
                                        stashFileCount === 1 ? "" : "s"
                                      } inside the stash were inspected. The rest of the branch was NOT scanned — use Run Full Scan for branch-wide results.`
                                    : undefined
                                }
                              >
                                {titleText}
                              </span>
                            </div>
                            {scan.findingCount > 0 ? (
                              <Badge
                                variant="outline"
                                className={`text-xs shrink-0 ${
                                  isStashOnly
                                    ? "border-orange-500/50 text-orange-400"
                                    : "border-orange-500/50 text-orange-400"
                                }`}
                                title={
                                  isStashOnly
                                    ? `${scan.findingCount} issue${
                                        scan.findingCount === 1 ? "" : "s"
                                      } found inside the stash only — branch contents were NOT scanned.`
                                    : undefined
                                }
                              >
                                {isStashOnly
                                  ? `Stash: ${scan.findingCount} issue${
                                      scan.findingCount === 1 ? "" : "s"
                                    }`
                                  : `${scan.findingCount} issues`}
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className={`text-xs shrink-0 ${
                                  isStashOnly
                                    ? "border-blue-500/50 text-blue-300"
                                    : "border-green-500/50 text-green-400"
                                }`}
                                title={
                                  isStashOnly
                                    ? `Only the ${stashFileCount} file${
                                        stashFileCount === 1 ? "" : "s"
                                      } inside the stash were checked and they had no findings. The rest of the branch was NOT scanned — this does NOT mean the branch is clean.`
                                    : undefined
                                }
                              >
                                {isStashOnly
                                  ? `Stash clean (${stashFileCount} file${
                                      stashFileCount === 1 ? "" : "s"
                                    })`
                                  : "Clean"}
                              </Badge>
                            )}
                          </div>
                        )
                      })()}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {formatScanTime(scan.timestamp)}
                          {/* Stash scans don't belong to a branch
                              conceptually — show the stash ref
                              instead so the user can tell at a
                              glance "this row was a stash run". */}
                          {scan.report?.working_tree?.stash_scan
                            ? ` · ${
                                scan.report.working_tree.stash_ref ?? "stash"
                              }`
                            : scan.branch
                              ? ` · ${scan.branch}`
                              : ""}
                          {/* When this scan was run via temp git
                              worktree (user picked a non-checked-out
                              branch in the dropdown) the report
                              carries the resolved SHA. Surfacing it
                              clarifies that the result is the
                              branch's pristine HEAD, not the working
                              tree on disk. */}
                          {scan.report?.working_tree?.virtual_checkout &&
                          scan.report.working_tree.virtual_checkout_sha
                            ? `@${scan.report.working_tree.virtual_checkout_sha.slice(
                                0,
                                7
                              )}`
                            : ""}
                          {` · risk ${scan.riskScore}/100`}
                          {/* Proof-of-coverage. Older scan history
                              entries (pre-field) just won't show
                              this segment. Critical UX context
                              because the scanner is regex-based:
                              "0 issues" can mean two very different
                              things and this number disambiguates. */}
                          {typeof scan.report?.files_scanned === "number" && (
                            <span
                              title={
                                scan.report.files_scanned_by_ext
                                  ? `Files actually inspected by the rules. The scanner only walks text files (${Object.keys(
                                      scan.report.files_scanned_by_ext
                                    ).join(", ")}); binaries, oversized files, and ignored dirs are skipped. A file that IS inspected can still produce 0 findings if no rule pattern matches.`
                                  : "Files actually inspected by the rules."
                              }
                            >
                              {` · ${scan.report.files_scanned} file${
                                scan.report.files_scanned === 1 ? "" : "s"
                              } scanned`}
                            </span>
                          )}
                        </span>
                      </div>
                      {/* Stash-scan badge. Lets the user distinguish a
                          stash row from a branch row at a glance and
                          surfaces the stash subject ("WIP on main:
                          a1d57d6 fix bug") so they remember what was
                          in it. Total file count comes from the
                          unbounded counter (`stash_files` may be
                          truncated to ~50 for payload size). */}
                      {scan.report?.working_tree?.stash_scan && (
                        <>
                          <div className="flex items-center gap-1 flex-wrap text-[10px]">
                            <Badge
                              variant="outline"
                              className="border-blue-500/50 text-blue-300 px-1.5 py-0 h-4 font-mono"
                              title={
                                scan.report.working_tree.stash_message
                                  ? `Stash scan: ${scan.report.working_tree.stash_message}`
                                  : "Stash-only scan: only files inside the stash were analysed."
                              }
                            >
                              stash ·{" "}
                              {scan.report.working_tree.stash_file_count ?? 0}{" "}
                              file
                              {(scan.report.working_tree.stash_file_count ??
                                0) === 1
                                ? ""
                                : "s"}
                            </Badge>
                          </div>
                          {/* Inline disclaimer so the user can't read a
                              "Clean" stash row as a clean BRANCH. The
                              row is intentionally chatty — past UX
                              feedback was that the small badge alone
                              got missed and people assumed the whole
                              branch had been scanned. */}
                          <p className="text-[10px] text-blue-300/80 leading-snug">
                            Stash-only — only the files in this stash were
                            scanned. The rest of '{scan.branch ?? "this branch"}'
                            was <strong>not</strong> inspected. Click{" "}
                            <em>Run Full Scan</em> for branch-wide results.
                          </p>
                        </>
                      )}
                      {/* Scope strip — always rendered for branch and
                          virtual-checkout scans so the user can see
                          AT A GLANCE what was inspected:
                            [all of <branch>]  +N untracked  +M modified  + stash · K files
                          The leading green anchor is critical UX:
                          without it, "+5 untracked" looks like the
                          ENTIRE scope of the scan instead of an
                          addition on top of the full branch HEAD.
                          That misread was the source of the user's
                          "why is it only scanning untracked?"
                          confusion. Stash-only history rows are
                          handled separately above (they render
                          their own "Stash-only" disclaimer). */}
                      {scan.report?.working_tree &&
                        scan.report.working_tree.stash_scan !== true &&
                        (() => {
                          const wt = scan.report.working_tree
                          const blanketOpt =
                            wt.untracked_excluded_from_scan === true
                          const crossBranchN =
                            wt.untracked_attributed_other_branch_count ?? 0
                          const crossBranchName =
                            wt.untracked_attributed_other_branches?.[0]
                              ?.branch ?? null
                          const branchLabel =
                            wt.virtual_checkout && wt.virtual_checkout_sha
                              ? `${wt.branch ?? scan.branch ?? "branch"}@${wt.virtual_checkout_sha.slice(
                                  0,
                                  7
                                )}`
                              : (wt.branch ?? scan.branch ?? "branch HEAD")
                          const totalAddedFiles =
                            (!blanketOpt ? (wt.untracked ?? 0) : 0) +
                            (wt.modified ?? 0) +
                            (wt.stash_included
                              ? (wt.stash_file_count ?? 0)
                              : 0)
                          return (
                            <div className="flex items-center gap-1 flex-wrap text-[10px]">
                              <Badge
                                variant="outline"
                                className="border-emerald-500/50 text-emerald-300 px-1.5 py-0 h-4 font-mono"
                                title={
                                  totalAddedFiles > 0
                                    ? `Scope: every file on '${branchLabel}' was scanned, plus ${totalAddedFiles} extra (uncommitted + stashed). The badges to the right are ADDITIONS on top, not the entire scope.`
                                    : `Scope: every file on '${branchLabel}' was scanned. Working tree was clean and no stash was attached.`
                                }
                              >
                                all of {branchLabel}
                              </Badge>
                              {!blanketOpt && (wt.untracked ?? 0) > 0 && (
                                <Badge
                                  variant="outline"
                                  className="border-yellow-500/50 text-yellow-400 px-1.5 py-0 h-4 font-mono"
                                  title={
                                    crossBranchN > 0 && crossBranchName
                                      ? `Untracked files in the working tree at scan time, scanned IN ADDITION to '${branchLabel}'. ${crossBranchN} of them originated on '${crossBranchName}' (still included).`
                                      : `Untracked files in the working tree at scan time, scanned IN ADDITION to '${branchLabel}'.`
                                  }
                                >
                                  +{wt.untracked} untracked
                                  {crossBranchN > 0 && crossBranchName
                                    ? ` (${crossBranchN} from ${crossBranchName})`
                                    : ""}
                                </Badge>
                              )}
                              {blanketOpt && (wt.untracked ?? 0) > 0 && (
                                <Badge
                                  variant="outline"
                                  className="border-muted-foreground/50 text-muted-foreground px-1.5 py-0 h-4 font-mono"
                                  title="Untracked files were skipped from this scan (pre-commit gate, includeUntracked: false). They do not appear in the issue counts."
                                >
                                  +{wt.untracked} untracked (skipped)
                                </Badge>
                              )}
                              {(wt.modified ?? 0) > 0 && (
                                <Badge
                                  variant="outline"
                                  className="border-yellow-500/50 text-yellow-400 px-1.5 py-0 h-4 font-mono"
                                  title={`Tracked files with uncommitted edits at scan time, scanned IN ADDITION to '${branchLabel}'.`}
                                >
                                  +{wt.modified} modified
                                </Badge>
                              )}
                              {wt.stash_included && (() => {
                                // Multi-stash aware label. When more
                                // than one stash on this branch was
                                // folded in, we say "+ 3 stashes · 12
                                // unique files" and surface the list
                                // of refs in the tooltip. For a
                                // single stash we keep the original
                                // "+ stash · K files" wording so old
                                // muscle memory still works.
                                const stashCount =
                                  wt.stashes_included_count ??
                                  (wt.stashes_included?.length ?? 1)
                                const fileCount = wt.stash_file_count ?? 0
                                const fileWord =
                                  fileCount === 1 ? "file" : "files"
                                const refs = wt.stashes_included
                                  ? wt.stashes_included
                                      .map(
                                        (s) =>
                                          `${s.ref}: ${s.message} (${s.file_count} file${s.file_count === 1 ? "" : "s"})`
                                      )
                                      .join("\n")
                                  : wt.stash_message
                                    ? `${wt.stash_ref ?? "stash@{0}"}: ${wt.stash_message}`
                                    : (wt.stash_ref ?? "stash@{0}")
                                const tooltipBody =
                                  stashCount > 1
                                    ? `${stashCount} stashes on this branch folded into the scan (latest wins on per-file conflicts → ${fileCount} unique ${fileWord} scanned). Newest first:\n${refs}`
                                    : `${refs}\n\n${fileCount} ${fileWord} folded into this scan automatically — there's no separate "scan stash" step.`
                                return (
                                  <Badge
                                    variant="outline"
                                    className="border-blue-500/50 text-blue-300 px-1.5 py-0 h-4 font-mono"
                                    title={tooltipBody}
                                  >
                                    {stashCount > 1
                                      ? `+ ${stashCount} stashes · ${fileCount} unique ${fileWord}`
                                      : `+ stash · ${fileCount} ${fileWord}`}
                                  </Badge>
                                )
                              })()}
                            </div>
                          )
                        })()}
                    </button>
                  ))
                )}
                {scanHistory.length > 5 && (
                  <p className="text-[11px] text-muted-foreground text-center pt-1">
                    Showing 5 of {scanHistory.length} stored scans for this
                    project (older scans are kept until you reach the 20-scan
                    cap).
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <ImportTestsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={project?.id}
        defaultTab={importDefaultTab}
        onSuiteReady={handleSuiteReady}
      />
      <GenerateTestsDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        scanReport={scanReport}
        projectId={project?.id}
        onSuiteReady={handleSuiteReady}
      />
      <DefineUserInputsDialog
        open={defineInputsOpen}
        onOpenChange={(open) => {
          setDefineInputsOpen(open)
          // Reset the edit target on close so the next "Define
          // user-defined inputs" click starts from a blank row
          // instead of editing whatever was open last time.
          if (!open) setEditingSuite(null)
        }}
        scanReport={scanReport ?? null}
        projectId={project?.id}
        projectPath={project?.path ?? null}
        initialSuite={editingSuite}
        onSuiteReady={handleSuiteReady}
        onSuiteDeleted={() => {
          // User deleted the suite from inside the editor — drop the
          // active reference so Scan Center stops narrowing to it
          // and the chip disappears.
          setActiveSuite(null)
          setEditingSuite(null)
        }}
      />
    </div>
  )
}
