/**
 * Build a risky-surface inventory from the deterministic report.
 *
 * Surfaces are the places where a missed issue is most likely to hide:
 * LLM calls, prompt templates, tool/MCP definitions, subprocess
 * wrappers, DB query helpers, auth/API routes, model downloads, and
 * config/env/file-read helpers. The gap auditor reviews these surfaces
 * (never the whole repo) looking for candidates the scanner missed.
 *
 * Built purely from the report's IR-derived inventories
 * (`*_detected`) plus existing finding categories — no LLM, no repo
 * walk.
 */
import type { RiskSurface, RiskSurfaceKind, ScanFinding } from "./types"

interface RawHit {
  file?: unknown
  line?: unknown
  name?: unknown
  model?: unknown
  category?: unknown
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : ""
}
function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** Map a finding category / rule to a risk-surface kind, if it is one. */
function surfaceKindForCategory(category: string, ruleId: string): RiskSurfaceKind | null {
  const c = `${category} ${ruleId}`.toLowerCase()
  if (/prompt[-_ ]?inject|prompt[-_ ]?contract|prompt/.test(c)) return "prompt_template"
  if (/mcp/.test(c)) return "mcp_handler"
  if (/subprocess|os\.system|shell|command|exec|dangerous[-_ ]?code/.test(c))
    return "subprocess_wrapper"
  if (/sql|cypher|injection|db|database|query/.test(c)) return "db_query"
  if (/auth|missing[-_ ]?auth|human[-_ ]?approval/.test(c)) return "auth_route"
  if (/openapi|api[-_ ]?route|route|schema/.test(c)) return "api_route"
  if (/model[-_ ]?download|dependency|supply/.test(c)) return "model_download"
  if (/secret|config|env|file[-_ ]?read|file[-_ ]?write/.test(c)) return "config_env_file"
  if (/tool|dangerous[-_ ]?tool/.test(c)) return "tool_definition"
  return null
}

export function buildRiskSurfaceInventory(
  report: Record<string, unknown>,
): RiskSurface[] {
  const out: RiskSurface[] = []
  const seen = new Set<string>()

  const push = (kind: RiskSurfaceKind, label: string, file: string, line: number) => {
    if (!file) return
    const key = `${kind}|${file}|${line}|${label}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, label, file, line })
  }

  // Models / prompts / tools detected by the scanner IR.
  for (const m of (report.models_detected as RawHit[] | undefined) ?? []) {
    push("model_download", asStr(m.model) || "model", asStr(m.file), asNum(m.line))
    push("llm_call", asStr(m.model) || "llm_call", asStr(m.file), asNum(m.line))
  }
  for (const p of (report.prompts_detected as RawHit[] | undefined) ?? []) {
    push("prompt_template", asStr(p.name) || "prompt", asStr(p.file), asNum(p.line))
  }
  for (const t of (report.tools_detected as RawHit[] | undefined) ?? []) {
    push("tool_definition", asStr(t.name) || "tool", asStr(t.file), asNum(t.line))
  }

  // Finding categories also point at surfaces worth auditing.
  for (const f of (report.findings as ScanFinding[] | undefined) ?? []) {
    const kind = surfaceKindForCategory(f.category ?? "", f.rule_id ?? "")
    if (kind) push(kind, f.category ?? kind, f.file, f.line)
  }

  return out
}
