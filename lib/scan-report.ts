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

const ToolHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.enum(["decorator", "class", "filename", "directory"]),
  framework: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
})

const AgentHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.enum([
    "agent_class",
    "compiled_graph",
    "agent_executor",
    "agent_factory",
    "agent_file",
  ]),
  framework: z.string().nullable().optional(),
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
  // Older reports (pre-agents/tools_detected) won't have these fields;
  // default to [] so re-loading historical scans doesn't blow up the parse.
  agents_detected: z.array(AgentHitSchema).default([]),
  tools_detected: z.array(ToolHitSchema).default([]),
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
export type ToolHit = z.infer<typeof ToolHitSchema>
export type AgentHit = z.infer<typeof AgentHitSchema>

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

export const ALL_AGENTS_OPTION: TopBarAgentOption = {
  id: "all",
  name: "All Agents",
  framework: null,
  tools: 0,
  prompts: 0,
  risk: 0,
}

export function buildTopBarAgentsFromReport(
  report: ScanReport | null,
  riskScore: number
): TopBarAgentOption[] {
  if (!report?.agents_detected?.length) {
    return [ALL_AGENTS_OPTION]
  }
  // Pre-compute per-agent tool counts from tools_detected so the picker can
  // show "<agent> N tools" without recomputing in render.
  const toolsByAgent = new Map<string, number>()
  for (const t of report.tools_detected ?? []) {
    if (!t.agent) continue
    toolsByAgent.set(t.agent, (toolsByAgent.get(t.agent) ?? 0) + 1)
  }
  const fromAgents = report.agents_detected.map((a, i) => ({
    id: `agent-${i}-${a.name.replace(/\s+/g, "-").toLowerCase()}`,
    name: a.name,
    framework: a.framework ?? null,
    tools: toolsByAgent.get(a.name) ?? 0,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 2)),
  }))
  return [ALL_AGENTS_OPTION, ...fromAgents]
}

export type OverviewAgentCard = {
  name: string
  framework: string
  tools: number
  prompts: number
  risk: number
  status: string
}

export function topFindingsFromReport(
  report: ScanReport | null
): { title: string; severity: "critical" | "high" | "medium" | "low"; file: string; line: number }[] {
  if (!report?.findings.length) return []
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
  if (!report?.agents_detected?.length) return []
  const toolsByAgent = new Map<string, number>()
  for (const t of report.tools_detected ?? []) {
    if (!t.agent) continue
    toolsByAgent.set(t.agent, (toolsByAgent.get(t.agent) ?? 0) + 1)
  }
  return report.agents_detected.map((a, i) => ({
    name: a.name,
    framework: a.framework ?? "",
    tools: toolsByAgent.get(a.name) ?? 0,
    prompts: 0,
    risk: Math.min(100, Math.max(0, riskScore + i * 2)),
    status: "scanned",
  }))
}

/**
 * Per-agent tool inventory used by the top-bar Tools picker. Sourced from
 * `tools_detected`. Each tool already carries an `agent` field assigned
 * server-side (single-agent: all unattributed tools go to the only agent;
 * multi-agent: directory-proximity match). Tools that ended up without an
 * agent fall into an "Unattributed" bucket so they're still discoverable.
 *
 * Within each agent group we dedupe by tool name so a single logical tool
 * doesn't show up multiple times (e.g. two files defining the same class).
 */
export type AgentToolEntry = {
  name: string
  file: string
  line: number
  kind: ToolHit["kind"]
}

export type AgentToolGroup = {
  agent: string
  tools: AgentToolEntry[]
}

const UNATTRIBUTED_BUCKET = "Unattributed"

export function buildToolsInventoryFromReport(
  report: ScanReport | null
): AgentToolGroup[] {
  if (!report?.tools_detected?.length) return []
  const buckets = new Map<string, Map<string, AgentToolEntry>>()
  for (const t of report.tools_detected) {
    const key = (t.agent && t.agent.trim()) || UNATTRIBUTED_BUCKET
    let inner = buckets.get(key)
    if (!inner) {
      inner = new Map<string, AgentToolEntry>()
      buckets.set(key, inner)
    }
    // Dedup by tool name within an agent — keeps the first occurrence so
    // the same tool defined in two places only appears once.
    if (!inner.has(t.name)) {
      inner.set(t.name, {
        name: t.name,
        file: t.file,
        line: t.line,
        kind: t.kind,
      })
    }
  }
  // Sort: agents alphabetical, "Unattributed" last so it doesn't crowd top.
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === UNATTRIBUTED_BUCKET) return 1
      if (b === UNATTRIBUTED_BUCKET) return -1
      return a.localeCompare(b)
    })
    .map(([agent, inner]) => ({
      agent,
      tools: [...inner.values()].sort((x, y) => x.name.localeCompare(y.name)),
    }))
}

export function totalToolCountFromReport(report: ScanReport | null): number {
  // After dedup, the user-visible count is the number of unique tool names
  // (across all agents). Compute it here so the top-bar badge matches what's
  // actually rendered in the dropdown.
  if (!report?.tools_detected?.length) return 0
  const seen = new Set<string>()
  for (const t of report.tools_detected) {
    const key = `${t.agent ?? ""}::${t.name}`
    seen.add(key)
  }
  return seen.size
}
