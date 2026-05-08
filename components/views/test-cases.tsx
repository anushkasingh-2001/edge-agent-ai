"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { 
  Plus, 
  Play, 
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  FileCode
} from "lucide-react"

const testCases = [
  { id: 1, name: "Refund request handling", agent: "SupportAgent", status: "passed", lastRun: "2 hours ago", duration: "1.2s" },
  { id: 2, name: "Prompt injection resistance", agent: "ChatAgent", status: "failed", lastRun: "2 hours ago", duration: "0.8s" },
  { id: 3, name: "Tool selection accuracy", agent: "DataAgent", status: "passed", lastRun: "2 hours ago", duration: "2.1s" },
  { id: 4, name: "Auth check enforcement", agent: "AdminAgent", status: "passed", lastRun: "Yesterday", duration: "0.5s" },
  { id: 5, name: "Response format compliance", agent: "ChatAgent", status: "passed", lastRun: "Yesterday", duration: "1.4s" },
  { id: 6, name: "Error handling gracefully", agent: "SupportAgent", status: "failed", lastRun: "Yesterday", duration: "0.9s" },
  { id: 7, name: "Rate limit enforcement", agent: "APIAgent", status: "passed", lastRun: "3 days ago", duration: "0.3s" },
  { id: 8, name: "Data sanitization", agent: "DataAgent", status: "passed", lastRun: "3 days ago", duration: "1.1s" },
]

export function TestCases() {
  const [searchQuery, setSearchQuery] = useState("")

  const filteredTests = testCases.filter(t => 
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.agent.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const passedCount = testCases.filter(t => t.status === "passed").length
  const failedCount = testCases.filter(t => t.status === "failed").length

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Test Cases</h1>
          <p className="text-muted-foreground">Manage and run tests for your AI agents</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add Test
          </Button>
          <Button>
            <Play className="h-4 w-4 mr-2" />
            Run All
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Total Tests</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{testCases.length}</div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Passing</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-400" />
              <span className="text-3xl font-bold text-green-400">{passedCount}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Failing</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-400" />
              <span className="text-3xl font-bold text-red-400">{failedCount}</span>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription>Pass Rate</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{Math.round((passedCount / testCases.length) * 100)}%</div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card className="bg-card border-border">
        <CardContent className="pt-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search tests..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-secondary/50"
            />
          </div>
        </CardContent>
      </Card>

      {/* Tests Table */}
      <Card className="bg-card border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="w-12">Status</TableHead>
              <TableHead>Test Name</TableHead>
              <TableHead className="w-32">Agent</TableHead>
              <TableHead className="w-32">Duration</TableHead>
              <TableHead className="w-32">Last Run</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTests.map((test) => (
              <TableRow key={test.id} className="border-border hover:bg-secondary/30">
                <TableCell>
                  {test.status === "passed" ? (
                    <CheckCircle2 className="h-5 w-5 text-green-400" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-400" />
                  )}
                </TableCell>
                <TableCell className="font-medium">{test.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="bg-secondary/50">{test.agent}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {test.duration}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{test.lastRun}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm">
                    <Play className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
