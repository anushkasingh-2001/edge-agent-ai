import { z } from "zod"

/** rule_id values produced by edge_agent_scanner (aligns with Scan Center checks that have a backend). */
export const SCANNER_RULE_IDS = [
  "dangerous-tools",
  "human-approval",
  "prompt-injection",
  "vague-prompts",
  "secrets",
  "mcp-security",
  "openapi-schema",
  "dependency-risks",
  "user-input-dangerous-code",
] as const

export type ScannerRuleId = (typeof SCANNER_RULE_IDS)[number]

const ScannerFindingSchema = z.object({
  id: z.string(),
  rule_id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  agent: z.string(),
  reason: z.string(),
  suggestedFix: z.string(),
  evidence: z.string(),
  code: z.string(),
  confidence: z.number(),
})

export const ScanReportSchema = z.object({
  schema_version: z.string(),
  scan_root: z.string(),
  generated_at: z.string(),
  frameworks_detected: z.array(
    z.object({
      name: z.string(),
      evidence: z.array(z.string()),
    })
  ),
  summary: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    total: z.number(),
  }),
  risk_score: z.number(),
  findings: z.array(ScannerFindingSchema),
})

export type ScanReport = z.infer<typeof ScanReportSchema>
export type ScannerFinding = z.infer<typeof ScannerFindingSchema>

export function parseScanReport(data: unknown): ScanReport {
  return ScanReportSchema.parse(data)
}

/** UI Finding shape used by Findings view / drawer (numeric id for table keys). */
export type UiFinding = {
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
  ruleId?: string
  scannerFindingId?: string
}

export function mapReportToUiFindings(report: ScanReport): UiFinding[] {
  return report.findings.map((f, i) => ({
    id: i + 1,
    severity: f.severity,
    category: f.category,
    title: f.title,
    file: f.file,
    line: f.line,
    agent: f.agent,
    reason: f.reason,
    suggestedFix: f.suggestedFix,
    evidence: f.evidence,
    code: f.code,
    ruleId: f.rule_id,
    scannerFindingId: f.id,
  }))
}

export function filterChecksForScanner(selectedCheckIds: string[]): string[] {
  const set = new Set<string>(SCANNER_RULE_IDS)
  return selectedCheckIds.filter((id) => set.has(id as ScannerRuleId))
}

/** When every scanner-backed check is selected, run a full scan (omit --check). Otherwise pass the subset. */
export function resolveChecksForApi(selectedCheckIds: string[]): string[] | undefined {
  if (selectedCheckIds.length === 0) return undefined
  const everyScanner = SCANNER_RULE_IDS.every((id) => selectedCheckIds.includes(id))
  if (everyScanner) return undefined
  const scannerHits = filterChecksForScanner(selectedCheckIds)
  if (scannerHits.length === 0) return undefined
  return scannerHits
}

export type TopBarAgentOption = {
  id: string
  name: string
  framework: string | null
  tools: number
  prompts: number
  risk: number
}

const FALLBACK_AGENTS: TopBarAgentOption[] = [
  { id: "support", name: "SupportAgent", framework: "LangGraph", tools: 8, prompts: 3, risk: 72 },
  { id: "chat", name: "ChatAgent", framework: "LangChain", tools: 5, prompts: 4, risk: 45 },
  { id: "data", name: "DataAgent", framework: "LlamaIndex", tools: 12, prompts: 2, risk: 38 },
  { id: "api", name: "APIAgent", framework: "AutoGen", tools: 6, prompts: 2, risk: 56 },
  { id: "admin", name: "AdminAgent", framework: "LangGraph", tools: 15, prompts: 5, risk: 89 },
]

export function buildTopBarAgentsFromReport(
  report: ScanReport | null,
  riskScore: number
): TopBarAgentOption[] {
  const all: TopBarAgentOption = {
    id: "all",
    name: "All Agents",
    framework: null,
    tools: 0,
    prompts: 0,
    risk: 0,
  }
  if (!report?.frameworks_detected.length) {
    return [all, ...FALLBACK_AGENTS]
  }
  const fromFw = report.frameworks_detected.map((f, i) => ({
    id: `fw-${i}-${f.name.replace(/\s+/g, "-").toLowerCase()}`,
    name: f.name,
    framework: f.name,
    tools: f.evidence.length,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 3)),
  }))
  return [all, ...fromFw]
}

export type OverviewAgentCard = {
  name: string
  framework: string
  tools: number
  prompts: number
  risk: number
  status: string
}

const DEFAULT_TOP_FINDINGS: { title: string; severity: "critical" | "high" | "medium" | "low"; file: string; line: number }[] =
  [
    { title: "Prompt injection vulnerability in chat handler", severity: "critical", file: "agents/chat.py", line: 142 },
    { title: "Missing human approval for tool call", severity: "high", file: "tools/refund.py", line: 89 },
    { title: "Hardcoded API key detected", severity: "high", file: "config/settings.py", line: 23 },
    { title: "Vague system prompt detected", severity: "medium", file: "prompts/system.txt", line: 1 },
  ]

export function topFindingsFromReport(
  report: ScanReport | null
): { title: string; severity: "critical" | "high" | "medium" | "low"; file: string; line: number }[] {
  if (!report?.findings.length) return DEFAULT_TOP_FINDINGS
  const w: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return [...report.findings]
    .sort((a, b) => w[a.severity] - w[b.severity] || a.title.localeCompare(b.title))
    .slice(0, 6)
    .map((f) => ({
      title: f.title,
      severity: f.severity,
      file: f.file,
      line: f.line,
    }))
}

export function buildOverviewAgentsFromReport(
  report: ScanReport | null,
  riskScore: number
): OverviewAgentCard[] {
  if (!report?.frameworks_detected.length) {
    return [
      { name: "SupportAgent", framework: "LangGraph", tools: 8, prompts: 3, risk: 72, status: "scanned" },
      { name: "ChatAgent", framework: "LangChain", tools: 5, prompts: 4, risk: 45, status: "scanned" },
      { name: "DataAgent", framework: "LlamaIndex", tools: 12, prompts: 2, risk: 38, status: "scanned" },
      { name: "APIAgent", framework: "AutoGen", tools: 6, prompts: 2, risk: 56, status: "scanned" },
      { name: "AdminAgent", framework: "LangGraph", tools: 15, prompts: 5, risk: 89, status: "scanned" },
    ]
  }
  return report.frameworks_detected.map((f, i) => ({
    name: f.name,
    framework: f.name,
    tools: f.evidence.length,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 2)),
    status: "scanned",
  }))
}
