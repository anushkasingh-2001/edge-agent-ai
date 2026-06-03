/**
 * Catalog of built-in security checks the user can toggle in Scan Center.
 *
 * Lives here (rather than inside `scan-center.tsx`) so other surfaces — the
 * Overview "Tests" tile, the Findings filter dropdown, future settings
 * screens — can count or list them without duplicating the constant.
 *
 * NOTE: These IDs are *UI* check IDs, not scanner rule IDs. The mapping
 * from a UI check ID to one or more scanner rule IDs lives inside
 * `lib/scan-report.ts::resolveChecksForApi`. Keep the two lists in sync
 * when adding new categories.
 *
 * `scannerCategories` is the SECOND mapping: each UI check is associated
 * with zero or more raw category strings the Python scanner emits in its
 * `findings[].category` field. The Findings view uses this to:
 *
 *   1. Group raw scanner categories under the same user-facing label that
 *      Scan Center shows (e.g. "Dangerous tool / side effect" → the
 *      "Dangerous tools" check).
 *   2. Render every check in the category filter dropdown — even ones
 *      with zero findings in the current scan — so the dropdown is the
 *      same vocabulary as the Scan Center checklist.
 *
 * A check with `scannerCategories: []` is a "UI-only" / "not-yet-wired"
 * check (no Python rule emits findings for it today). It still shows up
 * in the dropdown so the user sees the full taxonomy; it just always
 * counts to 0 until a backing rule is added.
 */
import { SCANNER_RULE_IDS } from "./scan-report"

export interface SecurityCheck {
  id: string
  label: string
  description: string
  /** Raw `findings[].category` strings this check owns. The Findings
   *  view normalises every finding's category to the corresponding
   *  check `label` for display + filtering. Empty array == no scanner
   *  rule emits this category yet. */
  scannerCategories: string[]
  /** True for runtime/behavioral checks (live smoke tests,
   *  performance/runtime, accuracy regression, tool-selection
   *  correctness). These are NOT static code-analysis detectors — they
   *  require running Behavioral Tests / Evaluations against a live agent.
   *  They must never appear in the static Code Analysis checklist or
   *  findings; they live under the Behavioral Tests surface instead. */
  behavioral?: boolean
}

export const SECURITY_CHECKS: ReadonlyArray<SecurityCheck> = [
  {
    id: "dangerous-tools",
    label: "Dangerous tools",
    description: "Agent-callable tools that can cause real side effects",
    scannerCategories: [
      "Dangerous tool / side effect",
      "Presence warning (agent unknown)",
      "Dangerous code present",
    ],
  },
  {
    id: "human-approval",
    label: "Missing human approval",
    description: "High-impact tool paths without approval or policy gate",
    scannerCategories: ["Missing approval gate"],
  },
  {
    id: "prompt-injection",
    label: "Prompt injection",
    description: "Untrusted content reaching instruction-bearing prompts or tool arguments",
    scannerCategories: ["Prompt injection"],
  },
  {
    id: "prompt-contract",
    label: "Prompt contract quality",
    description:
      "Prompts missing role, tool policy, output schema, approval rules, or grounding constraints",
    scannerCategories: ["Prompt contract"],
  },
  {
    id: "vague-prompts",
    label: "Vague prompts",
    description: "Find prompts that lack specificity",
    // The IR-based scanner no longer emits "Weak prompt"/"Vague prompt"
    // categories (replaced by `prompt-contract` above). The entry stays in
    // the UI taxonomy so old reports loaded from localStorage still group
    // correctly under the same label they were filed under.
    scannerCategories: ["Weak prompt", "Vague prompt"],
  },
  {
    id: "mcp-security",
    label: "MCP security",
    description: "Unsafe MCP tools, resources, transport, scopes, or descriptor text",
    scannerCategories: ["MCP configuration"],
  },
  {
    id: "openapi-schema",
    label: "OpenAPI/schema quality",
    description: "OpenAPI specs that are unsafe or too vague for agent tool use",
    scannerCategories: ["OpenAPI"],
  },
  {
    id: "auth-checks",
    label: "Auth checks",
    description: "Sensitive routes/tools without authentication or authorization guards",
    // Now wired: the new `analyze_auth_checks` analyzer emits findings with
    // category="Auth" for mutating routes that have no detected auth guard.
    scannerCategories: ["Auth"],
  },
  {
    id: "secrets",
    label: "Hardcoded secrets",
    description: "Exposed credentials, tokens, keys, or secret-like values",
    scannerCategories: ["Hardcoded secret"],
  },
  {
    id: "dependency-risks",
    label: "Dependency risks",
    description: "Vulnerable, unpinned, unsafe, or weakly controlled dependencies",
    scannerCategories: ["Dependencies"],
  },
  {
    id: "user-input-dangerous-code",
    label: "User input to dangerous code",
    description: "CodeQL-style source-to-sink flows into dangerous execution or mutation sinks",
    scannerCategories: ["Data flow"],
  },
  {
    id: "accuracy-regression-risk",
    label: "Accuracy regression risk",
    description: "Static changes that may reduce agent accuracy and should trigger evals",
    scannerCategories: ["Accuracy risk", "Accuracy / quality risk"],
  },
  // ---- Behavioral / runtime evaluations (NOT static code analysis). ----
  // These require running Behavioral Tests / Evaluations against a live
  // agent; no static rule can confirm them. They are surfaced under the
  // Behavioral Tests panel, never as static Code Analysis checks/findings.
  {
    id: "accuracy",
    label: "Accuracy regression",
    description: "Detect output-quality regressions (requires evaluations)",
    scannerCategories: [],
    behavioral: true,
  },
  {
    id: "performance",
    label: "Performance/runtime",
    description: "Monitor latency and resource usage (requires runtime tests)",
    scannerCategories: [],
    behavioral: true,
  },
  {
    id: "tool-selection",
    label: "Tool selection correctness",
    description: "Verify correct tool routing (requires behavioral probes)",
    scannerCategories: [],
    behavioral: true,
  },
  {
    id: "smoke-tests",
    label: "Live smoke tests",
    description: "Run live validation tests (requires behavioral tests)",
    scannerCategories: [],
    behavioral: true,
  },
] as const

