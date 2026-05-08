"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { 
  GitBranch, 
  ArrowRight,
  AlertTriangle,
  FileCode,
  TrendingDown,
  TrendingUp,
  Minus,
  Plus,
  ChevronRight
} from "lucide-react"

const branches = [
  "main",
  "feature/auth-update",
  "feature/new-tools",
  "fix/prompt-injection",
  "dev",
]

const changes = [
  {
    type: "prompt",
    file: "prompts/system.txt",
    description: "Updated system prompt to be more specific",
    impact: "positive",
    detail: "Added explicit boundaries and response format guidelines",
  },
  {
    type: "tool",
    file: "tools/refund.py",
    description: "Added approval gate for high-value refunds",
    impact: "positive",
    detail: "Now requires human approval for refunds over $100",
  },
  {
    type: "schema",
    file: "api/openapi.yaml",
    description: "Updated API schema with new endpoints",
    impact: "neutral",
    detail: "Added /admin/audit endpoint with proper authentication",
  },
  {
    type: "mcp",
    file: "mcp/config.json",
    description: "Restricted filesystem capabilities",
    impact: "positive",
    detail: "Changed allowedPaths from '*' to specific directories",
  },
  {
    type: "prompt",
    file: "prompts/error_handler.txt",
    description: "Removed explicit error details from responses",
    impact: "negative",
    detail: "May cause issues with debugging - needs review",
  },
]

const evalScores = [
  { metric: "Accuracy", base: 87, target: 92, change: +5 },
  { metric: "Safety Score", base: 65, target: 82, change: +17 },
  { metric: "Response Time", base: 1.8, target: 1.6, change: -0.2, unit: "s", lowerBetter: true },
  { metric: "Tool Selection", base: 78, target: 85, change: +7 },
  { metric: "Prompt Injection Resistance", base: 45, target: 89, change: +44 },
]

interface BranchCompareProps {
  currentBranch?: string
}

export function BranchCompare({ currentBranch = "main" }: BranchCompareProps) {
  const [baseBranch, setBaseBranch] = useState(currentBranch)
  const [targetBranch, setTargetBranch] = useState("feature/auth-update")

  const impactBadge = (impact: string) => {
    switch (impact) {
      case "positive":
        return <Badge variant="outline" className="bg-green-500/10 text-green-400 border-green-500/20">Improvement</Badge>
      case "negative":
        return <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20">Regression</Badge>
      default:
        return <Badge variant="outline" className="bg-secondary text-muted-foreground">Neutral</Badge>
    }
  }

  const typeBadge = (type: string) => {
    switch (type) {
      case "prompt":
        return <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/20">Prompt</Badge>
      case "tool":
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20">Tool</Badge>
      case "schema":
        return <Badge variant="outline" className="bg-cyan-500/10 text-cyan-400 border-cyan-500/20">Schema</Badge>
      case "mcp":
        return <Badge variant="outline" className="bg-orange-500/10 text-orange-400 border-orange-500/20">MCP</Badge>
      default:
        return <Badge variant="outline">Other</Badge>
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Branch Compare</h1>
          <p className="text-muted-foreground">Compare changes between branches and their impact</p>
        </div>
        <Button>
          Run Comparison
        </Button>
      </div>

      {/* Branch Selection */}
      <Card className="bg-card border-border">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-sm text-muted-foreground mb-2 block">Base Branch</label>
              <Select value={baseBranch} onValueChange={setBaseBranch}>
                <SelectTrigger className="bg-secondary/50">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground mt-6" />
            <div className="flex-1">
              <label className="text-sm text-muted-foreground mb-2 block">Target Branch</label>
              <Select value={targetBranch} onValueChange={setTargetBranch}>
                <SelectTrigger className="bg-secondary/50">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-6">
        {/* Changes */}
        <div className="col-span-2">
          <Card className="bg-card border-border">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Changes Detected</CardTitle>
                <Badge variant="outline">{changes.length} changes</Badge>
              </div>
              <CardDescription>Modified prompts, tools, schemas, and MCP configurations</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {changes.map((change, i) => (
                  <div 
                    key={i} 
                    className="p-4 rounded-lg bg-secondary/20 border border-border hover:bg-secondary/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          {typeBadge(change.type)}
                          <span className="font-mono text-sm text-muted-foreground">{change.file}</span>
                        </div>
                        <p className="text-sm font-medium">{change.description}</p>
                        <p className="text-sm text-muted-foreground mt-1">{change.detail}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {impactBadge(change.impact)}
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Eval Scores */}
        <div className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Evaluation Scores</CardTitle>
              <CardDescription>Impact on agent performance metrics</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {evalScores.map((score) => {
                  const isImprovement = score.lowerBetter ? score.change < 0 : score.change > 0
                  const isRegression = score.lowerBetter ? score.change > 0 : score.change < 0
                  
                  return (
                    <div key={score.metric} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{score.metric}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{score.base}{score.unit || "%"}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">{score.target}{score.unit || "%"}</span>
                          {isImprovement && (
                            <span className="flex items-center text-green-400 text-xs">
                              <TrendingUp className="h-3 w-3 mr-0.5" />
                              +{Math.abs(score.change)}{score.unit || ""}
                            </span>
                          )}
                          {isRegression && (
                            <span className="flex items-center text-red-400 text-xs">
                              <TrendingDown className="h-3 w-3 mr-0.5" />
                              {score.change}{score.unit || ""}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div 
                          className={`h-full ${isImprovement ? "bg-green-500" : isRegression ? "bg-red-500" : "bg-muted-foreground"}`}
                          style={{ width: `${score.target}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Likely Cause */}
          <Card className="bg-card border-border border-yellow-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-400" />
                Likely Cause of Regression
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  The change to <code className="text-yellow-400">prompts/error_handler.txt</code> removed 
                  explicit error details, which may cause debugging issues.
                </p>
                <Button variant="outline" size="sm" className="w-full mt-2">
                  View Change Details
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Summary */}
          <Card className="bg-card border-border">
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-green-400 flex items-center justify-center gap-1">
                    <Plus className="h-5 w-5" />4
                  </div>
                  <div className="text-xs text-muted-foreground">Improvements</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-400 flex items-center justify-center gap-1">
                    <Minus className="h-5 w-5" />1
                  </div>
                  <div className="text-xs text-muted-foreground">Regressions</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
