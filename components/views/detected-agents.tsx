"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Bot,
  Eye,
  AlertTriangle,
  Wrench,
  FileCode,
  ExternalLink,
} from "lucide-react"
import type {
  OverviewAgentCard,
  ScanReport,
  AgentHit,
  ToolHit,
} from "@/lib/scan-report"

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
  /** Full scan report — needed to surface per-agent tools, findings, and
   * source location in the View Details dialog. Without it the dialog
   * gracefully degrades to whatever is on the OverviewAgentCard. */
  scanReport?: ScanReport | null
  /** Click handler for the dialog's "Open in Findings" button. The parent
   * is expected to set the agent filter and switch to the Findings view. */
  onOpenInFindings?: (agentName: string) => void
}

export function DetectedAgents({
  agents: agentsProp,
  hasProject = false,
  hasScan = false,
  scanReport = null,
  onOpenInFindings,
}: DetectedAgentsProps) {
  const source = agentsProp ?? []
  const agents = toDisplayAgents(source)

  // The View Details dialog is keyed off the agent name from the card the
  // user clicked. Names are unique within a single scan (agents_detected
  // dedupes server-side), so name is a safe identifier here.
  const [openAgent, setOpenAgent] = useState<string | null>(null)

  // Pre-bucket the report into name → AgentHit / ToolHit[] so the dialog
  // body is just a table render. Recomputed only when the scanReport
  // reference changes (i.e. on a new scan).
  const { agentByName, toolsByAgent, findingsByAgent } = useMemo(() => {
    const a: Record<string, AgentHit | undefined> = {}
    const t: Record<string, ToolHit[]> = {}
    const f: Record<
      string,
      { critical: number; high: number; medium: number; low: number; total: number }
    > = {}
    if (scanReport) {
      for (const hit of scanReport.agents_detected ?? []) {
        a[hit.name] = hit
      }
      for (const tool of scanReport.tools_detected ?? []) {
        const key = tool.agent ?? ""
        if (!key) continue
        if (!t[key]) t[key] = []
        t[key].push(tool)
      }
      for (const finding of scanReport.findings ?? []) {
        const key = finding.agent ?? ""
        if (!key) continue
        if (!f[key]) f[key] = { critical: 0, high: 0, medium: 0, low: 0, total: 0 }
        f[key][finding.severity] += 1
        f[key].total += 1
      }
    }
    return { agentByName: a, toolsByAgent: t, findingsByAgent: f }
  }, [scanReport])

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

  const detail = openAgent
    ? {
        card: agents.find((a) => a.name === openAgent) ?? null,
        hit: agentByName[openAgent] ?? null,
        tools: toolsByAgent[openAgent] ?? [],
        findings: findingsByAgent[openAgent] ?? null,
      }
    : null

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
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => setOpenAgent(agent.name)}
                  >
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

      <Dialog open={openAgent !== null} onOpenChange={(o) => !o && setOpenAgent(null)}>
        <DialogContent className="sm:max-w-[640px] flex flex-col max-h-[85vh] p-0">
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
            <div className="flex items-center justify-between gap-3">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-accent" />
                  {detail?.card?.name ?? openAgent}
                </DialogTitle>
                <DialogDescription>
                  {detail?.card?.framework
                    ? `${detail.card.framework} agent`
                    : "Agent details"}
                </DialogDescription>
              </div>
              {detail?.card ? getStatusBadge(detail.card.status) : null}
            </div>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-5">
            {/* Source — where the scanner found the agent definition. */}
            {detail?.hit ? (
              <section>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Source
                </div>
                <div className="text-sm font-mono text-foreground/90 break-all">
                  {detail.hit.file}:{detail.hit.line}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Detected as <span className="font-mono">{detail.hit.kind}</span>
                </div>
              </section>
            ) : (
              <section>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Source
                </div>
                <div className="text-sm text-muted-foreground">
                  No source location in latest scan.
                </div>
              </section>
            )}

            {/* Findings — severity breakdown filed against this agent. */}
            <section>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Findings
              </div>
              {detail?.findings ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline" className="border-border/60">
                    {detail.findings.total} total
                  </Badge>
                  {detail.findings.critical > 0 && (
                    <Badge variant="destructive">{detail.findings.critical} critical</Badge>
                  )}
                  {detail.findings.high > 0 && (
                    <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">
                      {detail.findings.high} high
                    </Badge>
                  )}
                  {detail.findings.medium > 0 && (
                    <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                      {detail.findings.medium} medium
                    </Badge>
                  )}
                  {detail.findings.low > 0 && (
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                      {detail.findings.low} low
                    </Badge>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No findings filed against this agent in the latest scan.
                </div>
              )}
            </section>

            {/* Tools — what the agent has access to (file:line + kind). */}
            <section>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Tools{" "}
                <span className="text-muted-foreground/70 normal-case">
                  ({detail?.tools.length ?? 0})
                </span>
              </div>
              {detail && detail.tools.length > 0 ? (
                <ScrollArea className="max-h-56 rounded-md border border-border/60">
                  <ul className="divide-y divide-border/60">
                    {detail.tools.map((tool, i) => (
                      <li
                        key={`${tool.name}-${tool.file}-${i}`}
                        className="flex items-start justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{tool.name}</div>
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {tool.file}
                            {tool.line ? `:${tool.line}` : ""}
                          </div>
                        </div>
                        <Badge variant="outline" className="border-border/60 text-[10px] capitalize shrink-0">
                          {tool.kind}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No tools attributed to this agent.
                </div>
              )}
            </section>
          </div>

          <DialogFooter className="px-6 py-3 border-t border-border/50 shrink-0">
            <Button variant="outline" onClick={() => setOpenAgent(null)}>
              Close
            </Button>
            <Button
              disabled={!onOpenInFindings || !openAgent}
              onClick={() => {
                if (openAgent && onOpenInFindings) {
                  onOpenInFindings(openAgent)
                  setOpenAgent(null)
                }
              }}
              className="gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Open in Findings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
