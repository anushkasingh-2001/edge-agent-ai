"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Search,
  Shield,
  ChevronRight,
} from "lucide-react"
import { FindingDrawer } from "@/components/finding-drawer"
import type { UiFinding } from "@/lib/scan-report"
import { SECURITY_CHECKS, displayCategoryLabel } from "@/lib/security-checks"

export type Finding = UiFinding

/**
 * Wrapper kept around because several call sites already use it. The
 * actual mapping logic moved to `lib/security-checks.ts` so Scan Center
 * and Findings now share one source of truth for the category vocabulary.
 */
function displayCategory(raw: string): string {
  return displayCategoryLabel(raw)
}

interface FindingsProps {
  findings: Finding[]
  riskScore: number
  hasProject?: boolean
  hasScan?: boolean
}

export function Findings({
  findings,
  riskScore,
  hasProject = false,
  hasScan = false,
}: FindingsProps) {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [severityFilter, setSeverityFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")

  // Dropdown shows the full Scan Center taxonomy (14 checks) so the
  // category vocabulary is identical across both screens. Any scanner
  // category that's NOT yet claimed by a SECURITY_CHECKS entry is appended
  // at the end so a new rule can't silently disappear from the UI.
  //
  // Counts are computed from the current `findings` array — a check with
  // 0 findings still appears, just dimmed and labelled `(0)` so the user
  // sees the full list and knows which buckets are empty in this scan.
  const findingCountByLabel = (() => {
    const m = new Map<string, number>()
    for (const f of findings) {
      const label = displayCategory(f.category)
      m.set(label, (m.get(label) ?? 0) + 1)
    }
    return m
  })()
  const knownLabels = SECURITY_CHECKS.map((c) => c.label)
  const knownLabelSet = new Set(knownLabels)
  const orphanLabels = [
    ...new Set(
      findings
        .map((f) => displayCategory(f.category))
        .filter((label) => !knownLabelSet.has(label))
    ),
  ].sort((a, b) => a.localeCompare(b))
  const categories: string[] = [...knownLabels, ...orphanLabels]

  const filteredFindings = findings.filter((f) => {
    const matchesSearch =
      f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.file.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = severityFilter === "all" || f.severity === severityFilter
    const matchesCategory =
      categoryFilter === "all" || displayCategory(f.category) === categoryFilter
    return matchesSearch && matchesSeverity && matchesCategory
  })

  const criticalCount = findings.filter((f) => f.severity === "critical").length
  const highCount = findings.filter((f) => f.severity === "high").length
  const mediumCount = findings.filter((f) => f.severity === "medium").length
  const lowCount = findings.filter((f) => f.severity === "low").length

  const handleFindingClick = (finding: Finding) => {
    setSelectedFinding(finding)
    setDrawerOpen(true)
  }

  const severityBadgeClass = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-500/10 text-red-400 border-red-500/20"
      case "high":
        return "bg-orange-500/10 text-orange-400 border-orange-500/20"
      case "medium":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
      case "low":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20"
      default:
        return ""
    }
  }

  const riskColor =
    riskScore >= 86 ? "text-red-400" : riskScore >= 61 ? "text-orange-400" : riskScore >= 31 ? "text-yellow-400" : "text-green-400"

  if (!hasProject || !hasScan) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Findings</h1>
            <p className="text-muted-foreground">Security issues detected in your AI agents</p>
          </div>
        </div>
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {hasProject
              ? "No scan results yet. Run a scan from the Scan Center."
              : "No project opened. Open a local project or clone from GitHub before running a scan."}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Findings</h1>
        <p className="text-muted-foreground">Security issues detected in your AI agents</p>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Risk Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${riskColor}`}>{riskScore}</div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Critical</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="text-3xl font-bold">{criticalCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>High</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-orange-500" />
              <span className="text-3xl font-bold">{highCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Medium</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-yellow-500" />
              <span className="text-3xl font-bold">{mediumCount}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Low</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <span className="text-3xl font-bold">{lowCount}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="pt-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search findings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-secondary/50"
              />
            </div>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="w-40 bg-secondary/50">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severities</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-64 bg-secondary/50">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent className="max-h-[420px]">
                <SelectItem value="all">
                  All Categories ({findings.length})
                </SelectItem>
                {categories.map((cat) => {
                  const count = findingCountByLabel.get(cat) ?? 0
                  // Dim empty buckets so the user can still see the full
                  // 14-check taxonomy without confusing zero-count rows
                  // with active ones.
                  return (
                    <SelectItem key={cat} value={cat}>
                      <span
                        className={
                          count === 0
                            ? "text-muted-foreground/70"
                            : undefined
                        }
                      >
                        {cat}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({count})
                        </span>
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            <div className="text-sm text-muted-foreground">{filteredFindings.length} findings</div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="w-24">Severity</TableHead>
              <TableHead className="w-40">Category</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-48">File</TableHead>
              <TableHead className="w-24">Line</TableHead>
              <TableHead className="w-32">Agent</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredFindings.map((finding) => (
              <TableRow
                key={finding.scannerFindingId ?? finding.id}
                className="cursor-pointer hover:bg-secondary/50 border-border"
                onClick={() => handleFindingClick(finding)}
              >
                <TableCell>
                  <Badge variant="outline" className={severityBadgeClass(finding.severity)}>
                    {finding.severity}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{displayCategory(finding.category)}</TableCell>
                <TableCell className="font-medium">{finding.title}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">{finding.file}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">{finding.line}</TableCell>
                <TableCell className="text-muted-foreground">{finding.agent}</TableCell>
                <TableCell>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <FindingDrawer finding={selectedFinding} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </div>
  )
}
