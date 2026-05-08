"use client"

import { useState } from "react"
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

export default function Home() {
  const [hasProject, setHasProject] = useState(false)
  const [currentView, setCurrentView] = useState<ViewType>("overview")
  const [currentBranch, setCurrentBranch] = useState("main")
  const [selectedAgents, setSelectedAgents] = useState<string[]>(["all"])
  const [riskScore] = useState(78)

  const handleProjectSelect = () => {
    setHasProject(true)
  }

  const handleChangeProject = () => {
    setHasProject(false)
  }

  const handleNavigate = (view: string) => {
    setCurrentView(view as ViewType)
  }

  const handleRunScan = () => {
    setCurrentView("scan-center")
  }

  if (!hasProject) {
    return <ProjectImport onProjectSelect={handleProjectSelect} />
  }

  const renderView = () => {
    switch (currentView) {
      case "overview":
        return <Overview onNavigate={handleNavigate} riskScore={riskScore} currentBranch={currentBranch} />
      case "scan-center":
        return <ScanCenter selectedAgents={selectedAgents} />
      case "detected-agents":
        return <DetectedAgents />
      case "findings":
        return <Findings />
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
        return <Overview onNavigate={handleNavigate} riskScore={riskScore} currentBranch={currentBranch} />
    }
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      <TopBar
        projectName="customer-service-agent"
        currentBranch={currentBranch}
        onBranchChange={setCurrentBranch}
        selectedAgents={selectedAgents}
        onAgentChange={setSelectedAgents}
        riskScore={riskScore}
        onRunScan={handleRunScan}
        onNavigateToBranchCompare={() => setCurrentView("branch-compare")}
      />
      <div className="flex flex-1 overflow-hidden">
        <AppSidebar 
          currentView={currentView} 
          onViewChange={setCurrentView}
          onChangeProject={handleChangeProject}
          findingsCount={12}
        />
        <main className="flex-1 overflow-auto">
          {renderView()}
        </main>
      </div>
    </div>
  )
}
