"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { 
  Search, 
  Shield,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Loader2,
  PlayCircle,
  Filter,
  RefreshCw,
  CircleCheck,
  CircleX,
  CircleDashed,
  FileCode,
  MessageSquare,
  Plus,
  Trash2,
  RotateCcw,
} from "lucide-react"
import { FindingDrawer } from "@/components/finding-drawer"
import { FindingFixButton } from "@/components/finding-fix-button"
import {
  IntelligenceModeToggle,
  type IntelligenceMode,
} from "@/components/intelligence-mode-toggle"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { DefineUserInputsDialog } from "@/components/test-cases/define-user-inputs-dialog"
import type { ScanReport, UiFinding } from "@/lib/scan-report"
import type { TestSuite } from "@/lib/test-cases"
import { SECURITY_CHECKS, displayCategoryLabel } from "@/lib/security-checks"
import {
  accuracyTone,
  formatAccuracyPct,
  runBehavioralTestsApi,
  severityTone,
  statusTone,
  type BehavioralRunReport,
  type BehavioralStatus,
  type BehavioralTestCase,
  type UserBehavioralProbeWire,
} from "@/lib/behavioral-tests-client"
import type { FixTarget, RunFixesResult } from "@/lib/finding-fixes-client"
import {
  disableBuiltinProbe,
  enableBuiltinProbe,
  loadProbeStore,
  removeUserProbe,
  setUserOnly,
  type ProjectProbeStore,
} from "@/lib/user-probes"

export type Finding = UiFinding

/**
 * Wrapper kept around because several call sites already use it. The
 * actual mapping logic moved to `lib/security-checks.ts` so Scan Center
 * and Findings now share one source of truth for the category vocabulary.
 */
function displayCategory(raw: string): string {
  return displayCategoryLabel(raw)
}

interface FindingsProps {
  findings: Finding[]
  riskScore: number
  hasProject?: boolean
  hasScan?: boolean
  /** Required for the behavioral runner so the API can find the project
   *  on disk. When absent the Behavioral tab degrades gracefully to a
   *  "needs a project + scan" empty state. */
  projectPath?: string | null
  scanReport?: ScanReport | null
  /** Which inner tab to land on. Lets external callers (e.g. the
   *  Scan Center "Run user-defined + AI tests" button) deep-link
   *  into the Behavioral Tests subtab. Defaults to "code". */
  initialTab?: "code" | "behavioral"
  /** Id of the user's currently active Scan Center suite. Used as a
   *  reload trigger for the Behavioral Tests probe store — when the
   *  parent bridges new suite-derived probes into localStorage, we
   *  need to re-read the store so this panel reflects them without
   *  a full project switch. `null` is fine and means "no suite". */
  activeSuiteId?: string | null
  /** Monotonic counter the parent bumps when it mutates the
   *  per-project probe store directly (e.g. forcing `userOnly` off
   *  via the Scan Center "Run user-defined + AI tests" gesture).
   *  The Behavioral panel uses this as an extra dep so it re-reads
   *  localStorage even when project/suite ids are unchanged. */
  probeStoreVersion?: number
  /** Full active suite (when set). The Behavioral panel's
   *  Edit suite dialog opens against this object so the user can
   *  add / remove / replace tests inline from the Findings view. */
  activeSuite?: TestSuite | null
  /** Selected project id — passed through to the suite editor so
   *  newly-saved suites stay pinned to this project. */
  projectId?: string | null
  /** Notified when the user saves edits or deletes the active suite
   *  via the Edit suite dialog — lets the parent update its
   *  `activeSuite` state so the Scan Center chip / narrowing stays
   *  consistent across views. */
  onActiveSuiteChange?: (suite: TestSuite | null) => void
  /** Re-trigger the scan from the workspace view's "Re-run scan"
   *  button. Optional — when omitted the button is hidden. Same
   *  callback the TopBar's Run Scan button calls. */
  onRerunScan?: () => void
}

/**
 * Findings tab.
 *
 * Two surfaces under the same risk-score header:
 *
 *   - **Code Analysis** — static scanner output (the existing flow).
 *     Same 14-category dropdown vocabulary as Scan Center.
 *   - **Behavioral Tests** — on-demand runner that points adversarial
 *     probes (with rotating, freshly-drawn inputs each run) at the
 *     real source files behind each scanner finding and checks for the
 *     defenses each probe expects. No LLM, no network, no mocks.
 *
 * The behavioral runner is intentionally honest: it doesn't pretend to
 * "ask the agent" — it inspects the agent's code for the defense the
 * probe expects. That makes results actionable (a fail points at a
 * specific file:line and the missing guard) while keeping execution
 * cheap enough to run on every scan refresh.
 */
