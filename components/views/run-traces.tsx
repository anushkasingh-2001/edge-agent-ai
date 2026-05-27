"use client"

import { useState } from "react"
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
  Pause
} from "lucide-react"

const traces = [
  {
    id: "trace-001",
    agent: "SupportAgent",
    startTime: "2024-01-15 10:32:15",
    duration: "2.3s",
    status: "success",
    toolCalls: 3,
    tokens: 1250,
    input: "How do I reset my password?",
  },
  {
    id: "trace-002",
    agent: "DataAgent",
    startTime: "2024-01-15 10:31:45",
    duration: "5.1s",
    status: "warning",
    toolCalls: 8,
    tokens: 3420,
    input: "Analyze sales data for Q4",
  },
  {
    id: "trace-003",
    agent: "AdminAgent",
    startTime: "2024-01-15 10:30:22",
    duration: "1.8s",
    status: "error",
    toolCalls: 2,
    tokens: 890,
    input: "Delete all inactive users",
  },
  {
    id: "trace-004",
    agent: "ChatAgent",
    startTime: "2024-01-15 10:29:58",
    duration: "0.9s",
    status: "success",
    toolCalls: 1,
    tokens: 320,
    input: "What is the weather today?",
  },
  {
    id: "trace-005",
    agent: "APIAgent",
    startTime: "2024-01-15 10:28:33",
    duration: "3.2s",
    status: "success",
    toolCalls: 4,
    tokens: 1890,
    input: "Fetch latest stock prices",
  },
]

function getStatusIcon(status: string) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-orange-500" />
    case "error":
      return <XCircle className="h-4 w-4 text-red-500" />
    default:
      return null
  }
}

function getStatusBadge(status: string) {
  switch (status) {
    case "success":
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Success</Badge>
    case "warning":
      return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Warning</Badge>
    case "error":
      return <Badge variant="destructive">Error</Badge>
    default:
      return null
  }
}

/**
 * Run-traces view. Some call sites (app/page.tsx) pass scan history /
 * project context as props so the view can later filter against them.
 * The fields are accepted (and currently unused) here so the prop
 * surface is declared — without them TS rejects the call site under
 * strict mode.
 */
type ScanHistoryItem = import("@/lib/scan-history").ScanHistoryItem
interface RunTracesProps {
  scanHistory?: ScanHistoryItem[]
  hasProject?: boolean
  selectedAgents?: string[]
}

export function RunTraces(_props: RunTracesProps = {}) {
  const [isLive, setIsLive] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Run Traces</h1>
          <p className="text-muted-foreground">Monitor agent execution history and performance</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isLive ? "default" : "outline"}
            size="sm"
            onClick={() => setIsLive(!isLive)}
            className="gap-2"
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

      {/* Search and Filter */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search traces..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-secondary/50"
          />
        </div>
        <Button variant="outline" size="sm" className="gap-2">
          <Filter className="h-4 w-4" />
          Filter
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-accent" />
              <div>
                <div className="text-2xl font-bold">{traces.length}</div>
                <div className="text-sm text-muted-foreground">Total Traces</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{traces.filter(t => t.status === "success").length}</div>
                <div className="text-sm text-muted-foreground">Successful</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <div className="text-2xl font-bold">{traces.filter(t => t.status === "error").length}</div>
                <div className="text-sm text-muted-foreground">Errors</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-2xl font-bold">2.6s</div>
                <div className="text-sm text-muted-foreground">Avg Duration</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live Indicator */}
      {isLive && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Live - Auto-refreshing traces
        </div>
      )}

      {/* Traces List */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Recent Traces</CardTitle>
          <CardDescription>Click on a trace to view detailed execution steps</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {traces.map((trace) => (
              <div
                key={trace.id}
                className="p-4 hover:bg-secondary/30 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {getStatusIcon(trace.status)}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{trace.agent}</span>
                        <span className="text-xs text-muted-foreground font-mono">{trace.id}</span>
                      </div>
                      <div className="text-sm text-muted-foreground truncate max-w-md">
                        {trace.input}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right text-sm">
                      <div className="text-muted-foreground">{trace.startTime}</div>
                      <div className="flex items-center gap-2 justify-end">
                        <Clock className="h-3 w-3" />
                        {trace.duration}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <div>{trace.toolCalls} tools</div>
                      <div className="text-muted-foreground">{trace.tokens} tokens</div>
                    </div>
                    {getStatusBadge(trace.status)}
                    <Button variant="ghost" size="sm">
                      <Eye className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
