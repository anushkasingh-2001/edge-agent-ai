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
export interface SecurityCheck {
  id: string
  label: string
  description: string
  /** Raw `findings[].category` strings this check owns. The Findings
   *  view normalises every finding's category to the corresponding
   *  check `label` for display + filtering. Empty array == no scanner
   *  rule emits this category yet. */
  scannerCategories: string[]
}

export const SECURITY_CHECKS: ReadonlyArray<SecurityCheck> = [
  {
    id: "dangerous-tools",
    label: "Dangerous tools",
    description: "Identify risky tool invocations",
    scannerCategories: ["Dangerous tool / side effect"],
  },
  {
    id: "human-approval",
    label: "Missing human approval",
    description: "Flag actions requiring human review",
    scannerCategories: ["Missing approval gate"],
  },
  {
    id: "prompt-injection",
    label: "Prompt injection",
    description: "Detect injection vulnerabilities",
    scannerCategories: ["Prompt injection"],
  },
  {
    id: "vague-prompts",
    label: "Vague prompts",
    description: "Find prompts that lack specificity",
    // Scanner historically emitted "Weak prompt" for the same finding type;
    // Scan Center now calls them "Vague prompts" so we map both.
    scannerCategories: ["Weak prompt", "Vague prompt"],
  },
  {
    id: "mcp-security",
    label: "MCP security",
    description: "Audit Model Context Protocol security",
    scannerCategories: ["MCP configuration"],
  },
  {
    id: "openapi-schema",
    label: "OpenAPI/schema quality",
    description: "Validate API schemas and specs",
    scannerCategories: ["OpenAPI"],
  },
  {
    id: "auth-checks",
    label: "Auth checks",
    description: "Verify authentication is properly enforced",
    scannerCategories: [],
  },
  {
    id: "secrets",
    label: "Hardcoded secrets",
    description: "Find exposed credentials and keys",
    scannerCategories: ["Hardcoded secret"],
  },
  {
    id: "dependency-risks",
    label: "Dependency risks",
    description: "Check for vulnerable dependencies",
    scannerCategories: ["Dependencies"],
  },
  {
    id: "user-input-dangerous-code",
    label: "User input to dangerous code",
    description: "Trace unsafe data flows",
    scannerCategories: ["Data flow"],
  },
  {
    id: "accuracy",
    label: "Accuracy regression",
    description: "Detect changes that may affect output quality",
    scannerCategories: [],
  },
  {
    id: "performance",
    label: "Performance/runtime",
    description: "Monitor latency and resource usage",
    scannerCategories: [],
  },
  {
    id: "tool-selection",
    label: "Tool selection correctness",
    description: "Verify correct tool routing",
    scannerCategories: [],
  },
  {
    id: "smoke-tests",
    label: "Live smoke tests",
    description: "Run live validation tests",
    scannerCategories: [],
  },
] as const

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
