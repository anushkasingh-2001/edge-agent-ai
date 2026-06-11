/**
 * LLM verifier — reviews an EXISTING finding cluster and returns review
 * metadata only. It can confirm a finding is real, flag it as a likely
 * false positive (downrank, never delete), or say it is uncertain. It
 * NEVER changes scanner-owned truth.
 *
 * The prompt is rule-specific and EVIDENCE-BOUND: the model must answer
 * only from the supplied bundle and cite exact evidence strings/code facts.
 * The parser (`coerceVerifierReply`) is strict:
 *   - malformed JSON / non-object  -> uncertain
 *   - real|likely_false_positive with empty evidence_used -> uncertain
 *   - cited evidence not found in the bundle (invented) -> uncertain
 *   - unsupported verdict/status values are normalised
 * `scanner_truth_unchanged` is always forced true.
 */
import { parseJsonReply } from "../server-llm-client"
import { callScanLlm } from "../server-llm-providers"
import type { ScanContextBundle } from "./build-scan-context-bundle"
import type { Cluster, VerifierResult } from "./types"
import type { ScanProvider } from "../server-llm-providers"

const SYSTEM_BASE = `You are a security finding VERIFIER for a static analysis tool.
The deterministic scanner is the source of truth. You may ONLY review an
existing finding and return review metadata. You CANNOT delete findings,
change their rule_id/severity/category/file/line/evidence, or invent new
files, lines, sources, or sinks.

Hard rules:
- Use ONLY the provided context. Do NOT use outside knowledge or assumptions.
- Every item in "evidence_used" MUST be an exact string or code fact copied
  from the FINDING or CODE CONTEXT below. If you cannot cite real evidence,
  set verdict "uncertain".
- If the context is insufficient to decide, return "uncertain".
- print/log/debug-only flows are likely_false_positive.
- If a sanitizer/guard exists on the path, list it in guards_found and lean
  toward likely_false_positive.
- Never modify scanner truth. Always set "scanner_truth_unchanged": true.

Return ONLY a JSON object with this exact shape:
{
  "verdict": "real" | "likely_false_positive" | "uncertain",
  "confidence": 0.0,
  "reason": "...",
  "evidence_used": ["exact code facts from the bundle"],
  "guards_found": ["guards or sanitizers seen"],
  "missing_evidence": ["what would be needed to decide"],
  "suggested_status": "llm_verified" | "likely_false_positive" | "needs_human_review",
  "suggested_severity_adjustment": "none" | "lower" | "raise",
  "scanner_truth_unchanged": true
}`

/** Map a rule_id/category to a rule FAMILY for targeted guidance. */
export function verifierRuleFamily(ruleId: string, category: string): string {
  const t = `${ruleId} ${category}`.toLowerCase()
  if (/command|os\.system|subprocess|shell|exec|dangerous[-_ ]?code|user-input-dangerous/.test(t))
    return "command_injection"
  if (/\bsql\b|cypher|\bdb\b|database|\bquery\b/.test(t)) return "sql_injection"
  if (/prompt[-_ ]?inject/.test(t)) return "prompt_injection"
  if (/vague|prompt[-_ ]?contract|underspecified/.test(t)) return "vague_prompt"
  if (/auth|approval|permission/.test(t)) return "auth"
  if (/secret|credential|token|api[-_ ]?key/.test(t)) return "secrets"
  if (/dependency|supply|model[-_ ]?download|deserial|pickle/.test(t)) return "supply_chain"
  if (/mcp/.test(t)) return "mcp"
  return "generic"
}

/** Rule-specific instruction appended to the system prompt so the verifier
 *  reasons about the RIGHT evidence for this family. */
