"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  ChevronDown,
  GitBranch,
  GitCompare,
  Download,
  Upload,
  ArrowUpFromLine,
  Play,
  FileText,
  Bot,
  Check,
} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface TopBarProps {
  projectName: string
  currentBranch: string
  onBranchChange: (branch: string) => void
  selectedAgents: string[]
  onAgentChange: (agents: string[]) => void
  riskScore: number
  onRunScan: () => void
  onNavigateToBranchCompare: () => void
}

const branches = [
  "main",
  "develop",
  "feature/refund-agent",
  "feature/mcp-tools",
  "bugfix/prompt-regression",
]

const agents = [
  { id: "all", name: "All Agents", framework: null, tools: 0, prompts: 0, risk: 0 },
  { id: "support", name: "SupportAgent", framework: "LangGraph", tools: 8, prompts: 3, risk: 72 },
  { id: "chat", name: "ChatAgent", framework: "LangChain", tools: 5, prompts: 4, risk: 45 },
  { id: "data", name: "DataAgent", framework: "LlamaIndex", tools: 12, prompts: 2, risk: 38 },
  { id: "api", name: "APIAgent", framework: "AutoGen", tools: 6, prompts: 2, risk: 56 },
  { id: "admin", name: "AdminAgent", framework: "LangGraph", tools: 15, prompts: 5, risk: 89 },
]

function getRiskLevel(score: number): { label: string; color: string } {
  if (score >= 86) return { label: "Critical", color: "text-red-400" }
  if (score >= 61) return { label: "High", color: "text-orange-400" }
  if (score >= 31) return { label: "Medium", color: "text-yellow-400" }
  return { label: "Low", color: "text-green-400" }
}

function getRiskBadgeColor(score: number): string {
  if (score >= 86) return "border-red-500/50 text-red-400 bg-red-500/10"
  if (score >= 61) return "border-orange-500/50 text-orange-400 bg-orange-500/10"
  if (score >= 31) return "border-yellow-500/50 text-yellow-400 bg-yellow-500/10"
  return "border-green-500/50 text-green-400 bg-green-500/10"
}

export function TopBar({
  projectName,
  currentBranch,
  onBranchChange,
  selectedAgents,
  onAgentChange,
  riskScore,
  onRunScan,
  onNavigateToBranchCompare,
}: TopBarProps) {
  const riskInfo = getRiskLevel(riskScore)
  const selectedAgentNames = selectedAgents.includes("all") 
    ? "All Agents" 
    : selectedAgents.length === 1 
      ? agents.find(a => a.id === selectedAgents[0])?.name || "Select Agents"
      : `${selectedAgents.length} Agents`

  const toggleAgent = (agentId: string) => {
    if (agentId === "all") {
      onAgentChange(["all"])
    } else {
      const newAgents = selectedAgents.filter(id => id !== "all")
      if (newAgents.includes(agentId)) {
        const filtered = newAgents.filter(id => id !== agentId)
        onAgentChange(filtered.length > 0 ? filtered : ["all"])
      } else {
        onAgentChange([...newAgents, agentId])
      }
    }
  }

  return (
    <div className="h-14 border-b border-border bg-card/50 backdrop-blur-sm px-4 flex items-center justify-between">
      {/* Left Section: Project Name, Branch, Agents */}
      <div className="flex items-center gap-4">
        {/* Project Name */}
        <span className="text-sm font-medium">{projectName}</span>

        <div className="h-6 w-px bg-border" />

        {/* Branch Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2 bg-secondary/50">
              <GitBranch className="h-4 w-4" />
              <span className="max-w-[120px] truncate">{currentBranch}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Run scans on the selected local branch.
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {branches.map((branch) => (
              <DropdownMenuItem
                key={branch}
                onClick={() => onBranchChange(branch)}
                className="gap-2"
              >
                <GitBranch className="h-4 w-4" />
                <span className="flex-1">{branch}</span>
                {branch === currentBranch && <Check className="h-4 w-4 text-accent" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNavigateToBranchCompare} className="gap-2">
              <GitCompare className="h-4 w-4" />
              <span>Compare Branches</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Agent Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2 bg-secondary/50">
              <Bot className="h-4 w-4" />
              <span className="max-w-[120px] truncate">{selectedAgentNames}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Detected Agents
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {agents.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                onClick={() => toggleAgent(agent.id)}
                className="flex-col items-start gap-1 py-2"
              >
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                      selectedAgents.includes(agent.id) || (agent.id !== "all" && selectedAgents.includes("all"))
                        ? "bg-accent border-accent"
                        : "border-border"
                    }`}>
                      {(selectedAgents.includes(agent.id) || (agent.id !== "all" && selectedAgents.includes("all"))) && (
                        <Check className="h-3 w-3 text-accent-foreground" />
                      )}
                    </div>
                    <span className="font-medium">{agent.name}</span>
                  </div>
                  {agent.id !== "all" && (
                    <Badge variant="outline" className={`text-xs ${getRiskBadgeColor(agent.risk)}`}>
                      {agent.risk}/100
                    </Badge>
                  )}
                </div>
                {agent.id !== "all" && (
                  <div className="text-xs text-muted-foreground pl-6 flex gap-3">
                    <span>{agent.framework}</span>
                    <span>{agent.tools} tools</span>
                    <span>{agent.prompts} prompts</span>
                  </div>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Risk Score */}
        <Badge variant="outline" className={`${getRiskBadgeColor(riskScore)} font-medium`}>
          {riskScore}/100 {riskInfo.label} Risk
        </Badge>
      </div>

      {/* Right Section: Actions in order: Run Scan, Pull, Commit, Push, Export Report */}
      <TooltipProvider>
        <div className="flex items-center gap-2">
          {/* Run Scan - Primary */}
          <Button onClick={onRunScan} size="sm" className="gap-2">
            <Play className="h-4 w-4" />
            Run Scan
          </Button>

          {/* Pull */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                Pull
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Pull latest changes from the selected branch</p>
            </TooltipContent>
          </Tooltip>

          {/* Commit */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                Commit
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Commit local changes after scan review</p>
            </TooltipContent>
          </Tooltip>

          {/* Push */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpFromLine className="h-4 w-4" />
                Push
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Push selected branch to GitHub</p>
            </TooltipContent>
          </Tooltip>

          {/* Export Report */}
          <Button variant="outline" size="sm" className="gap-2">
            <FileText className="h-4 w-4" />
            Export Report
          </Button>
        </div>
      </TooltipProvider>
    </div>
  )
}
