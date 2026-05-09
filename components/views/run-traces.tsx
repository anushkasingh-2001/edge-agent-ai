"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Activity,
  Search,
  Filter,
  Eye,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Pause,
  ChevronDown,
} from "lucide-react"
import {
  formatScanTime,
  type ScanHistoryItem,
} from "@/lib/scan-history"
import { SCANNER_RULE_IDS } from "@/lib/scan-report"

/**
 * Run Traces shows one trace per real scan in `scanHistory`. There is no
 * runtime agent monitor wired up yet — these are *scan-pipeline* traces
 * derived from each `ScanReport`, not live LLM execution. The previous
 * implementation rendered fake `SupportAgent` / `DataAgent` rows with
 * invented prompts; that misled users into thinking we were observing
 * their agents at runtime.
 */

type TraceStatus = "success" | "warning" | "error"

interface TraceRow {
  /** Stable id from the underlying scan history item. */
  id: string
  /** Comma-separated agent names from this scan, or "(no agents detected)". */
  agents: string
  /** Set of agents in this scan — used for the agent filter (lowercased). */
  agentSet: Set<string>
  /** ISO timestamp from the scan report. */
  timestamp: string
  /** Pretty-printed timestamp via `formatScanTime`. */
  startTime: string
  /** Branch the scan ran against. */
  branch: string
  /** success / warning / error derived from severity counts. */
  status: TraceStatus
  /** Number of distinct rule_ids that produced findings. */
  toolCalls: number
  /** Total findings (used in place of "tokens"). */
  findings: number
  /** Headline summary used as the row's secondary line. */
  headline: string
  /** Step-by-step pipeline events for the expanded view. */
  events: { label: string; detail?: string; severity?: TraceStatus }[]
}

function statusFromSummary(s: ScanHistoryItem["summary"]): TraceStatus {
  if (s.critical > 0) return "error"
  if (s.high > 0 || s.medium > 0) return "warning"
  return "success"
}

function getStatusIcon(status: TraceStatus) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-orange-500" />
    case "error":
      return <XCircle className="h-4 w-4 text-red-500" />
  }
}

function getStatusBadge(status: TraceStatus) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Clean</Badge>
    case "warning":
      return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Issues</Badge>
    case "error":
      return <Badge variant="destructive">Critical</Badge>
  }
}

/**
 * Build a `TraceRow` (with its event list) from a stored scan. Every event
 * line maps to something concrete in the report so this is a real audit
 * trail, not narration.
 */
function traceFromScan(item: ScanHistoryItem): TraceRow {
  const r = item.report
  const agentNames = (r.agents_detected ?? []).map((a) => a.name)
  const frameworkNames = r.frameworks_detected ?? []
  const toolCount = (r.tools_detected ?? []).length
  const ruleHits = new Set(r.findings.map((f) => f.rule_id))
  const status = statusFromSummary(item.summary)

  const events: TraceRow["events"] = [
    { label: "Scan started", detail: `Project root: ${item.projectPath || r.scan_root}` },
    { label: "Project validated", detail: `Branch: ${item.branch || "—"}` },
    {
      label: "Frameworks detected",
      detail: frameworkNames.length > 0 ? frameworkNames.join(", ") : "None",
    },
    {
      label: "Agents detected",
      detail:
        agentNames.length > 0
          ? `${agentNames.length} (${agentNames.slice(0, 4).join(", ")}${
              agentNames.length > 4 ? "…" : ""
            })`
          : "None",
    },
    {
      label: "Tools inventoried",
      detail: toolCount > 0 ? `${toolCount} tool reference(s)` : "None",
    },
    {
      label: "Rules executed",
      detail: `${SCANNER_RULE_IDS.length} built-in rules`,
    },
    {
      label: "Findings produced",
      detail: `${item.findingCount} (${item.summary.critical}C · ${item.summary.high}H · ${item.summary.medium}M · ${item.summary.low}L)`,
      severity: status,
    },
    {
      label: "Risk score computed",
      detail: `${item.riskScore}/100`,
    },
    { label: "Scan completed" },
  ]

  return {
    id: item.id,
    agents: agentNames.length > 0 ? agentNames.join(", ") : "(no agents detected)",
    agentSet: new Set(agentNames.map((n) => n.toLowerCase())),
    timestamp: item.timestamp,
    startTime: formatScanTime(item.timestamp),
    branch: item.branch,
    status,
    toolCalls: ruleHits.size,
    findings: item.findingCount,
    headline:
      r.findings.length > 0
        ? `${item.findingCount} finding${item.findingCount === 1 ? "" : "s"} across ${ruleHits.size} rule${ruleHits.size === 1 ? "" : "s"}`
        : "No findings produced",
    events,
  }
}

