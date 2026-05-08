"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { 
  Play, 
  Pause,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Wrench,
  Brain,
  Clock,
  Zap
} from "lucide-react"

interface TraceEvent {
  id: number
  type: "input" | "thinking" | "tool_call" | "tool_result" | "output"
  content: string
  timestamp: string
  duration?: string
  expanded?: boolean
  children?: TraceEvent[]
}

const traceEvents: TraceEvent[] = [
  {
    id: 1,
    type: "input",
    content: "User: I need a refund for my order #12345",
    timestamp: "14:32:01.234",
  },
  {
    id: 2,
    type: "thinking",
    content: "Analyzing user intent: refund request for order #12345. Need to look up order details and verify eligibility.",
    timestamp: "14:32:01.456",
    duration: "0.2s",
  },
  {
    id: 3,
    type: "tool_call",
    content: "get_order_details(order_id=\"12345\")",
    timestamp: "14:32:01.678",
    duration: "0.4s",
    children: [
      {
        id: 31,
        type: "tool_result",
        content: '{"order_id": "12345", "status": "delivered", "amount": 89.99, "date": "2024-01-15"}',
        timestamp: "14:32:02.078",
      }
    ]
  },
  {
    id: 4,
    type: "thinking",
    content: "Order found. Amount is $89.99, delivered on Jan 15. Within 30-day refund window. Eligible for refund.",
    timestamp: "14:32:02.123",
    duration: "0.1s",
  },
  {
    id: 5,
    type: "tool_call",
    content: "process_refund(order_id=\"12345\", amount=89.99)",
    timestamp: "14:32:02.234",
    duration: "0.6s",
    children: [
      {
        id: 51,
        type: "tool_result",
        content: '{"success": true, "refund_id": "REF-789", "message": "Refund processed"}',
        timestamp: "14:32:02.834",
      }
    ]
  },
  {
    id: 6,
    type: "output",
    content: "I've processed a full refund of $89.99 for order #12345. Your refund (ID: REF-789) should appear in your account within 3-5 business days.",
    timestamp: "14:32:02.945",
    duration: "0.1s",
  },
]

export function RuntimeTrace() {
  const [selectedTrace, setSelectedTrace] = useState("latest")
  const [isLive, setIsLive] = useState(false)
  const [expandedEvents, setExpandedEvents] = useState<number[]>([3, 5])

  const toggleExpanded = (id: number) => {
    setExpandedEvents(prev => 
      prev.includes(id) ? prev.filter(e => e !== id) : [...prev, id]
    )
  }

  const eventIcon = (type: string) => {
    switch (type) {
      case "input":
        return <MessageSquare className="h-4 w-4 text-blue-400" />
      case "thinking":
        return <Brain className="h-4 w-4 text-purple-400" />
      case "tool_call":
        return <Wrench className="h-4 w-4 text-orange-400" />
      case "tool_result":
        return <Zap className="h-4 w-4 text-yellow-400" />
      case "output":
        return <MessageSquare className="h-4 w-4 text-green-400" />
      default:
        return null
    }
  }

  const eventBadge = (type: string) => {
    switch (type) {
      case "input":
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">Input</Badge>
      case "thinking":
        return <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-xs">Thinking</Badge>
      case "tool_call":
        return <Badge variant="outline" className="bg-orange-500/10 text-orange-400 border-orange-500/20 text-xs">Tool Call</Badge>
      case "tool_result":
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-xs">Result</Badge>
      case "output":
        return <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/20 text-xs">Output</Badge>
      default:
        return null
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Runtime Trace</h1>
          <p className="text-muted-foreground">Inspect agent execution in real-time</p>
        </div>
        <div className="flex gap-2">
          <Select value={selectedTrace} onValueChange={setSelectedTrace}>
            <SelectTrigger className="w-48 bg-secondary/50">
              <SelectValue placeholder="Select trace" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest (2 min ago)</SelectItem>
              <SelectItem value="trace-2">Trace #2 (1 hour ago)</SelectItem>
              <SelectItem value="trace-3">Trace #3 (Yesterday)</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setIsLive(!isLive)}>
            {isLive ? (
              <>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Live
              </>
            )}
          </Button>
          <Button variant="outline">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Trace Timeline */}
        <div className="col-span-2">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Execution Timeline</CardTitle>
                {isLive && (
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30 animate-pulse">
                    Live
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] pr-4">
                <div className="space-y-2">
                  {traceEvents.map((event) => (
                    <div key={event.id}>
                      <div 
                        className={`flex items-start gap-3 p-3 rounded-lg transition-colors ${
                          event.children ? "cursor-pointer hover:bg-secondary/50" : "hover:bg-secondary/30"
                        } ${expandedEvents.includes(event.id) ? "bg-secondary/30" : ""}`}
                        onClick={() => event.children && toggleExpanded(event.id)}
                      >
                        <div className="flex items-center gap-2 shrink-0">
                          {event.children && (
                            expandedEvents.includes(event.id) ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )
                          )}
                          {!event.children && <div className="w-4" />}
                          {eventIcon(event.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {eventBadge(event.type)}
                            <span className="text-xs text-muted-foreground font-mono">{event.timestamp}</span>
                            {event.duration && (
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {event.duration}
                              </span>
                            )}
                          </div>
                          <p className={`text-sm ${event.type === "tool_call" ? "font-mono" : ""}`}>
                            {event.content}
                          </p>
                        </div>
                      </div>
                      {/* Nested children */}
                      {event.children && expandedEvents.includes(event.id) && (
                        <div className="ml-10 mt-1 space-y-1">
                          {event.children.map((child) => (
                            <div key={child.id} className="flex items-start gap-3 p-3 rounded-lg bg-secondary/20 border-l-2 border-yellow-500/30">
                              <div className="flex items-center gap-2 shrink-0">
                                <div className="w-4" />
                                {eventIcon(child.type)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  {eventBadge(child.type)}
                                  <span className="text-xs text-muted-foreground font-mono">{child.timestamp}</span>
                                </div>
                                <pre className="text-sm font-mono text-muted-foreground whitespace-pre-wrap">{child.content}</pre>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* Trace Info */}
        <div className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Trace Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-muted-foreground">Total Duration</div>
                  <div className="text-lg font-semibold">1.7s</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tool Calls</div>
                  <div className="text-lg font-semibold">2</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tokens Used</div>
                  <div className="text-lg font-semibold">847</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Cost</div>
                  <div className="text-lg font-semibold">$0.012</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Agent Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Agent</span>
                <Badge variant="outline">SupportAgent</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model</span>
                <span>GPT-4o</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Temperature</span>
                <span>0.7</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tools Available</span>
                <span>5</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border border-orange-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2 text-orange-400">
                <Wrench className="h-4 w-4" />
                Security Alert
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                <code className="text-orange-400">process_refund</code> was called without human approval 
                for amount $89.99. Consider adding approval gate.
              </p>
              <Button variant="outline" size="sm" className="w-full mt-3">
                View Finding
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
