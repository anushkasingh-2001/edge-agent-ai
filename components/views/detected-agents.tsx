"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Bot, Eye, AlertTriangle, Wrench, FileCode } from "lucide-react"
import type { OverviewAgentCard } from "@/lib/scan-report"

function riskToStatus(risk: number): string {
  if (risk >= 86) return "critical"
  if (risk >= 61) return "warning"
  return "ok"
}

function toDisplayAgents(cards: OverviewAgentCard[]) {
  return cards.map((a) => ({
    name: a.name,
    framework: a.framework,
    tools: a.tools,
    prompts: a.prompts,
    riskScore: a.risk,
    status: a.status === "scanned" ? riskToStatus(a.risk) : a.status,
    description:
      a.status === "scanned"
        ? `Detected framework surface with evidence across ${a.tools} path(s).`
        : "Agent module",
  }))
}

function getRiskColor(score: number) {
  if (score >= 86) return "text-red-500"
  if (score >= 61) return "text-orange-500"
  if (score >= 31) return "text-yellow-500"
  return "text-green-500"
}

function getStatusBadge(status: string) {
  switch (status) {
    case "critical":
      return <Badge variant="destructive">Critical Risk</Badge>
    case "warning":
      return (
        <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Medium Risk</Badge>
      )
    case "ok":
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Low Risk</Badge>
    default:
      return null
  }
}

interface DetectedAgentsProps {
  agents?: OverviewAgentCard[]
  hasProject?: boolean
  hasScan?: boolean
}

export function DetectedAgents({
  agents: agentsProp,
  hasProject = false,
  hasScan = false,
}: DetectedAgentsProps) {
  const source = agentsProp ?? []
  const agents = toDisplayAgents(source)

  if (!hasProject) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Detected Agents</h1>
          <p className="text-muted-foreground">AI agents discovered in your project</p>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a local project or clone from GitHub before running a scan.
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!hasScan || agents.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Detected Agents</h1>
          <p className="text-muted-foreground">AI agents discovered in your project</p>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {hasScan
              ? "No agent frameworks detected in the latest scan."
              : "No scan results yet. Run a scan to detect agents."}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Detected Agents</h1>
        <p className="text-muted-foreground">AI agents discovered in your project</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-accent" />
              <div>
                <div className="text-2xl font-bold">{agents.length}</div>
                <div className="text-sm text-muted-foreground">Total Agents</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-2xl font-bold">{agents.filter((a) => a.status === "critical").length}</div>
                <div className="text-sm text-muted-foreground">Critical Risk</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-bold">{agents.reduce((sum, a) => sum + a.tools, 0)}</div>
                <div className="text-sm text-muted-foreground">Total Tools</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <FileCode className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-bold">{agents.reduce((sum, a) => sum + a.prompts, 0)}</div>
                <div className="text-sm text-muted-foreground">Total Prompts</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4">
        {agents.map((agent) => (
          <Card key={agent.name} className="bg-card border-border">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-accent/10 rounded-lg">
                    <Bot className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{agent.name}</CardTitle>
                    <CardDescription>{agent.description}</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {getStatusBadge(agent.status)}
                  <Button variant="outline" size="sm" className="gap-2">
                    <Eye className="h-4 w-4" />
                    View Details
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-6 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Framework:</span>
                  <Badge variant="secondary">{agent.framework}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Tools:</span>
                  <span className="font-medium">{agent.tools}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Prompts:</span>
                  <span className="font-medium">{agent.prompts}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Risk Score:</span>
                  <span className={`font-bold ${getRiskColor(agent.riskScore)}`}>{agent.riskScore}/100</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
