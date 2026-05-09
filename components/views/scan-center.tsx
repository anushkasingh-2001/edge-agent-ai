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
import type { ScanReport } from "@/lib/scan-report"
import type { Project } from "@/lib/projects"
import {
  formatScanTime,
  type ScanHistoryItem,
} from "@/lib/scan-history"
import { deriveRulesFromSuite, type TestSuite } from "@/lib/test-cases"

const securityChecks = [
  { id: "dangerous-tools", label: "Dangerous tools", description: "Identify risky tool invocations" },
  { id: "human-approval", label: "Missing human approval", description: "Flag actions requiring human review" },
  { id: "prompt-injection", label: "Prompt injection", description: "Detect injection vulnerabilities" },
  { id: "vague-prompts", label: "Vague prompts", description: "Find prompts that lack specificity" },
  { id: "mcp-security", label: "MCP security", description: "Audit Model Context Protocol security" },
  { id: "openapi-schema", label: "OpenAPI/schema quality", description: "Validate API schemas and specs" },
  { id: "auth-checks", label: "Auth checks", description: "Verify authentication is properly enforced" },
  { id: "secrets", label: "Hardcoded secrets", description: "Find exposed credentials and keys" },
  { id: "dependency-risks", label: "Dependency risks", description: "Check for vulnerable dependencies" },
  { id: "user-input-dangerous-code", label: "User input to dangerous code", description: "Trace unsafe data flows" },
  { id: "accuracy", label: "Accuracy regression", description: "Detect changes that may affect output quality" },
  { id: "performance", label: "Performance/runtime", description: "Monitor latency and resource usage" },
  { id: "tool-selection", label: "Tool selection correctness", description: "Verify correct tool routing" },
  { id: "smoke-tests", label: "Live smoke tests", description: "Run live validation tests" },
]

interface ScanCenterProps {
  selectedAgents?: string[]
  onRunScan: (selectedCheckIds: string[]) => Promise<void>
  isScanning?: boolean
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
  /** Scoped to the selected project, newest-first. */
  scanHistory?: ScanHistoryItem[]
  /** Load a historical scan back into the current UI state. */
  onLoadScan?: (item: ScanHistoryItem) => void
}

export function ScanCenter({
  selectedAgents = ["all"],
  onRunScan,
  isScanning = false,
  scanError = null,
  lastIssueCount = null,
  lastScanTime = null,
  hasProject = false,
  projectLabel,
  scanReport = null,
  project = null,
  branch = null,
  scanHistory = [],
  onLoadScan,
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
  const [lastSuiteToast, setLastSuiteToast] = useState<string | null>(null)
  // The user-defined suite chosen for the next scan. Lights up the green
  // confirmation pill in the "All checks" row so it's obvious that picking a
  // suite from the dropdown actually had an effect.
  const [activeSuite, setActiveSuite] = useState<TestSuite | null>(null)

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
  const startScan = async (mode: "full" | "selected") => {
    let ids: string[]
    if (activeSuite && suiteRules.length > 0) {
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
    setScanProgress(10)
    try {
      await onRunScan(ids)
      setScanProgress(100)
      if (activeSuite) {
        setLastSuiteToast(
          `Scoped scan to ${ids.length} rule${ids.length === 1 ? "" : "s"} implied by suite "${activeSuite.name}" (${activeSuite.tests.length} test${activeSuite.tests.length === 1 ? "" : "s"}). Runtime execution of the suite's user-defined tests is not wired yet — the suite is recorded with this run.`
        )
        setTimeout(() => setLastSuiteToast(null), 8000)
      }
    } finally {
      setTimeout(() => setScanProgress(0), 400)
    }
  }

  const stopScan = () => {
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
                    className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs px-2 py-1 max-w-[260px]"
                    title={`Active user-defined suite: ${activeSuite.name} (${activeSuite.tests.length} test${activeSuite.tests.length === 1 ? "" : "s"})`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{activeSuite.name}</span>
                    <span className="text-emerald-500/70 shrink-0">
                      · {activeSuite.tests.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveSuite(null)}
                      className="ml-0.5 text-emerald-500/70 hover:text-emerald-300 shrink-0"
                      title="Clear selected user-defined checks"
                      aria-label="Clear selected user-defined checks"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                {/* User-defined checks live next to the built-in checks so the
                 * "I want to add my own" workflow is co-located with the
                 * "select built-in scanner rules" workflow. The three options
                 * cover: re-using something I already saved, generating new
                 * checks from the latest scan, and authoring checks by hand
                 * via our open script format. */}
                {/* Three explicit ways to bring user-defined checks into the
                 * scan: write them by hand (no AI), have us draft them from
                 * the latest scan (AI-assisted), or re-use something we
                 * already saved. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1">
                      <TestTube className="h-3.5 w-3.5" />
                      User-defined checks
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel className="text-xs">
                      User-defined checks
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => openImport("paste")}
                      className="gap-2"
                    >
                      <FileCode className="h-4 w-4" />
                      <div className="flex flex-col">
                        <span>Define checks (no AI)</span>
                        <span className="text-[10px] text-muted-foreground">
                          Author or paste a structured suite — no tokens spent
                        </span>
                      </div>
                    </DropdownMenuItem>
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
                        <span>Define checks (AI)</span>
                        <span className="text-[10px] text-muted-foreground">
                          AI-assisted draft from the latest scan
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
                          Pick from your last saved checks
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
                      activeSuite && suiteRules.length > 0
                        ? `Run only the ${suiteRules.length} rule${suiteRules.length === 1 ? "" : "s"} implied by "${activeSuite.name}": ${suiteRules.join(", ")}`
                        : "Run every available scanner rule"
                    }
                  >
                    <Play className="h-4 w-4 mr-2" />
                    {activeSuite && suiteRules.length > 0
                      ? "Run Suite Scan"
                      : "Run Full Scan"}
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
                fullWidth
              />
              <p className="text-xs text-muted-foreground text-center">
                {activeSuite && suiteRules.length > 0
                  ? `Suite "${activeSuite.name}" narrows the scan to ${suiteRules.length} rule${suiteRules.length === 1 ? "" : "s"}`
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
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                          <span className="text-sm font-medium truncate">
                            {idx === 0 ? "Latest scan" : `Scan ${scanHistory.length - idx}`}
                          </span>
                        </div>
                        {scan.findingCount > 0 ? (
                          <Badge
                            variant="outline"
                            className="text-xs border-orange-500/50 text-orange-400 shrink-0"
                          >
                            {scan.findingCount} issues
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="text-xs border-green-500/50 text-green-400 shrink-0"
                          >
                            Clean
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {formatScanTime(scan.timestamp)}
                          {scan.branch ? ` · ${scan.branch}` : ""}
                          {` · risk ${scan.riskScore}/100`}
                        </span>
                      </div>
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
    </div>
  )
}
