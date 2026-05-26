/**
 * Fix Planner.
 *
 * Runs BEFORE the model router. Its single job: decide *whether AI is
 * needed at all*, and if so, how heavy. It never calls a model.
 *
 * Every finding is forced through this deterministic classifier first so
 * the cheap/reliable path is always tried before any LLM spend, and so
 * genuinely unfixable findings get an honest "we can't auto-fix this"
 * outcome instead of a hallucinated patch.
 *
 * Reality-checked against the real scanner
 * ----------------------------------------
 * The original Claude-generated scaffold guessed at rule ids that don't
 * exist (`vague-prompts`, `taint-user-input`, `missing-auth`). This file
 * is synced 1:1 to the actual ids the Python scanner emits, which live
 * in `scanner/src/edge_agent_scanner/report.py::ALL_RULE_IDS` and in
 * `SCANNER_RULE_IDS` in `lib/scan-report.ts`. A unit test
 * (`tests/fix-system.test.ts`) asserts those three sets agree, so a
 * scanner-side rename can't silently misroute the planner.
 *
 * Classes
 * -------
 *   template_fix        → a deterministic template in server-finding-fixes
 *                         TEMPLATES covers this rule. No AI.
 *   scanner_rule_fix    → the scanner itself emitted a `suggested_patch`
 *                         on the Finding. Apply it directly. No AI.
 *   llm_simple_patch    → single-file, local, AST-bounded edit. One
 *                         cheap LLM call.
 *   llm_complex_patch   → multi-file / multi-hop taint / cross-file auth.
 *                         Worth plan-then-diff on a strong model.
 *   cannot_fix_safely   → no safe automated fix exists (binary asset,
 *                         unsupported file type, etc). Surface honestly.
 *   needs_user_decision → a fix exists but requires a human choice
 *                         (e.g. which auth scheme, business-logic intent,
 *                         pin a new model after a quality regression).
 */

/**
 * Rule ids that have a deterministic template in
 * `lib/server-finding-fixes.ts`'s TEMPLATES map. Kept in lockstep with
 * that file — a unit test asserts every entry here is present in
 * TEMPLATES, and every TEMPLATES key whose rule the scanner still emits
 * is present here. If you add/remove a template, edit both files in the
 * same PR.
 *
 * Stale-but-kept: `vague-prompts` — the scanner used to emit this before
 * `prompt-contract` replaced it. TEMPLATES still has a fallback entry so
 * old cached findings continue to fix cleanly. New scanner output never
 * uses this id.
 */
export const TEMPLATE_COVERED_RULES = new Set<string>([
  "dangerous-tools",
  "human-approval",
  "prompt-injection",
  "vague-prompts", // legacy alias for prompt-contract, still in TEMPLATES
  "secrets",
  "mcp-security",
  "openapi-schema",
  "dependency-risks",
  "user-input-dangerous-code",
])

/**
 * Rules whose root cause typically lives somewhere OTHER than the
 * finding line — taint sources, cross-file auth dependencies, contract
 * fields scattered across prompt templates. These warrant graph-bounded
 * context + a stronger model.
 *
 * NOTE: `user-input-dangerous-code` and `auth-checks` are the real
 * scanner ids; the scaffold's `taint-user-input` / `missing-auth` are
 * NOT what the Python scanner emits.
 */
const ROOT_CAUSE_ELSEWHERE_RULES = new Set<string>([
  "user-input-dangerous-code",
  "auth-checks",
  "prompt-contract",
])

/**
 * Quality-risk rules. These are not security bugs but rather behaviour
 * regressions — the appropriate "fix" is a human decision (pin a model,
 * add gold examples, accept the change), not an auto-patch.
 */
const QUALITY_RISK_RULES = new Set<string>([
  "accuracy-regression-risk",
])

/** File extensions we cannot safely edit programmatically. */
const UNFIXABLE_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".lock",
  ".bin",
  ".so",
  ".dylib",
  ".dll",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".zip",
  ".tar",
  ".gz",
  ".mp3",
  ".mp4",
  ".wav",
  ".webm",
])

export type FixClass =
  | "template_fix"
  | "scanner_rule_fix"
  | "llm_simple_patch"
  | "llm_complex_patch"
  | "cannot_fix_safely"
  | "needs_user_decision"

