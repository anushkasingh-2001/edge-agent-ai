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
  topFindingsFromReport,
  type ScanReport,
} from "@/lib/scan-report"
import {
  loadRecentProjects,
  saveRecentProject,
  type Project,
} from "@/lib/projects"

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

  useEffect(() => {
    setRecentProjects(loadRecentProjects())
  }, [])

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
  const topFindings = useMemo(() => topFindingsFromReport(scanReport), [scanReport])
  const scanSummary = scanReport?.summary ?? null
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
    async (selectedCheckIds: string[], projectOverride?: Project) => {
      const target = projectOverride ?? selectedProject
      if (!target) {
        setScanError(
          "Open a local project or clone from GitHub before running a scan."
        )
        return
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
        const report = parseScanReport(raw)
        setScanReport(report)
        setSelectedAgents(["all"])
      } catch (e) {
        setScanError(e instanceof Error ? e.message : "Scan failed")
      } finally {
        setScanning(false)
      }
    },
    [selectedProject]
  )

  const handleOpenProject = useCallback(
    (project: Project) => {
      const persisted = persistProject(project)
      setSelectedProject(persisted)
      setScanReport(null)
      setScanError(null)
      setCurrentView("overview")
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
            scanSummary={scanSummary}
            topFindings={topFindings}
            detectedAgents={overviewAgents}
            lastScanLabel={lastScanLabel}
            hasProject={hasProject}
            hasScan={hasScan}
          />
        )
      case "scan-center":
        return (
          <ScanCenter
            selectedAgents={selectedAgents}
            onRunScan={(ids) => executeScan(ids)}
            isScanning={scanning}
            scanError={scanError}
            lastIssueCount={scanReport?.summary.total ?? null}
            lastScanTime={
              scanReport ? new Date(scanReport.generated_at).toLocaleString() : null
            }
            hasProject={hasProject}
            projectLabel={projectLabel}
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