export function verifierGuidanceFor(family: string): string {
  switch (family) {
    case "command_injection":
      return `This is a COMMAND-INJECTION finding. Confirm "real" ONLY if an untrusted source (user/request/config/model output) reaches a command/exec sink (os.system, subprocess, shell=True, eval, exec) with no shlex.quote/allowlist/validation guard between them. A constant/hardcoded command is likely_false_positive.`
    case "sql_injection":
      return `This is a SQL/CYPHER-INJECTION finding. Confirm "real" ONLY if untrusted input is concatenated/f-stringed into a query that is then executed, with no parameterization/binding (?, %s, bind params). Parameterized queries are likely_false_positive.`
    case "prompt_injection":
      return `This is a PROMPT-INJECTION finding. Confirm "real" ONLY if untrusted content reaches an instruction-bearing prompt or a tool argument without delimiting/quoting/policy separation.`
    case "vague_prompt":
      return `This is a VAGUE/UNDERSPECIFIED-PROMPT finding. Confirm "real" ONLY if the prompt text in the bundle is genuinely underspecified (missing role, task, output format, tool policy, approval, or fallback). Cite the missing contract parts from the evidence string. A specific, well-scoped prompt is likely_false_positive.`
    case "auth":
      return `This is an AUTH finding. Confirm "real" ONLY if a mutating or sensitive route/tool has no authentication/authorization guard (login_required, Depends(auth), require_auth, current_user, verify_token) on its path.`
    case "secrets":
      return `This is a HARDCODED-SECRET finding. Confirm "real" ONLY if a real credential/token literal is present in the code. Environment reads, placeholders, and obvious test fixtures are likely_false_positive.`
    case "supply_chain":
      return `This is a DEPENDENCY/SUPPLY-CHAIN finding. Confirm "real" ONLY if a manifest or model-download names an unpinned/risky/unsafe source (untrusted URL, torch.load/pickle of remote data, etc).`
    case "mcp":
      return `This is an MCP finding. Confirm "real" ONLY if an MCP tool/resource/handler can cause unsafe tool execution, data exposure, or auth bypass per the context.`
    default:
      return `Confirm "real" ONLY if the provided context shows an untrusted source reaching a dangerous sink with no guard. Otherwise return likely_false_positive or uncertain.`
  }
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/** Tokenise to lowercase words of length >= 4 for fuzzy "is this fact in the
 *  bundle?" matching. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])
}

/**
 * A cited fact is "supported" by the context when a meaningful share of its
 * significant tokens appear in the context. Facts with no significant tokens
 * (very short) can't be judged and are treated as supported.
 */
function factSupported(fact: string, ctxTokenSet: Set<string>): boolean {
  const ft = tokens(fact)
  if (ft.length === 0) return true
  let hit = 0
  for (const t of ft) if (ctxTokenSet.has(t)) hit++
  return hit / ft.length >= 0.5
}

const UNCERTAIN = (reason: string): VerifierResult => ({
  verdict: "uncertain",
  confidence: 0,
  reason,
  evidence_used: [],
  guards_found: [],
  missing_evidence: [],
  suggested_status: "needs_human_review",
  suggested_severity_adjustment: "none",
  scanner_truth_unchanged: true,
})

/**
 * Strict, pure coercion of a verifier reply into a VerifierResult. Never
 * throws and always returns a result (uncertain on any problem). When
 * `contextText` is supplied, evidence the model could not have read is
 * treated as invented and coerced to uncertain.
 */
export function coerceVerifierReply(raw: unknown, contextText?: string): VerifierResult {
  if (!raw || typeof raw !== "object") {
    return UNCERTAIN("malformed or non-object verifier reply")
  }
  const r = raw as Record<string, unknown>

  const verdict =
    r.verdict === "real" || r.verdict === "likely_false_positive"
      ? r.verdict
      : "uncertain"

  const evidence_used = arr(r.evidence_used)
  const guards_found = arr(r.guards_found)
  const missing_evidence = arr(r.missing_evidence)

  // A real / false-positive verdict MUST cite evidence.
  if (verdict !== "uncertain" && evidence_used.length === 0) {
    return UNCERTAIN("verdict asserted without any cited evidence")
  }

  // Invented-evidence guard: every cited fact must be traceable to the bundle.
  if (verdict !== "uncertain" && contextText) {
    const ctxSet = new Set(tokens(contextText))
    const allSupported = evidence_used.every((f) => factSupported(f, ctxSet))
    if (!allSupported) {
      return UNCERTAIN("cited evidence not found in provided context (possible fabrication)")
    }
  }

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

  // Keep status consistent with verdict for the two decisive verdicts.
  const status =
    verdict === "real"
      ? "llm_verified"
      : verdict === "likely_false_positive"
        ? "likely_false_positive"
        : suggested

  const sev =
    r.suggested_severity_adjustment === "lower" ||
    r.suggested_severity_adjustment === "raise"
      ? r.suggested_severity_adjustment
      : "none"

  return {
    verdict,
    confidence: clamp01(r.confidence),
    reason: typeof r.reason === "string" ? r.reason.slice(0, 600) : "",
    evidence_used,
    guards_found,
    missing_evidence,
    suggested_status: status,
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
  const family = verifierRuleFamily(rep.rule_id, rep.category)
  const system = `${SYSTEM_BASE}\n\nRULE-SPECIFIC GUIDANCE:\n${verifierGuidanceFor(family)}`

  const user = [
    `FINDING:`,
    `- rule_id: ${rep.rule_id}`,
    `- rule_family: ${family}`,
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
    system,
    user,
    maxTokens: args.maxTokens ?? 800,
    temperature: 0,
  })
  if (!res.ok) return { ok: false, error: res.error }

  // Evidence-bound: validate cited facts against the finding evidence + the
  // code context the model was shown.
  const contextText = `${rep.evidence}\n${args.bundle.text}`
  const result = coerceVerifierReply(parseJsonReply(res.text), contextText)
  return { ok: true, result }
}
