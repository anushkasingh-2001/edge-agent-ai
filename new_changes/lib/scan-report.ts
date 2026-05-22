import { z } from "zod"

export const SCANNER_RULE_IDS = [
  "dangerous-tools",
  "human-approval",
  "prompt-injection",
  "prompt-contract",
  "secrets",
  "mcp-security",
  "openapi-schema",
  "auth-checks",
  "dependency-risks",
  "user-input-dangerous-code",
  "accuracy-regression-risk",
] as const

export type ScannerRuleId = (typeof SCANNER_RULE_IDS)[number]

const LocationSchema = z.object({
  file: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  symbol: z.string().nullable().optional(),
})

const EvidencePathNodeSchema = z.object({
  kind: z.string(),
  label: z.string(),
  file: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
})

const SuggestedPatchSchema = z.object({
  file: z.string(),
  unified_diff: z.string(),
  explanation: z.string(),
})

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
  primary_location: LocationSchema.nullable().optional(),
  related_locations: z.array(LocationSchema).optional(),
  evidence_path: z.array(EvidencePathNodeSchema).optional(),
  suggested_patch: SuggestedPatchSchema.nullable().optional(),
  verifier: z.record(z.string(), z.unknown()).optional(),
  confidence_band: z.string().nullable().optional(),
  escalation: z.string().nullable().optional(),
  confidence_features: z.record(z.string(), z.unknown()).optional(),
})

const ToolHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.string(),
  framework: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  side_effects: z.array(z.string()).default([]),
  callable_from_agent: z.boolean().default(false),
})

const AgentHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  kind: z.string(),
  framework: z.string().nullable().optional(),
})

const ModelHitSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string(),
  file: z.string(),
  line: z.number(),
  agent: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
})

const PromptHitSchema = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number(),
  agent: z.string().nullable().optional(),
  used_by_model: z.string().nullable().optional(),
  text_preview: z.string().default(""),
})

export const ScanReportSchema = z.object({
  schema_version: z.string(),
  scan_root: z.string(),
  generated_at: z.string(),
  frameworks_detected: z.array(z.object({ name: z.string(), evidence: z.array(z.string()) })).default([]),
  agents_detected: z.array(AgentHitSchema).default([]),
  tools_detected: z.array(ToolHitSchema).default([]),
  models_detected: z.array(ModelHitSchema).default([]),
  prompts_detected: z.array(PromptHitSchema).default([]),
  summary: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    total: z.number(),
  }),
  risk_score: z.number(),
  findings: z.array(ScannerFindingSchema),
  files_scanned: z.number().int().min(0).optional(),
  files_scanned_by_ext: z.record(z.string(), z.number().int().min(0)).optional(),
})

export type ScanReport = z.infer<typeof ScanReportSchema>
export type ScannerFinding = z.infer<typeof ScannerFindingSchema>
export type ToolHit = z.infer<typeof ToolHitSchema>
export type AgentHit = z.infer<typeof AgentHitSchema>
export type ModelHit = z.infer<typeof ModelHitSchema>
export type PromptHit = z.infer<typeof PromptHitSchema>

export function parseScanReport(data: unknown): ScanReport {
  return ScanReportSchema.parse(data)
}

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
  evidencePath?: z.infer<typeof EvidencePathNodeSchema>[]
  suggestedPatch?: z.infer<typeof SuggestedPatchSchema> | null
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
    evidencePath: f.evidence_path,
    suggestedPatch: f.suggested_patch,
  }))
}

export function filterChecksForScanner(selectedCheckIds: string[]): string[] {
  const set = new Set<string>(SCANNER_RULE_IDS)
  return selectedCheckIds.filter((id) => set.has(id as ScannerRuleId))
}