interface RunTracesProps {
  /** Pre-filtered to the currently selected project by the parent. */
  scanHistory?: ScanHistoryItem[]
  hasProject?: boolean
  /** Top-bar agent picker. `["all"]` means no filter; otherwise we keep
   * scans that detected at least one of the selected agents. */
  selectedAgents?: string[]
}

export function RunTraces({
  scanHistory = [],
  hasProject = false,
  selectedAgents = ["all"],
}: RunTracesProps) {
  // "Live Trace" used to imply a real-time agent monitor. We don't have
  // that, so this is now a UI-only auto-refresh of the timestamp pulse —
  // it triggers a re-render every 5s so freshly saved scans appear without
  // a manual reload. Kept on by default to match the previous UX shape.
  const [isLive, setIsLive] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!isLive) return
    const t = setInterval(() => setTick((n) => n + 1), 5_000)
    return () => clearInterval(t)
  }, [isLive])

  // newest-first; the parent already scopes to the selected project.
  const traces = useMemo<TraceRow[]>(() => {
    return [...scanHistory]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map(traceFromScan)
  }, [scanHistory])

  const agentFilterActive =
    selectedAgents.length > 0 && !selectedAgents.includes("all")
  const lcSelected = selectedAgents.map((s) => s.toLowerCase())

  const filteredTraces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return traces.filter((t) => {
      if (
        agentFilterActive &&
        !lcSelected.some((s) => t.agentSet.has(s))
      ) {
        return false
      }
      if (q.length === 0) return true
      return (
        t.id.toLowerCase().includes(q) ||
        t.agents.toLowerCase().includes(q) ||
        t.headline.toLowerCase().includes(q) ||
        t.branch.toLowerCase().includes(q)
      )
    })
  }, [traces, searchQuery, agentFilterActive, lcSelected])

  const successCount = traces.filter((t) => t.status === "success").length
  const errorCount = traces.filter((t) => t.status === "error").length
  // We don't measure scan duration today (no t0 captured by the engine).
  // The fourth tile shows the latest scan's risk score instead — still
  // useful at-a-glance and never fabricated.
  const latestRisk = traces[0]?.id
    ? scanHistory.find((s) => s.id === traces[0].id)?.riskScore ?? null
    : null

  if (!hasProject) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Run Traces</h1>
          <p className="text-muted-foreground">Scan-pipeline history for the selected project</p>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a project and run a scan to view traces.
          </CardContent>
        </Card>
      </div>
    )
  }

  if (traces.length === 0) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Run Traces</h1>
          <p className="text-muted-foreground">Scan-pipeline history for the selected project</p>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No traces yet. Run a scan from the Scan Center to populate the timeline.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Run Traces</h1>
          <p className="text-muted-foreground">
            Scan-pipeline history · derived from real scan reports
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isLive ? "default" : "outline"}
            size="sm"
            onClick={() => setIsLive(!isLive)}
            className="gap-2"
            title={
              isLive
                ? "Pause UI auto-refresh (no live runtime monitor wired)"
                : "Resume UI auto-refresh"
            }
          >
            {isLive ? (
              <>
                <Pause className="h-4 w-4" />
                Pause Updates
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Live Trace
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by agent, branch, or scan id…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-secondary/50"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2" disabled title="More filters coming soon">
          <Filter className="h-4 w-4" />
          Filter
        </Button>
        {agentFilterActive && (
          <span className="text-xs text-muted-foreground">
            Filtering by agent: {selectedAgents.join(", ")}
          </span>
        )}
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-accent" />
              <div>
                <div className="text-2xl font-bold">{traces.length}</div>
                <div className="text-sm text-muted-foreground">Total Scans</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{successCount}</div>
                <div className="text-sm text-muted-foreground">Clean</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-2xl font-bold">{errorCount}</div>
                <div className="text-sm text-muted-foreground">Critical</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-bold">
                  {latestRisk !== null ? `${latestRisk}` : "—"}
                </div>
                <div className="text-sm text-muted-foreground">Latest Risk</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {isLive && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Live · UI auto-refresh only (no runtime agent monitor yet)
        </div>
      )}

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Recent Scan Traces</CardTitle>
          <CardDescription>Click a trace to expand the pipeline timeline</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {filteredTraces.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {agentFilterActive
                  ? `No traces match the selected agent${selectedAgents.length === 1 ? "" : "s"}.`
                  : "No traces match your search."}
              </div>
            ) : (
              filteredTraces.map((trace) => {
                const open = expanded === trace.id
                return (
                  <div key={trace.id}>
                    {/* Row is a single interactive container (div + role)
                     * so we can show a Button-styled chevron *inside* the
                     * row without nesting <button> in <button>, which
                     * triggers a hydration error. */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpanded(open ? null : trace.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          setExpanded(open ? null : trace.id)
                        }
                      }}
                      aria-expanded={open}
                      aria-label={open ? "Collapse trace" : "Expand trace"}
                      className="w-full text-left p-4 hover:bg-secondary/30 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4 min-w-0">
                          {getStatusIcon(trace.status)}
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate max-w-[260px]" title={trace.agents}>
                                {trace.agents}
                              </span>
                              <span className="text-xs text-muted-foreground font-mono">
                                {trace.id.slice(0, 8)}
                              </span>
                              <Badge
                                variant="outline"
                                className="text-[10px] border-border/60"
                              >
                                {trace.branch || "—"}
                              </Badge>
                            </div>
                            <div className="text-sm text-muted-foreground truncate max-w-md">
                              {trace.headline}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-6 shrink-0">
                          <div className="text-right text-sm">
                            <div className="text-muted-foreground">{trace.startTime}</div>
                          </div>
                          <div className="text-right text-sm">
                            <div>
                              {trace.toolCalls} rule{trace.toolCalls === 1 ? "" : "s"}
                            </div>
                            <div className="text-muted-foreground">
                              {trace.findings} finding{trace.findings === 1 ? "" : "s"}
                            </div>
                          </div>
                          {getStatusBadge(trace.status)}
                          <span
                            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground"
                            aria-hidden="true"
                          >
                            {open ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                    {open && (
                      <div className="px-12 pb-4 space-y-1.5 border-t border-border/40 bg-secondary/10">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground pt-3 pb-1">
                          Pipeline timeline
                        </div>
                        <ol className="text-sm space-y-1">
                          {trace.events.map((ev, idx) => (
                            <li
                              key={idx}
                              className="flex items-start gap-3 font-mono text-xs"
                            >
                              <span className="text-muted-foreground/70 w-6 shrink-0">
                                {String(idx + 1).padStart(2, "0")}
                              </span>
                              <span
                                className={
                                  ev.severity === "error"
                                    ? "text-red-400"
                                    : ev.severity === "warning"
                                    ? "text-orange-400"
                                    : "text-foreground/90"
                                }
                              >
                                {ev.label}
                              </span>
                              {ev.detail && (
                                <span className="text-muted-foreground truncate">
                                  · {ev.detail}
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
