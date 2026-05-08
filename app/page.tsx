"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ProjectImport } from "@/components/project-import"
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
import {
  parseScanReport,
  mapReportToUiFindings,
  resolveChecksForApi,
  buildTopBarAgentsFromReport,
  buildOverviewAgentsFromReport,
  topFindingsFromReport,
  type ScanReport,
} from "@/lib/scan-report"

export default function Home() {
  const [hasProject, setHasProject] = useState(false)
  const [currentView, setCurrentView] = useState<ViewType>("overview")
  const [currentBranch, setCurrentBranch] = useState("main")
  const [selectedAgents, setSelectedAgents] = useState<string[]>(["all"])
  const [scanReport, setScanReport] = useState<ScanReport | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const riskScore = scanReport?.risk_score ?? 0
  const uiFindings = useMemo(() => (scanReport ? mapReportToUiFindings(scanReport) : []), [scanReport])
  const topBarAgents = useMemo(() => buildTopBarAgentsFromReport(scanReport, riskScore), [scanReport, riskScore])
  const overviewAgents = useMemo(() => buildOverviewAgentsFromReport(scanReport, riskScore), [scanReport, riskScore])
  const topFindings = useMemo(() => topFindingsFromReport(scanReport), [scanReport])
  const scanSummary = scanReport?.summary ?? null
  const lastScanLabel = scanReport
    ? new Date(scanReport.generated_at).toLocaleString()
    : "No scan yet"

  const executeScan = useCallback(async (selectedCheckIds: string[]) => {
    setScanning(true)
    setScanError(null)
    try {
      const checks = resolveChecksForApi(selectedCheckIds)
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
  }, [])

  useEffect(() => {
    if (!hasProject) return
    void executeScan([])
  }, [hasProject, executeScan])

  const handleProjectSelect = () => {
    setHasProject(true)
  }

  const handleChangeProject = () => {
    setHasProject(false)
    setScanReport(null)
    setScanError(null)
  }

  const handleNavigate = (view: string) => {
    setCurrentView(view as ViewType)
  }

  const handleRunScan = () => {
    setCurrentView("scan-center")
    void executeScan([])
  }

  if (!hasProject) {
    return <ProjectImport onProjectSelect={handleProjectSelect} />
  }

  const findingsCount = scanReport?.summary.total ?? 0
  const projectLabel =
    scanReport?.scan_root?.split("/").filter(Boolean).pop() ?? "customer-service-agent"

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
          />
        )
      case "scan-center":
        return (
          <ScanCenter
            selectedAgents={selectedAgents}
            onRunScan={executeScan}
            isScanning={scanning}
            scanError={scanError}
            lastIssueCount={scanReport?.summary.total ?? null}
            lastScanTime={scanReport ? new Date(scanReport.generated_at).toLocaleString() : null}
          />
        )
      case "detected-agents":
        return <DetectedAgents agents={overviewAgents} />
      case "findings":
        return <Findings findings={uiFindings} riskScore={riskScore} />
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
          />
        )
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
          onChangeProject={handleChangeProject}
          findingsCount={findingsCount}
        />
        <main className="flex-1 overflow-auto">{renderView()}</main>
      </div>
    </div>
  )
}
