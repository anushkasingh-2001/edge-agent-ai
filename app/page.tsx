"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AppSidebar, type ViewType } from "@/components/app-sidebar"
import { TopBar } from "@/components/top-bar"
import { Overview } from "@/components/views/overview"
import { ScanCenter } from "@/components/views/scan-center"
import { DetectedAgents } from "@/components/views/detected-agents"
import { Findings } from "@/components/views/findings"
import { RunTraces } from "@/components/views/run-traces"
import { BranchCompare } from "@/components/views/branch-compare"
import { PromptPlayground } from "@/components/views/prompt-playground"
import { ChatAssistant } from "@/components/views/chat-assistant"
import { Settings } from "@/components/views/settings"
import { OpenProjectDialog } from "@/components/open-project-dialog"
import { CloneGithubDialog } from "@/components/clone-github-dialog"
import {
  parseScanReport,
  mapReportToUiFindings,
  resolveChecksForApi,
  buildTopBarAgentsFromReport,
  buildOverviewAgentsFromReport,
  buildToolsInventoryFromReport,
  totalToolCountFromReport,
  topFindingsFromReport,
  type ScanReport,
} from "@/lib/scan-report"
import {
  loadRecentProjects,
  saveRecentProject,
  type Project,
} from "@/lib/projects"
import {
  appendScanToHistory,
  loadScanHistory,
  scanHistoryForProject,
  scanItemFromReport,
  type ScanHistoryItem,
} from "@/lib/scan-history"
import type { TestSuite } from "@/lib/test-cases"

type GitBranchesResponse = {
  isRepo: boolean
  branches: string[]
  remoteOnly: string[]
  currentBranch: string | null
  expanded: boolean
}

/**
 * Post-filter a fresh scan report so the UI only sees the findings the
 * active user-defined suite was generated from. Two narrowing dimensions:
 *
 *  - `findingIds` (preferred) — exact match on `f.id`. One test ⇒ one
 *    finding, so a 12-test suite collapses to ~12 findings.
 *  - `files` (fallback) — match on `f.file`. Used when the suite was
 *    generated before we started stamping `related_finding`.
 *
 * If both are empty the report passes through unchanged. We also recompute
 * `summary` and `risk_score` so badges/donut/history reflect the narrowed
 * set instead of showing 100/100 next to a handful of findings.
 */
function narrowReport(
  report: ScanReport,
  narrow: { findingIds?: string[]; files?: string[] }
): ScanReport {
  const findingIds = narrow.findingIds ?? []
  const files = narrow.files ?? []
  if (findingIds.length === 0 && files.length === 0) return report

  let filtered = report.findings
  if (findingIds.length > 0) {
    const allow = new Set(findingIds)
    const byId = report.findings.filter((f) => allow.has(f.id))
    // If any IDs matched, prefer the precise filter; otherwise the suite's
    // IDs likely came from a *previous* scan whose finding IDs no longer
    // exist in this run, and we fall back to file-level narrowing.
    if (byId.length > 0) {
      filtered = byId
    } else if (files.length > 0) {
      const allowFiles = new Set(files)
      filtered = report.findings.filter((f) => allowFiles.has(f.file))
    } else {
      filtered = []
    }
  } else if (files.length > 0) {
    const allowFiles = new Set(files)
    filtered = report.findings.filter((f) => allowFiles.has(f.file))
  }

  const summary = {
    critical: filtered.filter((f) => f.severity === "critical").length,
    high: filtered.filter((f) => f.severity === "high").length,
    medium: filtered.filter((f) => f.severity === "medium").length,
    low: filtered.filter((f) => f.severity === "low").length,
    total: filtered.length,
  }
  // Same weighting the Python scanner uses (critical 25 / high 12 /
  // medium 6 / low 2, capped at 100).
  const raw =
    summary.critical * 25 +
    summary.high * 12 +
    summary.medium * 6 +
    summary.low * 2
  const risk_score = Math.min(100, raw)
  return { ...report, findings: filtered, summary, risk_score }
}

