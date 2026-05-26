/**
 * Fix Planner (NEW FILE → lib/fix-planner.ts)
 *
 * Runs BEFORE the model router. Its single job: decide *whether AI is
 * needed at all*, and if so, how heavy. It never calls a model.
 *
 * This is the accuracy backbone of the locked architecture. By forcing
 * every finding through a deterministic classifier first, we guarantee
 * that the cheap/reliable path is always tried before any LLM spend, and
 * that genuinely unfixable findings get an honest "we can't auto-fix
 * this" outcome instead of a hallucinated patch.
 *
 * Classes
 * -------
 *   template_fix        → a deterministic template in server-finding-fixes
 *                         TEMPLATES covers this rule. No AI.
 *   scanner_rule_fix    → the scanner itself emitted a `suggested_patch`
 *                         (Finding.suggested_patch). Apply it directly. No AI.
 *   llm_simple_patch    → single-file, local, AST-bounded edit. One cheap
 *                         LLM call OR a pure AST transform.
 *   llm_complex_patch   → multi-file / multi-hop taint / cross-file auth.
 *                         Worth plan-then-diff on a strong model.
 *   cannot_fix_safely   → no safe automated fix exists (binary asset,
 *                         unsupported file type, etc). Surface honestly.
 *   needs_user_decision → a fix exists but requires a human choice
 *                         (e.g. which auth scheme, business-logic intent).
 */

/** Rule ids that have a deterministic template in
 *  `lib/server-finding-fixes.ts` (TEMPLATES). Keep this in sync with that
 *  file's TEMPLATES keys — a unit test should assert they match. */
export const TEMPLATE_COVERED_RULES = new Set<string>([
  "dangerous-tools",
  "human-approval",
  "prompt-injection",
  "vague-prompts",
  "secrets",
  "mcp-security",
  "openapi-schema",
  "dependency-risks",
  "user-input-dangerous-code",
])

/** Rules whose correct fix usually lives somewhere OTHER than the finding
 *  line (taint source, cross-file auth) → graph reasoning + likely complex. */
const ROOT_CAUSE_ELSEWHERE_RULES = new Set<string>([
  "taint-user-input",
  "missing-auth",
  "auth-checks",
  "prompt-contract",
])

/** File extensions we cannot safely edit programmatically. */
const UNFIXABLE_EXTENSIONS = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".lock", ".bin", ".so", ".woff", ".woff2",
])

export type FixClass =
  | "template_fix"
  | "scanner_rule_fix"
  | "llm_simple_patch"
  | "llm_complex_patch"
  | "cannot_fix_safely"
  | "needs_user_decision"

/** Minimal finding shape the planner needs. Aligns with the scanner's
 *  Finding / ScannerFinding (report.py / lib/scan-report.ts). */
export interface PlannerFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  confidence?: number
  confidence_band?: string | null
  /** Set when the scanner already produced a deterministic patch. */
  has_suggested_patch?: boolean
  /** Number of distinct files in this finding's evidence_path. >1 ⇒ cross-file. */
  evidence_path_files?: number
  /** Length of the taint/evidence path. Longer ⇒ more hops ⇒ complex. */
  evidence_path_len?: number
}

export interface PlanResult {
  finding_id: string
  fix_class: FixClass
  /** Whether this class consumes an LLM call (drives router + cost). */
  needs_llm: boolean
  /** Whether graph-bounded context must be assembled (skip for local fixes). */
  needs_graph_context: boolean
  /** Human-readable reason — surfaced for cannot_fix_safely / needs_user_decision. */
  reason: string
}

function extname(file: string): string {
  const i = file.lastIndexOf(".")
  return i < 0 ? "" : file.slice(i).toLowerCase()
}

/**
 * Classify a single finding. Deterministic, ordered: the first matching
 * rule wins, cheapest-and-safest first.
 */
export function planFix(f: PlannerFinding): PlanResult {
  const base = { finding_id: f.id }

  // 0. Hard stop: file type we can't touch.
  if (UNFIXABLE_EXTENSIONS.has(extname(f.file))) {
    return {
      ...base,
      fix_class: "cannot_fix_safely",
      needs_llm: false,
      needs_graph_context: false,
      reason: `${extname(f.file) || "this file type"} can't be safely auto-edited; fix by hand.`,
    }
  }

  // 1. Scanner already produced a deterministic patch → just apply it.
  if (f.has_suggested_patch) {
    return {
      ...base,
      fix_class: "scanner_rule_fix",
      needs_llm: false,
      needs_graph_context: false,
      reason: "Scanner emitted a deterministic suggested_patch; apply directly.",
    }
  }

  // 2. A template covers this rule → deterministic template fix. No AI.
  if (TEMPLATE_COVERED_RULES.has(f.rule_id)) {
    return {
      ...base,
      fix_class: "template_fix",
      needs_llm: false,
      needs_graph_context: false,
      reason: `Rule '${f.rule_id}' has a deterministic template.`,
    }
  }

  // 3. Low-confidence findings: don't burn an LLM guessing on something the
  //    scanner itself isn't sure about. Ask the user.
  if (typeof f.confidence === "number" && f.confidence < 0.4) {
    return {
      ...base,
      fix_class: "needs_user_decision",
      needs_llm: false,
      needs_graph_context: false,
      reason: `Low scanner confidence (${f.confidence.toFixed(2)}); a human should confirm before fixing.`,
    }
  }

  // 4. Cross-file or multi-hop ⇒ complex. Worth plan-then-diff on a strong model.
  const crossFile = (f.evidence_path_files ?? 1) > 1
  const multiHop = (f.evidence_path_len ?? 0) >= 3
  const rootCauseElsewhere = ROOT_CAUSE_ELSEWHERE_RULES.has(f.rule_id)
  if (crossFile || multiHop || rootCauseElsewhere) {
    return {
      ...base,
      fix_class: "llm_complex_patch",
      needs_llm: true,
      needs_graph_context: true,
      reason: crossFile
        ? "Fix spans multiple files; needs cross-file reasoning."
        : multiHop
          ? "Multi-hop taint path; root cause differs from finding line."
          : `Rule '${f.rule_id}' typically requires fixing upstream of the finding.`,
    }
  }

  // 5. Default: a local, single-file edit a cheap model (or AST patcher) can do.
  return {
    ...base,
    fix_class: "llm_simple_patch",
    needs_llm: true,
    needs_graph_context: true, // still want the containing function, just no cross-file.
    reason: "Local single-file fix; cheap model or AST transform.",
  }
}

/** Batch convenience. */
export function planFixes(findings: PlannerFinding[]): PlanResult[] {
  return findings.map(planFix)
}
