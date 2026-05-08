"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { OverviewAgentCard } from "@/lib/scan-report"
import {
  AlertTriangle,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  Play,
  TrendingUp,
  GitBranch,
  FileCode,
  Bot,
  Download,
  Upload,
  ArrowUpFromLine,
} from "lucide-react"

const recentScans = [
  { id: 1, branch: "main", status: "completed", issues: 12, time: "2 hours ago" },
  { id: 2, branch: "feature/auth-update", status: "completed", issues: 3, time: "Yesterday" },
  { id: 3, branch: "fix/prompt-injection", status: "completed", issues: 0, time: "3 days ago" },
]

function getRiskLevel(score: number): { label: string; color: string; badgeColor: string } {
  if (score >= 86) return { label: "Critical", color: "text-red-400", badgeColor: "border-red-500/50 text-red-400 bg-red-500/10" }
  if (score >= 61) return { label: "High", color: "text-orange-400", badgeColor: "border-orange-500/50 text-orange-400 bg-orange-500/10" }
  if (score >= 31) return { label: "Medium", color: "text-yellow-400", badgeColor: "border-yellow-500/50 text-yellow-400 bg-yellow-500/10" }
  return { label: "Low", color: "text-green-400", badgeColor: "border-green-500/50 text-green-400 bg-green-500/10" }
}

interface OverviewProps {
  onNavigate: (view: string) => void
  riskScore: number
  currentBranch: string
  projectLabel?: string
  scanSummary: { critical: number; high: number; medium: number; low: number; total: number } | null
  topFindings: { title: string; severity: string; file: string; line: number }[]
  detectedAgents: OverviewAgentCard[]
  lastScanLabel: string
}

export function Overview({
  onNavigate,
  riskScore,
  currentBranch,
  projectLabel = "customer-service-agent",
  scanSummary,
  topFindings,
  detectedAgents,
  lastScanLabel,
}: OverviewProps) {
  const riskInfo = getRiskLevel(riskScore)
  const criticalIssues = scanSummary?.critical ?? 0
  const sev = scanSummary ?? { critical: 0, high: 0, medium: 0, low: 0, total: 0 }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-muted-foreground">Security status for {projectLabel}</p>
        </div>
        <Button onClick={() => onNavigate("scan-center")}>
          <Play className="h-4 w-4 mr-2" />
          Run Scan
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Risk Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className={`text-3xl font-bold ${riskInfo.color}`}>{riskScore}</span>
              <span className="text-muted-foreground">/100</span>
              <span className={`text-sm ${riskInfo.color}`}>{riskInfo.label}</span>
            </div>
            {scanSummary && scanSummary.total > 0 ? (
              <div className="flex items-center gap-1 mt-1 text-sm text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                <span>{scanSummary.total} open findings</span>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground mt-2">
              0-30 Low | 31-60 Medium | 61-85 High | 86-100 Critical
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Critical Issues
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-red-400">{criticalIssues}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Tests Passing
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-green-400">42</span>
              <span className="text-muted-foreground">/48</span>
            </div>
            <Progress value={87.5} className="mt-2 h-1" />
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Last Scan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-semibold">{lastScanLabel}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">Branch: {currentBranch}</div>
          </CardContent>
        </Card>
      </div>

      {/* Detected Agents */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle className="text-base">Detected Agents</CardTitle>
            <CardDescription>Per-agent risk scores and status</CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            {detectedAgents.length} agents
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-3">
            {detectedAgents.map((agent) => {
              const agentRisk = getRiskLevel(agent.risk)
              return (
                <Card key={agent.name} className="bg-secondary/30 border-border">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-accent" />
                        <span className="font-medium text-sm">{agent.name}</span>
                      </div>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>Framework: {agent.framework}</div>
                      <div>Tools: {agent.tools}</div>
                      <div>Prompts: {agent.prompts}</div>
                    </div>
                    <Badge variant="outline" className={`text-xs ${agentRisk.badgeColor}`}>
                      Risk: {agent.risk}/100 {agentRisk.label}
                    </Badge>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Findings by Severity */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Findings by Severity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-8">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <div>
                <div className="text-2xl font-bold">{sev.critical}</div>
                <div className="text-sm text-muted-foreground">Critical</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-orange-500" />
              <div>
                <div className="text-2xl font-bold">{sev.high}</div>
                <div className="text-sm text-muted-foreground">High</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <div>
                <div className="text-2xl font-bold">{sev.medium}</div>
                <div className="text-sm text-muted-foreground">Medium</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <div>
                <div className="text-2xl font-bold">{sev.low}</div>
                <div className="text-sm text-muted-foreground">Low</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Git Workflow Card */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Git Workflow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="text-muted-foreground">Current branch:</div>
                <div className="font-mono">{currentBranch}</div>
                <div className="text-muted-foreground">Remote:</div>
                <div className="font-mono">origin</div>
                <div className="text-muted-foreground">Status:</div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-green-400">clean</span>
                </div>
                <div className="text-muted-foreground">Last commit SHA:</div>
                <div className="font-mono text-xs bg-secondary/50 px-2 py-0.5 rounded w-fit">a1b2c3d</div>
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Git actions apply to the selected branch. Run scans before commit or push to catch risky agent changes.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                Pull from GitHub
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                Commit Changes
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowUpFromLine className="h-4 w-4" />
                Push to GitHub
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        {/* Top Findings */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Top Findings</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("findings")}>
              View all
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topFindings.map((finding, i) => (
                <div
                  key={`${finding.file}:${finding.line}:${i}`}
                  className="flex items-start gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer"
                >
                  <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                    finding.severity === "critical" ? "bg-red-500" :
                    finding.severity === "high" ? "bg-orange-500" :
                    finding.severity === "medium" ? "bg-yellow-500" : "bg-blue-500"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{finding.title}</div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <FileCode className="h-3 w-3" />
                      <span>{finding.file}:{finding.line}</span>
                    </div>
                  </div>
                  <Badge variant="outline" className={`shrink-0 text-xs ${
                    finding.severity === "critical" ? "border-red-500/50 text-red-400" :
                    finding.severity === "high" ? "border-orange-500/50 text-orange-400" :
                    finding.severity === "medium" ? "border-yellow-500/50 text-yellow-400" : "border-blue-500/50 text-blue-400"
                  }`}>
                    {finding.severity}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Scans */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Scans</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("scan-center")}>
              View all
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentScans.map((scan) => (
                <div key={scan.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-secondary rounded-md">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{scan.branch}</div>
                      <div className="text-xs text-muted-foreground">{scan.time}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {scan.issues > 0 ? (
                      <Badge variant="outline" className="border-orange-500/50 text-orange-400">
                        {scan.issues} issues
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-green-500/50 text-green-400">
                        Clean
                      </Badge>
                    )}
                    {scan.status === "completed" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