export function Findings({
  findings,
  riskScore,
  hasProject = false,
  hasScan = false,
  projectPath = null,
  scanReport = null,
  initialTab = "code",
  activeSuiteId = null,
  probeStoreVersion = 0,
  activeSuite = null,
  projectId = null,
  onActiveSuiteChange,
  onRerunScan,
}: FindingsProps) {
  const [tab, setTab] = useState<"code" | "behavioral">(initialTab)

  // Allow external callers to deep-link into a subtab between renders
  // (e.g. the user clicks "Run user-defined + AI tests" while
  // already on the Findings view — the parent flips `initialTab` to
  // "behavioral" but the component is already mounted). Without this
  // the prop only takes effect on first mount.
  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  const criticalCount = findings.filter((f) => f.severity === "critical").length
  const highCount = findings.filter((f) => f.severity === "high").length
  const mediumCount = findings.filter((f) => f.severity === "medium").length
  const lowCount = findings.filter((f) => f.severity === "low").length

  const riskColor =
    riskScore >= 86
      ? "text-red-400"
      : riskScore >= 61
        ? "text-orange-400"
        : riskScore >= 31
          ? "text-yellow-400"
          : "text-green-400"

  if (!hasProject || !hasScan) {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Findings</h1>
            <p className="text-muted-foreground">
              Security issues detected in your AI agents
            </p>
        </div>
      </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {hasProject
              ? "No scan results yet. Run a scan from the Scan Center."
              : "No project opened. Open a local project or clone from GitHub before running a scan."}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Findings</h1>
        <p className="text-muted-foreground">
          Security issues detected in your AI agents — both static code
          patterns and adversarial behavior probes against the real code.
        </p>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Risk Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${riskColor}`}>{riskScore}</div>
          </CardContent>
        </Card>
        
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Critical</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="text-3xl font-bold">{criticalCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>High</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-orange-500" />
              <span className="text-3xl font-bold">{highCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Medium</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <span className="text-3xl font-bold">{mediumCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Low</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <span className="text-3xl font-bold">{lowCount}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "code" | "behavioral")}
      >
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="code" className="gap-2">
            <FileCode className="h-3.5 w-3.5" />
            Code Analysis
            <Badge
              variant="outline"
              className="ml-1 h-5 px-1.5 text-[10px] font-normal"
            >
              {findings.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="behavioral" className="gap-2">
            <Sparkles className="h-3.5 w-3.5" />
            Behavioral Tests
          </TabsTrigger>
        </TabsList>

        <TabsContent value="code" className="mt-6 space-y-6">
          <CodeAnalysisPanel
            findings={findings}
            projectPath={projectPath}
            onRerunScan={onRerunScan}
          />
        </TabsContent>

        <TabsContent value="behavioral" className="mt-6 space-y-6">
          <BehavioralTestsPanel
            projectPath={projectPath}
            scanReport={scanReport}
            activeSuiteId={activeSuiteId}
            probeStoreVersion={probeStoreVersion}
            activeSuite={activeSuite}
            projectId={projectId}
            onActiveSuiteChange={onActiveSuiteChange}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ===================================================================
// Code Analysis tab — same logic as before, extracted into a sub-comp
// so the Behavioral panel doesn't need to share state with it.
// ===================================================================

function CodeAnalysisPanel({
  findings,
  projectPath,
  onRerunScan,
}: {
  findings: Finding[]
  projectPath: string | null
  /** When set, the workspace view's "Re-run scan" button fires this
   *  (same callback wired to the global TopBar Run Scan button). */
  onRerunScan?: () => void
}) {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [severityFilter, setSeverityFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  // Five-tier intelligence mode (Save / Auto / Pro / Max / Manual).
  // The selected mode is forwarded to /api/finding/patch,
  // /api/findings/fix-filtered and /api/scan/estimate as
  // `intelligenceMode`. We default to Auto (smart routing) — the
  // recommended mode in the design brief — and persist nothing here:
  // it stays a per-session preference until the user changes it.
  const [intelligenceMode, setIntelligenceMode] =
    useState<IntelligenceMode>("auto")
  // When set, the in-app workspace (file tree + Monaco editor) takes
  // over the panel. The findings table is hidden until the user clicks
  // "Back to findings" inside the workspace view.
  const [workspaceFinding, setWorkspaceFinding] = useState<Finding | null>(null)

  /**
   * Session-local set of finding ref_ids that the fix engine successfully
   * applied. After Apply-all the user expects the "Fix all (61)" badge to
   * shrink — but the `findings` prop is owned by the parent and only
   * refreshes on the next scan. Tracking applied refs here lets us hide
   * the fixed rows immediately. The set is cleared when the parent passes
   * a brand-new findings array (re-scan), so we don't permanently hide
   * findings that re-appear.
   */
  const [appliedRefIds, setAppliedRefIds] = useState<Set<string>>(new Set())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setAppliedRefIds(new Set()), [findings])

  const handleApplied = useCallback((r: RunFixesResult) => {
    setAppliedRefIds((prev) => {
      const next = new Set(prev)
      for (const p of r.proposals) {
        // Hide BOTH freshly-applied AND idempotently-skipped rows. The
        // engine treats both as "handled" — a fix marker is in place
        // above the offending line either way. Without this, a Fix-all
        // re-run on a project that had been fixed in a previous
        // session would loop forever: every row would come back as
        // no-op-because-already-marked, and the user would see no
        // movement in the "Fix all (N)" badge.
        //
        // Errors are NOT hidden — those still need manual attention.
        if (p.applied || (p.risk === "no-op" && !p.error)) {
          next.add(p.ref_id)
        }
      }
      return next
    })
  }, [])

  const findingsAfterFixes = useMemo(
    () =>
      appliedRefIds.size === 0
        ? findings
        : findings.filter(
            (f) => !appliedRefIds.has(f.scannerFindingId ?? String(f.id))
          ),
    [findings, appliedRefIds]
  )

  const findingCountByLabel = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of findingsAfterFixes) {
      const label = displayCategory(f.category)
      m.set(label, (m.get(label) ?? 0) + 1)
    }
    return m
  }, [findingsAfterFixes])

  const knownLabels = SECURITY_CHECKS.map((c) => c.label)
  const knownLabelSet = useMemo(() => new Set(knownLabels), [knownLabels])
  const orphanLabels = useMemo(
    () =>
      [
        ...new Set(
          findingsAfterFixes
            .map((f) => displayCategory(f.category))
            .filter((label) => !knownLabelSet.has(label))
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [findingsAfterFixes, knownLabelSet]
  )
  const categories: string[] = [...knownLabels, ...orphanLabels]

  const filteredFindings = findingsAfterFixes.filter((f) => {
    const matchesSearch =
      f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.file.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity =
      severityFilter === "all" || f.severity === severityFilter
    const matchesCategory =
      categoryFilter === "all" ||
      displayCategory(f.category) === categoryFilter
    return matchesSearch && matchesSeverity && matchesCategory
  })

  // "Fix all" targets the CURRENTLY VISIBLE rows so a filtered view fixes
  // exactly what the user sees. Findings without a ruleId can't be fixed
  // by the engine (no template to apply) so we drop them up front rather
  // than letting the user trigger a no-op.
  const fixableTargets: FixTarget[] = useMemo(
    () =>
      filteredFindings
        .filter((f) => Boolean(f.ruleId))
        .map((f) => ({
          ref_id: f.scannerFindingId ?? String(f.id),
          rule_id: f.ruleId as string,
          file: f.file,
          line: f.line,
          title: f.title,
        })),
    [filteredFindings]
  )
  const fixAllLabel =
    filteredFindings.length === findingsAfterFixes.length
      ? `Fix all (${fixableTargets.length})`
      : `Fix filtered (${fixableTargets.length})`

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

  // VS Code-style workspace takes over the panel when a finding is
  // opened in the editor. Rendering it here (rather than as a global
  // route) means the existing project + scan state is implicitly in
  // scope, and "Back to findings" simply unsets `workspaceFinding`
  // without any router round-trip.
  if (workspaceFinding && projectPath) {
    return (
      <div className="-mx-6 -mb-6 h-[calc(100vh-12rem)] min-h-[600px] border-t border-border">
        <WorkspaceView
          projectPath={projectPath}
          finding={workspaceFinding}
          onClose={() => setWorkspaceFinding(null)}
          onRerunScan={onRerunScan}
        />
      </div>
    )
  }

  return (
    <>
      <Card className="bg-card border-border">
        <CardContent className="pt-4 space-y-3">
          {/* Five-tier intelligence mode selector. Sits on its own row
              above the filter bar so the radiogroup is visible whatever
              the toolbar's wrap state is. The chosen mode is forwarded
              to the patch + bulk-fix routes; Save means
              "deterministic-only" (no LLM patches), Max means
              "plan→patch→validate" PR-gate quality. */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Analysis mode</span>
              <span className="opacity-70">
                Scanner findings are deterministic in every mode.
              </span>
            </div>
            <IntelligenceModeToggle
              value={intelligenceMode}
              onChange={setIntelligenceMode}
            />
          </div>
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search findings..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-secondary/50"
              />
            </div>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="w-40 bg-secondary/50">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severities</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-64 bg-secondary/50">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent className="max-h-[420px]">
                <SelectItem value="all">
                  All Categories ({findings.length})
                </SelectItem>
                {categories.map((cat) => {
                  const count = findingCountByLabel.get(cat) ?? 0
                  return (
                    <SelectItem key={cat} value={cat}>
                      <span
                        className={
                          count === 0
                            ? "text-muted-foreground/70"
                            : undefined
                        }
                      >
                        {cat}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({count})
                        </span>
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <div className="text-sm text-muted-foreground">
              {filteredFindings.length} findings
            </div>
            <FindingFixButton
              targets={fixableTargets}
              projectPath={projectPath}
              label={fixAllLabel}
              dialogTitle={fixAllLabel}
              size="sm"
              variant="default"
              onApplied={handleApplied}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        {/* table-fixed + per-cell `truncate` keeps every column visible
            inside the card width. Without it the Title column would
            stretch to fit long accuracy-regression titles and push
            File/Line/Agent off the right edge, so users (esp. on the
            Low filter) thought those columns were missing. */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="w-[88px]">Severity</TableHead>
              <TableHead className="w-[180px]">Category</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-[200px]">File</TableHead>
              <TableHead className="w-[64px] text-right">Line</TableHead>
              <TableHead className="w-[120px]">Agent</TableHead>
              <TableHead className="w-[36px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredFindings.map((finding) => {
              // Some analyzers (accuracy-regression, secrets-on-file)
              // are file-level only and have no owning agent — show an
              // em dash instead of "unknown"/empty so the row layout is
              // identical across severities.
              const agentLabel =
                !finding.agent || finding.agent.trim() === "" || finding.agent === "unknown"
                  ? "—"
                  : finding.agent
              const fileLabel = finding.file?.trim() ? finding.file : "—"
              const lineLabel =
                typeof finding.line === "number" && finding.line > 0 ? String(finding.line) : "—"
              return (
              <TableRow
                key={finding.scannerFindingId ?? finding.id}
                className="cursor-pointer hover:bg-secondary/50 border-border"
                onClick={() => {
                  // VS Code-style workspace is the primary detail
                  // surface now: click a row → drop straight into the
                  // file tree + editor with the finding's file pinned.
                  // Falls back to the legacy drawer when projectPath
                  // is unknown (rare; only when the project lookup
                  // hasn't resolved yet).
                  if (projectPath) {
                    setWorkspaceFinding(finding)
                  } else {
                    setSelectedFinding(finding)
                    setDrawerOpen(true)
                  }
                }}
              >
                <TableCell>
                  <Badge
                    variant="outline"
                    className={severityBadgeClass(finding.severity)}
                  >
                    {finding.severity}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground truncate" title={displayCategory(finding.category)}>
                  {displayCategory(finding.category)}
                </TableCell>
                <TableCell className="font-medium truncate" title={finding.title}>
                  {finding.title}
                </TableCell>
                <TableCell
                  className="font-mono text-xs text-muted-foreground truncate"
                  title={fileLabel}
                >
                  {fileLabel}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground text-right">
                  {lineLabel}
                </TableCell>
                <TableCell className="text-muted-foreground truncate" title={agentLabel}>
                  {agentLabel}
                </TableCell>
                <TableCell>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </TableCell>
              </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      <FindingDrawer
        finding={selectedFinding}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        projectPath={projectPath}
        onFixApplied={handleApplied}
        onOpenInEditor={(f) => {
          setDrawerOpen(false)
          setWorkspaceFinding(f)
        }}
      />
    </>
  )
}

// ===================================================================
// Behavioral Tests tab
// ===================================================================

interface BehavioralTestsPanelProps {
  projectPath: string | null
  scanReport: ScanReport | null
  /** Id of the active Scan Center suite, threaded through Findings. The
   *  parent (`app/page.tsx`) bridges suite-derived probes into the
   *  probe store whenever this changes — we use it purely as a reload
   *  signal so the panel mirrors those writes without remounting. */
  activeSuiteId: string | null
  /** Force-reload signal from the parent. Bumped whenever
   *  `app/page.tsx` writes to the probe store directly (e.g. flipping
   *  `userOnly` from the Scan Center "Run user-defined + AI tests"
   *  button). Without this dep the panel keeps a stale in-memory
   *  snapshot because neither `projectPath` nor `activeSuiteId`
   *  changes during that flow. */
  probeStoreVersion: number
  /** Full active suite (or null). Drives the "Edit suite" dialog so
   *  the user can add / remove / re-shape rows from inside the
   *  Behavioral Tests panel. */
  activeSuite: TestSuite | null
  /** Project id pinned onto suites saved from this dialog. */
  projectId: string | null
  /** Forwarded up to `app/page.tsx` so the new/edited suite becomes
   *  the active one (and the suite-bridge useEffect there re-fires). */
  onActiveSuiteChange?: (suite: TestSuite | null) => void
}

function BehavioralTestsPanel({
  projectPath,
  scanReport,
  activeSuiteId,
  probeStoreVersion,
  activeSuite,
  projectId,
  onActiveSuiteChange,
}: BehavioralTestsPanelProps) {
  const [report, setReport] = useState<BehavioralRunReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"all" | BehavioralStatus>(
    "all"
  )
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  // Controls the suite editor dialog. Opens against `activeSuite`
  // (edit flow) when one exists, or starts blank (create flow)
  // when there is none. Replaces the previous one-probe-at-a-time
  // Define-Custom-Test dialog so the Behavioral panel and Scan
  // Center share a single authoring surface.
  const [editSuiteOpen, setEditSuiteOpen] = useState(false)
  const [probeStore, setProbeStore] = useState<ProjectProbeStore>({
    disabledProbeIds: [],
    userProbes: [],
    userOnly: false,
  })
  const abortRef = useRef<AbortController | null>(null)

  // Pull the persisted store whenever the project changes OR the
  // active suite changes OR the parent bumps the version counter.
  // The version counter catches direct writes from `app/page.tsx`
  // (e.g. forcing `userOnly` off when the user clicks "Run
  // user-defined + AI tests") where neither project nor suite id
  // would otherwise move.
  useEffect(() => {
    setProbeStore(loadProbeStore(projectPath))
  }, [projectPath, activeSuiteId, probeStoreVersion])

  // Auto-rerun when "Only my tests" flips externally (e.g. Scan
  // Center's "Run Suite Scan" with no built-ins ticked flipped this
  // flag from app/page.tsx). Without this the toggle becomes ON but
  // the cached report still shows the built-in pool until the user
  // hits "Re-run with new inputs" by hand. The toggle-from-this-panel
  // path goes through `handleToggleUserOnly` which already re-runs,
  // so this effect only matters for "value changed under us".
  const prevUserOnlyRef = useRef<boolean | null>(null)
  useEffect(() => {
    const prev = prevUserOnlyRef.current
    prevUserOnlyRef.current = probeStore.userOnly
    if (prev === null) return // first observation — don't trigger
    if (prev === probeStore.userOnly) return
    if (!projectPath) return
    void runOnce({ overrideStore: probeStore })
    // runOnce is intentionally NOT in deps — we only want this to
    // fire when the flag flips, not when the callback identity
    // changes due to scanReport updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeStore.userOnly, projectPath])

  const canRun = Boolean(projectPath)

  const runOnce = useCallback(
    async (opts?: {
      fixedSeed?: number
      overrideStore?: ProjectProbeStore
    }) => {
      if (!projectPath) return
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setRunning(true)
      setError(null)
      // When the caller passes a freshly-updated store (e.g. right
      // after a Remove click) we use it directly — otherwise we'd
      // race the React state update and re-run with the old set.
      const storeForRun = opts?.overrideStore ?? probeStore
      const probesForRun: UserBehavioralProbeWire[] = (
        opts?.overrideStore
          ? opts.overrideStore.userProbes
          : probeStore.userProbes
      ).map((p) => ({
        id: p.id,
        rule_id: p.rule_id,
        category: p.category,
        severity: p.severity,
        name: p.name,
        scenario: p.scenario,
        inputs: p.inputs,
        expected_defense: p.expected_defense,
        defense_patterns: p.defense_patterns,
        target_file: p.target_file,
        agents: p.agents,
        accuracy_target: p.accuracy_target,
        failure_observed: p.failure_observed,
      }))
      try {
        const r = await runBehavioralTestsApi({
          projectPath,
          scanReport,
          seed: opts?.fixedSeed,
          disabledProbeIds: storeForRun.disabledProbeIds,
          userProbes: probesForRun,
          disableBuiltIns: storeForRun.userOnly,
          signal: ac.signal,
        })
        setReport(r)
      } catch (e) {
        if ((e as Error).name === "AbortError") return
        setError(
          e instanceof Error ? e.message : "Behavioral test run failed."
        )
      } finally {
        setRunning(false)
      }
    },
    [projectPath, scanReport, probeStore]
  )

  // ── Remove / Add handlers (lifted so rows can fire them) ────────
  const handleRemoveTest = useCallback(
    (test: BehavioralTestCase) => {
      if (!projectPath) return
      const isUserProbe = test.probe_id.startsWith("user.")
      const nextStore = isUserProbe
        ? removeUserProbe(projectPath, test.probe_id)
        : disableBuiltinProbe(projectPath, test.probe_id)
      setProbeStore(nextStore)
      // Optimistic UI: hide every row sharing this probe_id without
      // waiting for the network round-trip. The re-run will replace
      // the report shortly.
      setReport((prev) =>
        prev
          ? {
              ...prev,
              tests: prev.tests.filter((t) => t.probe_id !== test.probe_id),
            }
          : prev
      )
      void runOnce({ overrideStore: nextStore })
    },
    [projectPath, runOnce]
  )

  const handleRestoreBuiltins = useCallback(() => {
    if (!projectPath) return
    let next = probeStore
    for (const id of probeStore.disabledProbeIds) {
      next = enableBuiltinProbe(projectPath, id)
    }
    setProbeStore(next)
    void runOnce({ overrideStore: next })
  }, [projectPath, probeStore, runOnce])

  /** Toggle the "Only my tests" mode and immediately re-run so the
   *  Behavioral panel reflects the new pool. Persists in the project
   *  probe store so the choice survives reload. */
  const handleToggleUserOnly = useCallback(
    (value: boolean) => {
      if (!projectPath) return
      const next = setUserOnly(projectPath, value)
      setProbeStore(next)
      void runOnce({ overrideStore: next })
    },
    [projectPath, runOnce]
  )

  /** Fires after the user saves edits (or "Save as new") in the
   *  suite editor. We refresh the in-memory probe store (the dialog
   *  has already bridged suite rows into localStorage), notify the
   *  parent so its `activeSuite` state matches, and trigger a fresh
   *  Behavioral run so the panel reflects the new probe set without
   *  needing a manual "Re-run with new inputs" click. */
  const handleSuiteSaved = useCallback(
    (suite: TestSuite) => {
      onActiveSuiteChange?.(suite)
      if (!projectPath) return
      const next = loadProbeStore(projectPath)
      setProbeStore(next)
      void runOnce({ overrideStore: next })
    },
    [projectPath, runOnce, onActiveSuiteChange]
  )

  /** Fires after the user deletes the active suite from the editor.
   *  Clears the parent's `activeSuite` (so Scan Center stops
   *  narrowing to it) and refreshes the local probe store + run. */
  const handleSuiteDeleted = useCallback(() => {
    onActiveSuiteChange?.(null)
    if (!projectPath) return
    const next = loadProbeStore(projectPath)
    setProbeStore(next)
    void runOnce({ overrideStore: next })
  }, [projectPath, runOnce, onActiveSuiteChange])

  // Auto-run once on first mount of the tab so the user sees real
  // results without a click. We pass an `overrideStore` so the first
  // request includes any probes that were just bridged into
  // localStorage (suite save, "Run user-defined + AI tests", etc.) —
  // without the override, runOnce closes over the *initial* empty
  // probeStore and drops every user/suite probe on first paint.
  // Subsequent runs are explicit (button).
  useEffect(() => {
    if (canRun && report === null && !running && error === null && projectPath) {
      void runOnce({ overrideStore: loadProbeStore(projectPath) })
    }
    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRun])

  if (!canRun) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Behavioral tests need an open project on disk so they can read
          the agent source files. Open a project from the sidebar.
        </CardContent>
      </Card>
    )
  }

  const filteredTests = (report?.tests ?? []).filter((t) => {
    if (statusFilter !== "all" && t.status !== statusFilter) return false
    if (categoryFilter !== "all" && t.category !== categoryFilter) return false
    return true
  })

  const categoryOptions = useMemoCategories(report)

  return (
    <div className="space-y-6">
      <BehavioralRunHeader
        report={report}
        running={running}
        onRun={() => void runOnce()}
        onReplay={(seed) => void runOnce({ fixedSeed: seed })}
      />

      {error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-3 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {report && <BehavioralTotalsCards report={report} />}

      {report && <BehavioralCategoryGrid report={report} />}

      {report && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  Per-test details
                  {(() => {
                    // Distinguish suite-bridged probes (created by
                    // "Define user-defined inputs" in Scan Center)
                    // from stand-alone custom probes (created via
                    // "Edit/Create suite" right here). They live in
                    // the same store but the user thinks of them as
                    // two different surfaces, so labelling them
                    // separately removes the "why does my 1-row
                    // suite show 15 tests?" confusion.
                    const fromSuite = probeStore.userProbes.filter((p) =>
                      p.id.startsWith("user.suite.")
                    ).length
                    const standalone =
                      probeStore.userProbes.length - fromSuite
                    const builtin = Math.max(
                      0,
                      (report?.totals.total ?? 0) -
                        probeStore.userProbes.length
                    )
                    return (
                      <>
                        {builtin > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-secondary/40 text-muted-foreground border-border"
                          >
                            {builtin} built-in
                          </Badge>
                        )}
                        {fromSuite > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-accent/15 text-accent-foreground border-accent/40"
                          >
                            {fromSuite} from suite
                          </Badge>
                        )}
                        {standalone > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-accent/10 text-accent-foreground border-accent/30"
                          >
                            {standalone} custom
                          </Badge>
                        )}
                      </>
                    )
                  })()}
                </CardTitle>
                <CardDescription className="text-xs">
                  Each row is one adversarial probe. Built-in probes
                  cover every Scan Center category by default; rows
                  authored from <em>Define user-defined inputs</em>
                  {" "}(Scan Center) and <em>Edit suite</em> (here)
                  appear with a <strong>Custom</strong> badge. Flip{" "}
                  <strong>Only my tests</strong> on the right to
                  suppress the built-in pool entirely and run just
                  the probes you defined. Use the trash icon on any
                  row to remove that probe for this project.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label
                  className="flex items-center gap-2 text-[11px] text-muted-foreground select-none"
                  title="When on, the runner skips the 11 built-in probes and runs ONLY tests you defined (in Scan Center or via Edit suite here)."
                >
                  <Switch
                    checked={probeStore.userOnly}
                    onCheckedChange={handleToggleUserOnly}
                    aria-label="Only run my tests"
                  />
                  Only my tests
                </label>
                {probeStore.disabledProbeIds.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={handleRestoreBuiltins}
                    title="Re-enable every built-in probe you've hidden in this project"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore {probeStore.disabledProbeIds.length} hidden
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => setEditSuiteOpen(true)}
                  title={
                    activeSuite
                      ? `Edit "${activeSuite.name}" — add / remove tests, save as new, or delete the suite`
                      : "Create a user-defined suite — same dialog as Scan Center's Define user-defined inputs"
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  {activeSuite ? "Edit suite" : "Create suite"}
                </Button>
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <Select
                  value={statusFilter}
                  onValueChange={(v) =>
                    setStatusFilter(v as "all" | BehavioralStatus)
                  }
                >
                  <SelectTrigger className="h-8 w-32 bg-secondary/50 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="fail">Failed only</SelectItem>
                    <SelectItem value="pass">Passed only</SelectItem>
                    <SelectItem value="skip">Skipped only</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={categoryFilter}
                  onValueChange={setCategoryFilter}
                >
                  <SelectTrigger className="h-8 w-56 bg-secondary/50 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-[420px]">
                    <SelectItem value="all">All categories</SelectItem>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.category} value={c.category}>
                        {c.category}{" "}
                        <span className="text-muted-foreground text-xs">
                          ({c.total})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {filteredTests.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground space-y-2">
                {probeStore.userOnly &&
                probeStore.userProbes.length === 0 ? (
                  <>
                    <p>
                      <strong>Only my tests</strong> is on, but you
                      haven&apos;t defined any tests yet.
                    </p>
                    <p className="text-xs">
                      Use <em>Create suite</em> here or{" "}
                      <em>Define user-defined inputs</em> in Scan
                      Center to add tests — or flip the switch off
                      to run the built-in baseline.
                    </p>
                  </>
                ) : (
                  <>
                    <p>No tests match the current filters.</p>
                    {(probeStore.userProbes.length > 0 ||
                      probeStore.disabledProbeIds.length > 0) && (
                      <p className="text-xs">
                        Active customisations:{" "}
                        {probeStore.userProbes.length} custom ·{" "}
                        {probeStore.disabledProbeIds.length} hidden
                        built-in
                        {probeStore.disabledProbeIds.length === 1 ? "" : "s"}.
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTests.map((t) => (
                  <BehavioralTestRow
                    key={t.id}
                    test={t}
                    projectPath={projectPath}
                    onRemove={() => handleRemoveTest(t)}
                    onDefineSimilar={() => setEditSuiteOpen(true)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <DefineUserInputsDialog
        open={editSuiteOpen}
        onOpenChange={setEditSuiteOpen}
        scanReport={scanReport}
        projectId={projectId ?? undefined}
        projectPath={projectPath}
        initialSuite={activeSuite}
        onSuiteReady={handleSuiteSaved}
        onSuiteDeleted={handleSuiteDeleted}
      />
    </div>
  )
}

function useMemoCategories(report: BehavioralRunReport | null) {
  return useMemo(() => report?.by_category ?? [], [report])
}

function BehavioralRunHeader({
  report,
  running,
  onRun,
  onReplay,
}: {
  report: BehavioralRunReport | null
  running: boolean
  onRun: () => void
  onReplay: (seed: number) => void
}) {
  const lastRunLabel = report
    ? new Date(report.generated_at).toLocaleString()
    : null
  return (
    <Card className="bg-card border-border">
      <CardContent className="pt-4 pb-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold">
              Adversarial probes against your code
            </h2>
          </div>
          <p className="text-xs text-muted-foreground max-w-xl">
            Generates a fresh batch of single-prompt and agent-to-agent
            conversation probes for each scanner category, then statically
            checks whether the corresponding source file contains the
            defense each probe expects. Inputs rotate every run so you
            see new probes on each click. No LLM calls.
          </p>
          {lastRunLabel && (
            <p className="text-[11px] text-muted-foreground">
              Last run: <span className="font-mono">{lastRunLabel}</span>
              {report && (
                <>
                  {" · "}seed{" "}
                  <button
                    type="button"
                    className="font-mono underline-offset-2 hover:underline"
                    title="Click to re-run with the same seed (same inputs as this run)"
                    onClick={() => onReplay(report.seed)}
                  >
                    {report.seed}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <Button
          onClick={onRun}
          disabled={running}
          className="gap-2 min-w-[180px]"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating &amp; running…
            </>
          ) : report ? (
            <>
              <RefreshCw className="h-4 w-4" />
              Re-run with new inputs
            </>
          ) : (
            <>
              <PlayCircle className="h-4 w-4" />
              Generate &amp; Run Tests
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}

function BehavioralTotalsCards({ report }: { report: BehavioralRunReport }) {
  const t = report.totals
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <StatTile
        label="Total tests"
        value={t.total}
        icon={<Sparkles className="h-3.5 w-3.5" />}
      />
      <StatTile
        label="Passed"
        value={t.passed}
        icon={<CircleCheck className="h-3.5 w-3.5 text-emerald-400" />}
        tone="text-emerald-400"
      />
      <StatTile
        label="Failed"
        value={t.failed}
        icon={<CircleX className="h-3.5 w-3.5 text-red-400" />}
        tone="text-red-400"
      />
      <StatTile
        label="Skipped"
        value={t.skipped}
        icon={<CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />}
        tone="text-muted-foreground"
      />
      <StatTile
        label="Accuracy"
        value={formatAccuracyPct(t.accuracy)}
        tone={accuracyTone(t.accuracy)}
        title="passed / (passed + failed). Skipped probes are excluded from the denominator."
      />
    </div>
  )
}

function StatTile({
  label,
  value,
  icon,
  tone = "text-foreground",
  title,
}: {
  label: string
  value: number | string
  icon?: React.ReactNode
  tone?: string
  title?: string
}) {
  return (
    <Card className="bg-card border-border" title={title}>
      <CardContent className="py-3">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          {icon}
          {label}
        </div>
        <div className={`text-xl font-semibold mt-1 ${tone}`}>{value}</div>
      </CardContent>
    </Card>
  )
}

function BehavioralCategoryGrid({ report }: { report: BehavioralRunReport }) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Accuracy by category</CardTitle>
        <CardDescription className="text-xs">
          One row per Scan Center category. Accuracy = passes /
          (passes + fails). A red bar means the code did not defend
          against the probes for that category.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {report.by_category.map((c) => {
            const sev = severityTone(c.severity)
            const accColor = accuracyTone(c.accuracy)
            const pct =
              c.accuracy === null ? 0 : Math.round(c.accuracy * 100)
            const barColor =
              c.accuracy === null
                ? "bg-muted-foreground/40"
                : c.accuracy >= 0.85
                  ? "bg-emerald-500"
                  : c.accuracy >= 0.6
                    ? "bg-yellow-500"
                    : "bg-red-500"
            return (
              <div
                key={c.category}
                className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant="outline"
                      className={`${sev.badge} text-[10px] uppercase`}
                    >
                      {c.severity}
                    </Badge>
                    <span className="text-sm font-medium truncate">
                      {c.category}
                    </span>
                  </div>
                  <span className={`text-sm font-semibold ${accColor}`}>
                    {formatAccuracyPct(c.accuracy)}
                  </span>
                </div>
                <div className="h-1.5 w-full bg-muted-foreground/15 rounded">
                  <div
                    className={`h-1.5 rounded ${barColor}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="text-emerald-400">{c.passed} pass</span>
                  <span className="text-red-400">{c.failed} fail</span>
                  <span>{c.skipped} skip</span>
                  <span className="ml-auto">{c.total} total</span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function BehavioralTestRow({
  test,
  projectPath,
  onRemove,
  onDefineSimilar,
}: {
  test: BehavioralTestCase
  projectPath: string | null
  /** Called when the user clicks the trash icon. Parent decides
   *  whether this is "delete user probe" or "hide built-in probe". */
  onRemove?: () => void
  /** Optional helper to open the Define dialog pre-filled with this
   *  test's category — used from inside the expanded details panel. */
  onDefineSimilar?: () => void
}) {
  const [open, setOpen] = useState(false)
  const sev = severityTone(test.severity)
  const stat = statusTone(test.status)
  const isUserProbe = test.probe_id.startsWith("user.")

  // A test is "fixable" when it has a real target file/line AND a
  // backing scanner rule_id (the fix engine keys its templates off
  // rule_id, not probe_id). Skipped placeholders and UI-only categories
  // get a disabled trigger so the menu position stays consistent.
  const fixTargets: FixTarget[] =
    test.target_file && test.target_line && test.rule_id
      ? [
          {
            ref_id: test.id,
            rule_id: test.rule_id,
            file: test.target_file,
            line: test.target_line,
            title: test.name,
          },
        ]
      : []
  return (
    <div
      className={`rounded-md border ${
        test.status === "fail"
          ? "border-red-500/30 bg-red-500/[0.03]"
          : "border-border bg-secondary/20"
      }`}
    >
      {/* Header is a flex row, not a single <button>, so we can host
          the trash icon as its own clickable element without nesting
          buttons (invalid HTML). The toggleable expand area covers
          everything EXCEPT the trash button. */}
      <div className="w-full flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-3 text-left flex-1 min-w-0"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
        <span className={`h-2 w-2 rounded-full shrink-0 ${stat.dot}`} />
        {isUserProbe && (
          <Badge
            variant="outline"
            className="bg-accent/15 text-accent-foreground border-accent/30 text-[10px] uppercase"
          >
            Custom
          </Badge>
        )}
        <Badge
          variant="outline"
          className={`${stat.badge} text-[10px] uppercase`}
        >
          {stat.label}
        </Badge>
        <Badge
          variant="outline"
          className={`${sev.badge} text-[10px] uppercase`}
        >
          {test.severity}
        </Badge>
        <span className="text-sm font-medium truncate">{test.name}</span>
        <span className="text-xs text-muted-foreground truncate hidden md:inline">
          · {test.category}
        </span>
        {test.target_file && (
          <span className="ml-auto text-[11px] font-mono text-muted-foreground truncate max-w-[260px]">
            {test.target_file}
            {test.target_line ? `:${test.target_line}` : ""}
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${
            open ? "rotate-180" : ""
          }`}
        />
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:text-red-400 hover:border-red-500/40 hover:bg-red-500/10 transition-colors"
            title={
              isUserProbe
                ? "Delete this custom test"
                : "Hide this built-in probe for this project"
            }
            aria-label={
              isUserProbe ? "Delete custom test" : "Hide built-in probe"
            }
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-border px-3 py-3 space-y-3 text-sm">
          <DetailField
            label="Probe input"
            tone="border-amber-500/40 bg-amber-500/5"
            icon={<MessageSquare className="h-3.5 w-3.5 text-amber-400" />}
          >
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {test.input}
            </pre>
          </DetailField>

          {test.conversation.length > 1 && (
            <DetailField
              label={`Conversation (${test.conversation.length} turns)`}
              tone="border-purple-500/40 bg-purple-500/5"
              icon={<MessageSquare className="h-3.5 w-3.5 text-purple-400" />}
            >
              <div className="space-y-1.5">
                {test.conversation.map((turn, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs font-mono"
                  >
                    <span className="text-purple-300/80 shrink-0 w-16">
                      {turn.speaker}
                    </span>
                    <span className="whitespace-pre-wrap">{turn.text}</span>
                  </div>
                ))}
              </div>
            </DetailField>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <DetailField
              label="Expected defense"
              tone="border-emerald-500/40 bg-emerald-500/5"
            >
              <p className="text-xs text-foreground/90 leading-relaxed">
                {test.expected_defense}
              </p>
            </DetailField>
            <DetailField
              label="Observed in code"
              tone={
                test.status === "pass"
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : test.status === "fail"
                    ? "border-red-500/40 bg-red-500/5"
                    : "border-muted-foreground/30 bg-muted-foreground/5"
              }
            >
              <p className="text-xs text-foreground/90 leading-relaxed">
                {test.observed}
              </p>
            </DetailField>
          </div>

          {test.evidence && (
            <DetailField
              label={`Evidence ${
                test.target_file
                  ? `· ${test.target_file}${
                      test.target_line ? `:${test.target_line}` : ""
                    }`
                  : ""
              }`}
              tone="border-border bg-background/40"
            >
              <pre className="whitespace-pre overflow-x-auto font-mono text-[11px] leading-relaxed">
                {test.evidence}
              </pre>
            </DetailField>
          )}

          {test.notes && (
            <p className="text-[11px] text-muted-foreground italic">
              {test.notes}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 flex-wrap">
            {onDefineSimilar && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={onDefineSimilar}
                title="Open the suite editor — Save changes to update this suite, or Save as new for a fresh one"
              >
                <Plus className="h-3.5 w-3.5" />
                Edit suite
              </Button>
            )}
            <FindingFixButton
              targets={fixTargets}
              projectPath={projectPath}
              label="Fix code"
              dialogTitle={`Fix: ${test.name}`}
              size="sm"
              variant={test.status === "fail" ? "default" : "outline"}
              disabled={fixTargets.length === 0}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function DetailField({
  label,
  tone,
  icon,
  children,
}: {
  label: string
  tone: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className={`rounded-md border ${tone} p-2.5`}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
        {icon}
        {label}
      </div>
      {children}
    </div>
  )
}
