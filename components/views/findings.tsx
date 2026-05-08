"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
  Download,
  Shield,
  ChevronRight,
} from "lucide-react"
import { FindingDrawer } from "@/components/finding-drawer"
import type { UiFinding } from "@/lib/scan-report"

export type Finding = UiFinding

interface FindingsProps {
  findings: Finding[]
  riskScore: number
}

export function Findings({ findings, riskScore }: FindingsProps) {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [severityFilter, setSeverityFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")

  const categories = [...new Set(findings.map((f) => f.category))]

  const filteredFindings = findings.filter((f) => {
    const matchesSearch =
      f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.file.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = severityFilter === "all" || f.severity === severityFilter
    const matchesCategory = categoryFilter === "all" || f.category === categoryFilter
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

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Findings</h1>
          <p className="text-muted-foreground">Security issues detected in your AI agents</p>
        </div>
        <Button variant="outline">
          <Download className="h-4 w-4 mr-2" />
          Export Report
        </Button>
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
              <SelectTrigger className="w-48 bg-secondary/50">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
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
                <TableCell className="text-muted-foreground">{finding.category}</TableCell>
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
