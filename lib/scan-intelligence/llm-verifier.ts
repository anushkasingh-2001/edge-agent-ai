/**
 * LLM verifier — reviews an EXISTING finding cluster and returns review
 * metadata only. It can confirm a finding is real, flag it as a likely
 * false positive (downrank, never delete), or say it is uncertain. It
 * NEVER changes scanner-owned truth.
 *
 * Output strictly follows section M of the spec. The prompt forbids the
 * model from inventing files/lines/sources/sinks and instructs it to
 * return `uncertain` when context is insufficient.
 */
import { parseJsonReply } from "../server-llm-client"
import { callScanLlm } from "../server-llm-providers"
import type { ScanContextBundle } from "./build-scan-context-bundle"
import type { Cluster, VerifierResult } from "./types"
import type { ScanProvider } from "../server-llm-providers"

const SYSTEM = `You are a security finding VERIFIER for a static analysis tool.
The deterministic scanner is the source of truth. You may ONLY review an
existing finding and return review metadata. You CANNOT delete findings,
change their rule_id/severity/category/file/line/evidence, or invent new
files, lines, sources, or sinks.

Rules:
- Use ONLY the provided context. If context is insufficient, return "uncertain".
- print/log/debug-only flows are likely_false_positive.
- user/config/request/model-output reaching a dangerous sink is likely "real".
- If a sanitizer/guard exists on the path, mention it in guards_found.
- Never modify scanner truth. Always set "scanner_truth_unchanged": true.

Return ONLY a JSON object with this exact shape:
{
  "verdict": "real" | "likely_false_positive" | "uncertain",
  "confidence": 0.0,
  "reason": "...",
  "evidence_used": ["..."],
  "guards_found": ["..."],
  "missing_evidence": ["..."],
  "suggested_status": "llm_verified" | "likely_false_positive" | "needs_human_review",
  "suggested_severity_adjustment": "none" | "lower" | "raise",
  "scanner_truth_unchanged": true
}`

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function coerce(raw: unknown): VerifierResult | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const verdict =
    r.verdict === "real" || r.verdict === "likely_false_positive"
      ? r.verdict
      : "uncertain"
  const suggested =
    r.suggested_status === "llm_verified" ||
    r.suggested_status === "likely_false_positive" ||
    r.suggested_status === "needs_human_review"
      ? r.suggested_status
      : verdict === "real"
        ? "llm_verified"
        : verdict === "likely_false_positive"
          ? "likely_false_positive"
          : "needs_human_review"
  const sev =
    r.suggested_severity_adjustment === "lower" ||
    r.suggested_severity_adjustment === "raise"
      ? r.suggested_severity_adjustment
      : "none"
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  return {
    verdict,
    confidence: clamp01(r.confidence),
    reason: typeof r.reason === "string" ? r.reason.slice(0, 600) : "",
    evidence_used: arr(r.evidence_used),
    guards_found: arr(r.guards_found),
    missing_evidence: arr(r.missing_evidence),
    suggested_status: suggested,
    suggested_severity_adjustment: sev,
    // Always forced true — the verifier can never change scanner truth.
    scanner_truth_unchanged: true,
  }
}

export interface VerifyArgs {
  cluster: Cluster
  bundle: ScanContextBundle
  provider: ScanProvider
  apiKey: string
  baseUrl: string
  model: string
  maxTokens?: number
}

export type VerifyOutcome =
  | { ok: true; result: VerifierResult }
  | { ok: false; error: string }

export async function verifyCluster(args: VerifyArgs): Promise<VerifyOutcome> {
  const rep = args.cluster.representative
  const user = [
    `FINDING:`,
    `- rule_id: ${rep.rule_id}`,
    `- severity: ${rep.severity}`,
    `- category: ${rep.category}`,
    `- title: ${rep.title}`,
    `- file: ${rep.file}:${rep.line}`,
    `- evidence: ${rep.evidence}`,
    `- duplicate_count: ${args.cluster.findings.length}`,
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
    maxTokens: args.maxTokens ?? 800,
    temperature: 0,
  })
  if (!res.ok) return { ok: false, error: res.error }

  const parsed = coerce(parseJsonReply(res.text))
  if (!parsed) return { ok: false, error: "unparseable_verifier_reply" }
  return { ok: true, result: parsed }
}
