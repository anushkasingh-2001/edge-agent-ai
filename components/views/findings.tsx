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
  Filter, 
  Download,
  AlertTriangle,
  Shield,
  ChevronRight
} from "lucide-react"
import { FindingDrawer } from "@/components/finding-drawer"

export interface Finding {
  id: number
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
  agent: string
  reason: string
  suggestedFix: string
  evidence: string
  code: string
}

const findings: Finding[] = [
  {
    id: 1,
    severity: "critical",
    category: "Prompt Injection",
    title: "Unsanitized user input in system prompt",
    file: "agents/chat.py",
    line: 142,
    agent: "ChatAgent",
    reason: "User input is directly concatenated into the system prompt without sanitization, allowing potential prompt injection attacks.",
    suggestedFix: "Use a template with proper escaping or move user input to the user message section.",
    evidence: "User input from `request.body.message` flows directly into `system_prompt`",
    code: `system_prompt = f"""You are a helpful assistant.
User context: {user_input}  # UNSAFE: Direct injection
Please help the user with their request."""`
  },
  {
    id: 2,
    severity: "critical",
    category: "Dangerous Tool Call",
    title: "Unrestricted database query execution",
    file: "tools/database.py",
    line: 56,
    agent: "DataAgent",
    reason: "The agent can execute arbitrary SQL queries without validation, potentially allowing data exfiltration or modification.",
    suggestedFix: "Implement query allowlisting and parameterized queries only.",
    evidence: "Tool `execute_query` accepts raw SQL from agent output",
    code: `def execute_query(query: str):
    # WARNING: No validation on query
    return db.execute(query)`
  },
  {
    id: 3,
    severity: "high",
    category: "Missing Human Approval",
    title: "Refund tool lacks approval gate",
    file: "tools/refund.py",
    line: 89,
    agent: "SupportAgent",
    reason: "The refund tool can process refunds over $100 without requiring human approval, creating financial risk.",
    suggestedFix: "Add a human-in-the-loop check for refunds exceeding the threshold.",
    evidence: "No approval check before `process_refund()` call",
    code: `@tool
def process_refund(amount: float, order_id: str):
    # Missing: human approval for high-value refunds
    return payment_gateway.refund(order_id, amount)`
  },
  {
    id: 4,
    severity: "high",
    category: "Hardcoded Secrets",
    title: "API key exposed in configuration",
    file: "config/settings.py",
    line: 23,
    agent: "—",
    reason: "An OpenAI API key is hardcoded in the configuration file, which could be exposed in version control.",
    suggestedFix: "Move the API key to environment variables or a secrets manager.",
    evidence: "Literal string matching API key pattern detected",
    code: `OPENAI_API_KEY = "sk-proj-abc123..."  # EXPOSED`
  },
  {
    id: 5,
    severity: "high",
    category: "Auth Check",
    title: "Missing authentication on admin endpoint",
    file: "api/admin.py",
    line: 12,
    agent: "AdminAgent",
    reason: "The admin configuration endpoint lacks authentication, allowing unauthorized access to sensitive settings.",
    suggestedFix: "Add authentication middleware to the admin routes.",
    evidence: "No `@require_auth` decorator on `/admin/config` route",
    code: `@app.route("/admin/config")
def get_config():  # Missing auth decorator
    return jsonify(app.config)`
  },
  {
    id: 6,
    severity: "medium",
    category: "Vague Prompt",
    title: "System prompt lacks specificity",
    file: "prompts/system.txt",
    line: 1,
    agent: "ChatAgent",
    reason: "The system prompt is too vague and may lead to inconsistent agent behavior or unintended responses.",
    suggestedFix: "Add specific instructions about allowed topics, response format, and boundaries.",
    evidence: "Prompt analysis shows low specificity score (0.3/1.0)",
    code: `You are a helpful assistant. Help users with their questions.`
  },
  {
    id: 7,
    severity: "medium",
    category: "Performance",
    title: "Redundant API calls in tool chain",
    file: "agents/research.py",
    line: 78,
    agent: "ResearchAgent",
    reason: "The agent makes duplicate API calls for the same data within a single session, increasing latency and costs.",
    suggestedFix: "Implement caching for repeated data lookups.",
    evidence: "3 identical calls to `fetch_user_data()` in single trace",
    code: `user = fetch_user_data(user_id)  # Called 3x`
  },
  {
    id: 8,
    severity: "medium",
    category: "MCP Security",
    title: "MCP server allows unrestricted file access",
    file: "mcp/config.json",
    line: 15,
    agent: "FileAgent",
    reason: "The MCP configuration grants file system access without path restrictions, enabling access to sensitive files.",
    suggestedFix: "Add allowlist for permitted directories in MCP configuration.",
    evidence: "MCP `filesystem` capability has no `allowedPaths` restriction",
    code: `"capabilities": {
  "filesystem": { "allowedPaths": ["*"] }  // Too permissive
}`
  },
  {
    id: 9,
    severity: "low",
    category: "Schema Quality",
    title: "OpenAPI spec missing descriptions",
    file: "api/openapi.yaml",
    line: 45,
    agent: "—",
    reason: "Several API endpoints lack descriptions, making it harder for the agent to select the correct tool.",
    suggestedFix: "Add descriptions to all endpoints in the OpenAPI specification.",
    evidence: "5 endpoints missing `description` field",
    code: `paths:
  /users/{id}:
    get:
      # Missing: description`
  },
]

export function Findings() {
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [severityFilter, setSeverityFilter] = useState<string>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")

  const categories = [...new Set(findings.map(f => f.category))]

  const filteredFindings = findings.filter(f => {
    const matchesSearch = f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         f.file.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = severityFilter === "all" || f.severity === severityFilter
    const matchesCategory = categoryFilter === "all" || f.category === categoryFilter
    return matchesSearch && matchesSeverity && matchesCategory
  })

  const criticalCount = findings.filter(f => f.severity === "critical").length
  const highCount = findings.filter(f => f.severity === "high").length
  const mediumCount = findings.filter(f => f.severity === "medium").length
  const lowCount = findings.filter(f => f.severity === "low").length

  const handleFindingClick = (finding: Finding) => {
    setSelectedFinding(finding)
    setDrawerOpen(true)
  }

  const severityBadgeClass = (severity: string) => {
    switch (severity) {
      case "critical": return "bg-red-500/10 text-red-400 border-red-500/20"
      case "high": return "bg-orange-500/10 text-orange-400 border-orange-500/20"
      case "medium": return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
      case "low": return "bg-blue-500/10 text-blue-400 border-blue-500/20"
      default: return ""
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
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

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Risk Score
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-400">67</div>
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

      {/* Filters */}
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
                {categories.map(cat => (
                  <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="text-sm text-muted-foreground">
              {filteredFindings.length} findings
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Findings Table */}
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
                key={finding.id} 
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

      {/* Finding Detail Drawer */}
      <FindingDrawer 
        finding={selectedFinding} 
        open={drawerOpen} 
        onOpenChange={setDrawerOpen}
      />
    </div>
  )
}
