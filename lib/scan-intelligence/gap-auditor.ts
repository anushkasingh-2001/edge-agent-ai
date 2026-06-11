/**
 * Gap auditor — reviews a risky surface and SUGGESTS missed finding
 * candidates. It can only suggest; it can never confirm. Every candidate
 * must be deterministically confirmed before it can become a finding
 * (see deterministic-confirmation.ts).
 *
 * Output strictly follows section N of the spec. The prompt forbids
 * inventing files/lines and tells the model to return no candidate (or
 * low confidence) when unsure.
 */
import { parseJsonReply } from "../server-llm-client"
import { callScanLlm } from "../server-llm-providers"
import type { ScanContextBundle } from "./build-scan-context-bundle"
import type { GapAuditCandidate, RiskSurface, RiskSurfaceKind } from "./types"
import type { ScanProvider } from "../server-llm-providers"

/**
 * Surface-specific focused audit questions (spec section 6). Each surface
 * kind gets ONE narrow question instead of a generic "find all bugs" prompt,
 * which keeps the audit precise and cheap.
 */
const SURFACE_INSTRUCTIONS: Record<RiskSurfaceKind, string> = {
  subprocess_wrapper:
    "Can user/config/model output reach command execution here without an allowlist, validation, or human approval?",
  db_query:
    "Can untrusted input reach SQL/Cypher query construction or execution here without parameterization/binding?",
  prompt_template:
    "Can untrusted content enter instruction-bearing prompt text here without delimiting, quoting, or policy separation?",
  llm_call:
    "Can model output or untrusted input influence tool arguments, code execution, or privileged decisions here?",
  tool_definition:
    "Is this agent-callable tool able to mutate external state without approval/auth/guardrails?",
  mcp_handler:
    "Can MCP tool/resource descriptions or handlers here cause unsafe tool execution, data exposure, or auth bypass?",
  auth_route:
    "Is this mutating or sensitive route missing authentication/authorization checks?",
  api_route:
    "Can unauthenticated users trigger writes, secrets exposure, filesystem access, or tool execution through this route?",
  model_download:
    "Can untrusted model/source paths here lead to unsafe download/load/deserialization?",
  config_env_file:
    "Do config/env defaults here expose credentials, disable TLS, or enable unsafe debug/admin behavior?",
}

/** The focused audit question for a surface kind (exported for tests). */
export function gapAuditInstructionFor(kind: RiskSurfaceKind): string {
  return (
    SURFACE_INSTRUCTIONS[kind] ??
    "Can untrusted input reach a dangerous sink on this surface without a guard?"
  )
}

const SYSTEM = `You are a security GAP AUDITOR for a static analysis tool.
The deterministic scanner already ran. Your job is to SUGGEST issues the
scanner may have MISSED on the provided risky surface. You only suggest
candidates — you cannot confirm them, and a deterministic checker will
verify everything you propose.

Rules:
- Use ONLY the provided context. Never invent files or line numbers.
- Answer ONLY the focused question for this surface kind. Do not look for
  unrelated issue classes.
- If you are unsure, return no candidate or a low confidence.
- Prefer real source -> dangerous sink flows (user/config/request/model
  output reaching exec/command/SQL/file/network/model-download sinks).
- Every candidate MUST set "needs_deterministic_confirmation": true.

Return ONLY a JSON object with this exact shape:
{
  "candidates": [
    {
      "candidate_title": "...",
      "rule_family": "...",
      "source_kind": "...",
      "sink_kind": "...",
      "file": "...",
      "line": 123,
      "evidence": "...",
      "why_missed": "...",
      "confidence": 0.0,
      "needs_deterministic_confirmation": true
    }
  ]
}`

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function coerceCandidates(raw: unknown): GapAuditCandidate[] {
  if (!raw || typeof raw !== "object") return []
  const list = (raw as Record<string, unknown>).candidates
  if (!Array.isArray(list)) return []
  const out: GapAuditCandidate[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const c = item as Record<string, unknown>
    const file = typeof c.file === "string" ? c.file : ""
    const line = typeof c.line === "number" ? c.line : Number(c.line)
    if (!file || !Number.isFinite(line)) continue
    out.push({
      candidate_title: typeof c.candidate_title === "string" ? c.candidate_title : "",
      rule_family: typeof c.rule_family === "string" ? c.rule_family : "unknown",
      source_kind: typeof c.source_kind === "string" ? c.source_kind : "unknown",
      sink_kind: typeof c.sink_kind === "string" ? c.sink_kind : "unknown",
      file,
      line,
      evidence: typeof c.evidence === "string" ? c.evidence : "",
      why_missed: typeof c.why_missed === "string" ? c.why_missed : "",
      confidence: clamp01(c.confidence),
      needs_deterministic_confirmation: true,
    })
  }
  return out
}

export interface AuditArgs {
  surface: RiskSurface
  bundle: ScanContextBundle
  provider: ScanProvider
  apiKey: string
  baseUrl: string
  model: string
  maxTokens?: number
}

export type AuditOutcome =
  | { ok: true; candidates: GapAuditCandidate[] }
  | { ok: false; error: string }

export async function auditSurface(args: AuditArgs): Promise<AuditOutcome> {
  const user = [
    `RISKY SURFACE:`,
    `- kind: ${args.surface.kind}`,
    `- label: ${args.surface.label}`,
    `- file: ${args.surface.file}:${args.surface.line}`,
    ``,
    `FOCUSED QUESTION (answer ONLY this):`,
    gapAuditInstructionFor(args.surface.kind),
    ``,
    `CODE CONTEXT (redacted):`,
    args.bundle.text,
  ].join("\n")

  const res = await callScanLlm({
    provider: args.provider,
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    model: args.model,
    system: SYSTEM,
    user,
    maxTokens: args.maxTokens ?? 1200,
    temperature: 0,
  })
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, candidates: coerceCandidates(parseJsonReply(res.text)) }
}