export default function Home() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [recentProjects, setRecentProjects] = useState<Project[]>([])
  const [currentView, setCurrentView] = useState<ViewType>("overview")
  const [currentBranch, setCurrentBranch] = useState("main")
  const [selectedAgents, setSelectedAgents] = useState<string[]>(["all"])
  const [scanReport, setScanReport] = useState<ScanReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [openLocalDialog, setOpenLocalDialog] = useState(false)
  const [openCloneDialog, setOpenCloneDialog] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitBranchesResponse | null>(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [scanHistory, setScanHistory] = useState<ScanHistoryItem[]>([])
  // The user-defined suite that's queued for the next scan. Lifted up here
  // so views beyond Scan Center (Overview) can show the *currently active*
  // user-defined tests instead of summing across every saved suite.
  const [activeSuite, setActiveSuite] = useState<TestSuite | null>(null)

  useEffect(() => {
    setRecentProjects(loadRecentProjects())
    setScanHistory(loadScanHistory())
  }, [])

  /**
   * Whenever the user opens / switches a project, refresh the real branch
   * list from disk via /api/git/branches. The endpoint returns isRepo:false
   * gracefully for non-Git folders, so we don't need to special-case errors.
   * If the project carries an explicit `branch` (set by the GitHub clone
   * flow), keep it; otherwise align `currentBranch` with the repo's HEAD.
   */
  useEffect(() => {
    if (!selectedProject) {
      setGitInfo(null)
      setGitLoading(false)
      return
    }
    const ac = new AbortController()
    setGitLoading(true)
    void (async () => {
      try {
        const res = await fetch(
          `/api/git/branches?projectPath=${encodeURIComponent(selectedProject.path)}`,
          { signal: ac.signal }
        )
        const data = (await res.json()) as Partial<GitBranchesResponse> & {
          error?: string
        }
        if (ac.signal.aborted) return
        if (!res.ok || !data || typeof data.isRepo !== "boolean") {
          setGitInfo({
            isRepo: false,
            branches: [],
            remoteOnly: [],
            currentBranch: null,
            expanded: false,
          })
          return
        }
        const info: GitBranchesResponse = {
          isRepo: data.isRepo,
          branches: Array.isArray(data.branches) ? data.branches : [],
          remoteOnly: Array.isArray(data.remoteOnly) ? data.remoteOnly : [],
          currentBranch: data.currentBranch ?? null,
          expanded: Boolean(data.expanded),
        }
        setGitInfo(info)
        // If the user hasn't been steered to a specific branch by the project
        // record itself, follow whatever the repo says is checked out.
        if (info.currentBranch && (!selectedProject.branch || selectedProject.branch.trim() === "")) {
          setCurrentBranch(info.currentBranch)
        }
      } catch {
        if (!ac.signal.aborted) {
          setGitInfo({
            isRepo: false,
            branches: [],
            remoteOnly: [],
            currentBranch: null,
            expanded: false,
          })
        }
      } finally {
        if (!ac.signal.aborted) setGitLoading(false)
      }
    })()
    return () => ac.abort()
  }, [selectedProject])

  const riskScore = scanReport?.risk_score ?? 0
  const uiFindings = useMemo(
    () => (scanReport ? mapReportToUiFindings(scanReport) : []),
    [scanReport]
  )
  const topBarAgents = useMemo(
    () => buildTopBarAgentsFromReport(scanReport, riskScore),
    [scanReport, riskScore]
  )
  const overviewAgents = useMemo(
    () => buildOverviewAgentsFromReport(scanReport, riskScore),
    [scanReport, riskScore]
  )
  const toolsInventory = useMemo(
    () => buildToolsInventoryFromReport(scanReport),
    [scanReport]
  )
  const totalToolCount = useMemo(
    () => totalToolCountFromReport(scanReport),
    [scanReport]
  )
  const topFindings = useMemo(() => topFindingsFromReport(scanReport), [scanReport])
  const scanSummary = scanReport?.summary ?? null
  // Distinct scanner rule_ids that produced at least one finding in the
  // latest scan. The Overview "Tests" tile uses this to compute how many
  // built-in checks "passed" (no findings) vs "failed" each scan, so the
  // tile updates with every run instead of staying static.
  const failedRuleIds = useMemo<string[]>(() => {
    if (!scanReport) return []
    const ids = new Set<string>()
    for (const f of scanReport.findings) ids.add(f.rule_id)
    return Array.from(ids)
  }, [scanReport])
  const lastScanLabel = scanReport
    ? new Date(scanReport.generated_at).toLocaleString()
    : "No scan yet"

  const projectLabel = selectedProject?.name ?? "No project opened"
  const hasProject = selectedProject !== null
  const hasScan = scanReport !== null
  const findingsCount = scanReport?.summary.total ?? 0

  const persistProject = useCallback((project: Project) => {
    const next: Project = { ...project, lastOpenedAt: new Date().toISOString() }
    saveRecentProject(next)
    setRecentProjects(loadRecentProjects())
    return next
  }, [])

  const executeScan = useCallback(
    async (
      selectedCheckIds: string[],
      projectOverride?: Project,
      /** When set, post-filter the scan report so the UI only sees findings
       * the active user-defined suite was generated from. Two dimensions:
       *  - `findingIds` (preferred): exact-match on the finding `id`.
       *  - `files` (fallback): match on `file` for older suites that
       *    don't carry finding ids. */
      narrow?: { findingIds?: string[]; files?: string[] }
    ): Promise<{ beforeCount: number; afterCount: number; narrowed: boolean }> => {
      const target = projectOverride ?? selectedProject
      if (!target) {
        setScanError(
          "Open a local project or clone from GitHub before running a scan."
        )
        return { beforeCount: 0, afterCount: 0, narrowed: false }
      }
      setScanning(true)
      setScanError(null)
      try {
        const checks = resolveChecksForApi(selectedCheckIds)
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectPath: target.path,
            checks: checks && checks.length > 0 ? checks : undefined,
          }),
        })
        const raw = await res.json()
        if (!res.ok) {
          const msg = typeof raw.error === "string" ? raw.error : "Scan failed"
          throw new Error(msg)
        }
        let report = parseScanReport(raw)
        const beforeCount = report.findings.length
        if (narrow) {
          report = narrowReport(report, narrow)
        }
        const afterCount = report.findings.length
        // Console breadcrumb so the dev can confirm narrowing actually ran
        // without sprinkling logs in normal scan flow.
        if (narrow) {
          console.info(
            `[edge-agent-ai] Suite narrowing: ${beforeCount} → ${afterCount} findings`,
            {
              findingIds: narrow.findingIds?.length ?? 0,
              files: narrow.files?.length ?? 0,
              fileSample: narrow.files?.slice(0, 5),
            }
          )
        }
        setScanReport(report)
        setSelectedAgents(["all"])
        // Persist to history so the Scan Center "Recent Scans" list grows
        // beyond a single "Latest scan" entry.
        const branchAtScan =
          target.branch?.trim() || currentBranch || "main"
        const item = scanItemFromReport(report, target, branchAtScan)
        const next = appendScanToHistory(item)
        setScanHistory(next)
        return {
          beforeCount,
          afterCount,
          narrowed: Boolean(narrow),
        }
      } catch (e) {
        setScanError(e instanceof Error ? e.message : "Scan failed")
        return { beforeCount: 0, afterCount: 0, narrowed: false }
      } finally {
        setScanning(false)
      }
    },
    [selectedProject, currentBranch]
  )

  /** Load a historical scan back into the current view. If the scan belongs
   * to a different project than the currently-selected one, switch to that
   * project too so the rest of the UI lines up. */
  const handleLoadScan = useCallback((item: ScanHistoryItem) => {
    const projectFromItem: Project = {
      id: item.projectId,
      name: item.projectName,
      path: item.projectPath,
      source: "local",
      branch: item.branch,
      lastOpenedAt: new Date().toISOString(),
    }
    setSelectedProject(projectFromItem)
    setScanReport(item.report)
    setScanError(null)
    if (item.branch && item.branch.trim()) {
      setCurrentBranch(item.branch.trim())
    }
    setSelectedAgents(["all"])
  }, [])

  const handleOpenProject = useCallback(
    (project: Project) => {
      const persisted = persistProject(project)
      setSelectedProject(persisted)
      setScanReport(null)
      setScanError(null)
      setCurrentView("overview")
      // A suite picked for project A should not stay active when the user
      // jumps to project B — its file/finding targets won't make sense.
      setActiveSuite(null)
      if (persisted.branch && persisted.branch.trim()) {
        setCurrentBranch(persisted.branch.trim())
      }
    },
    [persistProject]
  )

  const handleOpenAndScan = useCallback(
    (project: Project) => {
      const persisted = persistProject(project)
      setSelectedProject(persisted)
      setScanReport(null)
      setScanError(null)
      setCurrentView("overview")
      setActiveSuite(null)
      if (persisted.branch && persisted.branch.trim()) {
        setCurrentBranch(persisted.branch.trim())
      }
      void executeScan([], persisted)
    },
    [persistProject, executeScan]
  )

  const handleSwitchProject = useCallback(
    (project: Project) => {
      handleOpenProject(project)
    },
    [handleOpenProject]
  )

  const handleNavigate = (view: string) => {
    setCurrentView(view as ViewType)
  }

  const handleRunScan = () => {
    if (!selectedProject) {
      setScanError(
        "Open a local project or clone from GitHub before running a scan."
      )
      setCurrentView("scan-center")
      return
    }
    setCurrentView("scan-center")
    void executeScan([])
  }

  const renderView = () => {
    switch (currentView) {
      case "overview":
        return (
          <Overview
            onNavigate={handleNavigate}
            riskScore={riskScore}
            currentBranch={currentBranch}
            projectLabel={projectLabel}
            projectId={selectedProject?.id}
            scanSummary={scanSummary}
            topFindings={topFindings}
            detectedAgents={overviewAgents}
            lastScanLabel={lastScanLabel}
            hasProject={hasProject}
            hasScan={hasScan}
            activeSuite={activeSuite}
            failedRuleIds={failedRuleIds}
          />
        )
      case "scan-center":
        return (
          <ScanCenter
            selectedAgents={selectedAgents}
            onRunScan={async (ids, narrow) =>
              executeScan(ids, undefined, narrow)
            }
            isScanning={scanning}
            scanError={scanError}
            lastIssueCount={scanReport?.summary.total ?? null}
            lastScanTime={
              scanReport ? new Date(scanReport.generated_at).toLocaleString() : null
            }
            hasProject={hasProject}
            projectLabel={projectLabel}
            scanReport={scanReport}
            project={selectedProject}
            branch={currentBranch}
            scanHistory={scanHistoryForProject(scanHistory, selectedProject?.id)}
            onLoadScan={handleLoadScan}
            activeSuite={activeSuite}
            onActiveSuiteChange={setActiveSuite}
          />
        )
      case "detected-agents":
        return (
          <DetectedAgents
            agents={overviewAgents}
            hasProject={hasProject}
            hasScan={hasScan}
          />
        )
      case "findings":
        return (
          <Findings
            findings={uiFindings}
            riskScore={riskScore}
            hasProject={hasProject}
            hasScan={hasScan}
          />
        )
      case "run-traces":
        return <RunTraces />
      case "branch-compare":
        return <BranchCompare currentBranch={currentBranch} />
      case "prompt-playground":
        return <PromptPlayground />
      case "chat-assistant":
        return <ChatAssistant currentBranch={currentBranch} />
      case "settings":
        return <Settings />
      default:
        return null
    }
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <TopBar
        projectName={projectLabel}
        currentBranch={currentBranch}
        onBranchChange={setCurrentBranch}
        selectedAgents={selectedAgents}
        onAgentChange={setSelectedAgents}
        riskScore={riskScore}
        onRunScan={handleRunScan}
        onNavigateToBranchCompare={() => setCurrentView("branch-compare")}
        agentOptions={topBarAgents}
        toolsInventory={toolsInventory}
        totalToolCount={totalToolCount}
        hasScan={hasScan}
        hasProject={hasProject}
        branches={gitInfo?.branches ?? []}
        remoteOnlyBranches={gitInfo?.remoteOnly ?? []}
        gitCurrentBranch={gitInfo?.currentBranch ?? null}
        isGitRepo={gitInfo?.isRepo ?? false}
        gitLoading={gitLoading}
        scanReport={scanReport}
        project={selectedProject}
      />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar
          currentView={currentView}
          onViewChange={setCurrentView}
          findingsCount={findingsCount}
          selectedProject={selectedProject}
          recentProjects={recentProjects}
          onSwitchProject={handleSwitchProject}
          onOpenLocalProject={() => setOpenLocalDialog(true)}
          onCloneFromGithub={() => setOpenCloneDialog(true)}
        />
        <main className="flex-1 overflow-auto">{renderView()}</main>
      </div>

      <OpenProjectDialog
        open={openLocalDialog}
        onOpenChange={setOpenLocalDialog}
        onOpenProject={handleOpenProject}
        onOpenAndScan={handleOpenAndScan}
      />
      <CloneGithubDialog
        open={openCloneDialog}
        onOpenChange={setOpenCloneDialog}
        onCloned={handleOpenProject}
        onClonedAndScan={handleOpenAndScan}
      />
    </div>
  )
}