/**
 * Whether a UI check is backed by a REAL deterministic scanner rule that
 * runs today. Source of truth is `SCANNER_RULE_IDS` (the rule ids the
 * Python scanner actually emits) — NOT the presence of a UI label.
 *
 * Unbacked checks (`accuracy`, `performance`, `tool-selection`,
 * `smoke-tests`, and the legacy `vague-prompts` whose categories the
 * IR scanner no longer emits) are kept in the taxonomy for stability but
 * must be surfaced to the user as "coming soon / not enabled" rather than
 * as a real detector that simply found nothing.
 */
const BACKED_CHECK_IDS: ReadonlySet<string> = new Set<string>(SCANNER_RULE_IDS)

export function isCheckEnabled(id: string): boolean {
  return BACKED_CHECK_IDS.has(id)
}

/** IDs of runtime/behavioral checks (require Behavioral Tests, not a
 *  static scan). */
export const BEHAVIORAL_CHECK_IDS: ReadonlySet<string> = new Set<string>(
  SECURITY_CHECKS.filter((c) => c.behavioral).map((c) => c.id),
)

export function isBehavioralCheck(id: string): boolean {
  return BEHAVIORAL_CHECK_IDS.has(id)
}

/** Static code-analysis checks (everything that is NOT behavioral). These
 *  are the only checks shown in the static Scan Center checklist. */
export const STATIC_SECURITY_CHECKS: ReadonlyArray<SecurityCheck> =
  SECURITY_CHECKS.filter((c) => !c.behavioral)

/** Behavioral / evaluation checks, shown under the Behavioral Tests
 *  surface — never as static Code Analysis findings. */
export const BEHAVIORAL_SECURITY_CHECKS: ReadonlyArray<SecurityCheck> =
  SECURITY_CHECKS.filter((c) => c.behavioral)

/** UI checks that have a real, running deterministic detector today. */
export const ENABLED_SECURITY_CHECKS: ReadonlyArray<SecurityCheck> =
  SECURITY_CHECKS.filter((c) => isCheckEnabled(c.id))

/** UI checks that are taxonomy-only scaffolds (no backing detector yet). */
export const COMING_SOON_SECURITY_CHECKS: ReadonlyArray<SecurityCheck> =
  SECURITY_CHECKS.filter((c) => !isCheckEnabled(c.id))

/**
 * Reverse lookup: raw scanner-category string → user-facing check label.
 * Built once at module load. Falls back to the raw string when no
 * SECURITY_CHECKS entry claims it (preserves the old "unknown category
 * doesn't disappear silently" guarantee).
 */
const RAW_CATEGORY_TO_LABEL: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const c of SECURITY_CHECKS) {
    for (const raw of c.scannerCategories) {
      m.set(raw, c.label)
    }
  }
  return m
})()

/**
 * Normalise a raw `findings[].category` string to the user-facing label
 * shown in Scan Center / Findings. Unknown raw categories pass through
 * unchanged so a brand-new scanner rule can't make findings vanish from
 * the UI.
 */
export function displayCategoryLabel(rawCategory: string): string {
  return RAW_CATEGORY_TO_LABEL.get(rawCategory) ?? rawCategory
}
