"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { 
  Play, 
  Square, 
  Sparkles, 
  Upload,
  Clock,
  CheckCircle2,
  Loader2,
  FileText,
  TestTube
} from "lucide-react"

const securityChecks = [
  { id: "dangerous-tools", label: "Dangerous tools", description: "Identify risky tool invocations" },
  { id: "human-approval", label: "Missing human approval", description: "Flag actions requiring human review" },
  { id: "prompt-injection", label: "Prompt injection", description: "Detect injection vulnerabilities" },
  { id: "vague-prompts", label: "Vague prompts", description: "Find prompts that lack specificity" },
  { id: "mcp-security", label: "MCP security", description: "Audit Model Context Protocol security" },
  { id: "openapi-quality", label: "OpenAPI/schema quality", description: "Validate API schemas and specs" },
  { id: "auth-checks", label: "Auth checks", description: "Verify authentication is properly enforced" },
  { id: "secrets", label: "Hardcoded secrets", description: "Find exposed credentials and keys" },
  { id: "dependencies", label: "Dependency risks", description: "Check for vulnerable dependencies" },
  { id: "user-input", label: "User input to dangerous code", description: "Trace unsafe data flows" },
  { id: "accuracy", label: "Accuracy regression", description: "Detect changes that may affect output quality" },
  { id: "performance", label: "Performance/runtime", description: "Monitor latency and resource usage" },
  { id: "tool-selection", label: "Tool selection correctness", description: "Verify correct tool routing" },
  { id: "smoke-tests", label: "Live smoke tests", description: "Run live validation tests" },
]

const recentScans = [
  { id: 1, status: "completed", checks: 14, issues: 12, duration: "2m 34s", time: "2 hours ago" },
  { id: 2, status: "completed", checks: 14, issues: 3, duration: "2m 12s", time: "Yesterday" },
  { id: 3, status: "completed", checks: 8, issues: 0, duration: "1m 45s", time: "3 days ago" },
]

interface ScanCenterProps {
  selectedAgents?: string[]
}

export function ScanCenter({ selectedAgents = ["all"] }: ScanCenterProps) {
  const [selectedChecks, setSelectedChecks] = useState<string[]>(securityChecks.map(c => c.id))
  const [allSelected, setAllSelected] = useState(true)
  const [isScanning, setIsScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)

  const handleAllChange = (checked: boolean) => {
    setAllSelected(checked)
    if (checked) {
      setSelectedChecks(securityChecks.map(c => c.id))
    } else {
      setSelectedChecks([])
    }
  }

  const handleCheckChange = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedChecks([...selectedChecks, id])
    } else {
      setSelectedChecks(selectedChecks.filter(c => c !== id))
      setAllSelected(false)
    }
  }

  const startScan = () => {
    setIsScanning(true)
    setScanProgress(0)
    const interval = setInterval(() => {
      setScanProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsScanning(false)
          return 100
        }
        return prev + 10
      })
    }, 500)
  }

  const stopScan = () => {
    setIsScanning(false)
    setScanProgress(0)
  }

  const agentLabel = selectedAgents.includes("all") 
    ? "All Agents" 
    : selectedAgents.length === 1 
      ? selectedAgents[0] 
      : `${selectedAgents.length} agents`

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scan Center</h1>
          <p className="text-muted-foreground">
            Configure and run security scans on {agentLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">
            <Upload className="h-4 w-4 mr-2" />
            Import user tests
          </Button>
          <Button variant="outline">
            <Sparkles className="h-4 w-4 mr-2" />
            Generate Tests
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Scan Configuration */}
        <div className="col-span-2 space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Security Checks</CardTitle>
              <CardDescription>Select which checks to include in the scan</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* All checks toggle */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 border border-border">
                <Checkbox 
                  id="all" 
                  checked={allSelected}
                  onCheckedChange={handleAllChange}
                />
                <div className="flex-1">
                  <label htmlFor="all" className="text-sm font-medium cursor-pointer">All checks</label>
                  <p className="text-xs text-muted-foreground">Run all available security and quality checks</p>
                </div>
                <Badge variant="outline" className="text-xs">
                  {selectedChecks.length}/{securityChecks.length}
                </Badge>
              </div>

              {/* Individual checks */}
              <div className="grid grid-cols-2 gap-2">
                {securityChecks.map((check) => (
                  <div key={check.id} className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/30 transition-colors">
                    <Checkbox 
                      id={check.id} 
                      checked={selectedChecks.includes(check.id)}
                      onCheckedChange={(checked) => handleCheckChange(check.id, checked as boolean)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <label htmlFor={check.id} className="text-sm font-medium cursor-pointer">{check.label}</label>
                      <p className="text-xs text-muted-foreground truncate">{check.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Scan Progress */}
          {isScanning && (
            <Card className="bg-card border-border border-accent/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    Scanning...
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">{scanProgress}%</span>
                </div>
              </CardHeader>
              <CardContent>
                <Progress value={scanProgress} className="h-2" />
                <p className="text-sm text-muted-foreground mt-2">
                  Running {selectedChecks.length} checks on {agentLabel}...
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Action Buttons */}
          <Card className="bg-card border-border">
            <CardContent className="pt-6 space-y-3">
              {!isScanning ? (
                <>
                  <Button 
                    className="w-full" 
                    onClick={startScan}
                    disabled={selectedChecks.length === 0}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Run Full Scan
                  </Button>
                  <Button 
                    variant="outline"
                    className="w-full" 
                    onClick={startScan}
                    disabled={selectedChecks.length === 0}
                  >
                    <TestTube className="h-4 w-4 mr-2" />
                    Run Selected Checks
                  </Button>
                </>
              ) : (
                <Button 
                  className="w-full" 
                  variant="destructive"
                  onClick={stopScan}
                >
                  <Square className="h-4 w-4 mr-2" />
                  Stop
                </Button>
              )}
              <Button variant="outline" className="w-full">
                <FileText className="h-4 w-4 mr-2" />
                Export Report
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {selectedChecks.length} checks selected
              </p>
            </CardContent>
          </Card>

          {/* Recent Scans */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent Scans</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {recentScans.map((scan) => (
                  <div key={scan.id} className="p-3 rounded-lg bg-secondary/30 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                        <span className="text-sm font-medium">{scan.checks} checks</span>
                      </div>
                      {scan.issues > 0 ? (
                        <Badge variant="outline" className="text-xs border-orange-500/50 text-orange-400">
                          {scan.issues} issues
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs border-green-500/50 text-green-400">
                          Clean
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {scan.duration}
                      </span>
                      <span>{scan.time}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