/**
 * Minimal finding shape the planner needs. Maps onto
 * `ScannerFinding` (lib/scan-report.ts) and the Python
 * `Finding` (scanner/.../report.py).
 *
 * Note: `has_suggested_patch` is a derived boolean — the underlying
 * field on `Finding` is `suggested_patch: SuggestedPatch | null`, so
 * callers compute `has_suggested_patch = finding.suggested_patch != null`
 * before passing into the planner. Kept as a boolean here for callsite
 * clarity (the planner doesn't need the patch contents to decide).
 */
export interface PlannerFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  file: string
  line: number
  /** 0.0–1.0 numeric confidence from the scanner (if available). */
  confidence?: number
  /** UI-friendly band; falls back to severity-based heuristics if
   *  the numeric `confidence` isn't plumbed through. */
  confidence_band?: string | null
  /** True iff the scanner produced a deterministic patch on the
   *  finding (derived from `suggested_patch != null`). */
  has_suggested_patch?: boolean
  /** Number of distinct files in this finding's evidence_path. >1
   *  ⇒ cross-file. */
  evidence_path_files?: number
  /** Length of the taint/evidence path. Longer ⇒ more hops ⇒ complex. */
  evidence_path_len?: number
}

export interface PlanResult {
  finding_id: string
  fix_class: FixClass
  /** Whether this class consumes an LLM call (drives router + cost). */
  needs_llm: boolean
  /** Whether graph-bounded context must be assembled (skip for local
   *  fixes). */
  needs_graph_context: boolean
  /** Human-readable reason — surfaced for cannot_fix_safely /
   *  needs_user_decision. */
  reason: string
}

function extname(file: string): string {
  const i = file.lastIndexOf(".")
  return i < 0 ? "" : file.slice(i).toLowerCase()
}

/**
 * Heuristic translation of `confidence_band` → numeric, used when the
 * scanner only emits the band string. Conservatively low so a `low`
 * band routes to `needs_user_decision` just like a sub-0.4 numeric.
 */
function bandToNumeric(band: string | null | undefined): number | null {
  if (!band) return null
  const lc = band.toLowerCase()
  if (lc === "low" || lc === "weak") return 0.3
  if (lc === "medium" || lc === "review") return 0.6
  if (lc === "high" || lc === "strong") return 0.85
  return null
}

/**
 * Classify a single finding. Deterministic, ordered:
 * the first matching rule wins, cheapest-and-safest first.
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

  // 1. Quality risks (model regressions, etc.) require a human decision.
  //    No patch will "fix" a model swap; the user has to decide whether
  //    to pin or accept.
  if (QUALITY_RISK_RULES.has(f.rule_id)) {
    return {
      ...base,
      fix_class: "needs_user_decision",
      needs_llm: false,
      needs_graph_context: false,
      reason:
        `Rule '${f.rule_id}' is a quality/behaviour risk, not a security bug — ` +
        `pin the model or add a regression example yourself.`,
    }
  }

  // 2. Scanner already produced a deterministic patch → just apply it.
  if (f.has_suggested_patch) {
    return {
      ...base,
      fix_class: "scanner_rule_fix",
      needs_llm: false,
      needs_graph_context: false,
      reason: "Scanner emitted a deterministic suggested_patch; apply directly.",
    }
  }

  // 3. A template covers this rule → deterministic template fix. No AI.
  if (TEMPLATE_COVERED_RULES.has(f.rule_id)) {
    return {
      ...base,
      fix_class: "template_fix",
      needs_llm: false,
      needs_graph_context: false,
      reason: `Rule '${f.rule_id}' has a deterministic template.`,
    }
  }

  // 4. Low-confidence findings: don't burn an LLM guessing on something
  //    the scanner itself isn't sure about. Ask the user.
  const numericConf =
    typeof f.confidence === "number" ? f.confidence : bandToNumeric(f.confidence_band)
  if (numericConf != null && numericConf < 0.4) {
    return {
      ...base,
      fix_class: "needs_user_decision",
      needs_llm: false,
      needs_graph_context: false,
      reason: `Low scanner confidence (${numericConf.toFixed(2)}); a human should confirm before fixing.`,
    }
  }

  // 5. Cross-file or multi-hop ⇒ complex. Worth plan-then-diff on a
  //    strong model.
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

  // 6. Default: a local, single-file edit a cheap model (or AST
  //    transform) can do.
  return {
    ...base,
    fix_class: "llm_simple_patch",
    needs_llm: true,
    needs_graph_context: true,
    reason: "Local single-file fix; cheap model or AST transform.",
  }
}

/** Batch convenience. */
export function planFixes(findings: PlannerFinding[]): PlanResult[] {
  return findings.map(planFix)
}
