/**
 * Catalog of built-in security checks the user can toggle in Scan Center.
 *
 * Lives here (rather than inside `scan-center.tsx`) so other surfaces — the
 * Overview "Tests" tile, future settings screens — can count or list them
 * without duplicating the constant.
 *
 * NOTE: These IDs are *UI* check IDs, not scanner rule IDs. The mapping
 * from a UI check ID to one or more scanner rule IDs lives inside
 * `lib/scan-report.ts::resolveChecksForApi`. Keep the two lists in sync
 * when adding new categories.
 */
export interface SecurityCheck {
  id: string
  label: string
  description: string
}

export const SECURITY_CHECKS: ReadonlyArray<SecurityCheck> = [
  { id: "dangerous-tools", label: "Dangerous tools", description: "Identify risky tool invocations" },
  { id: "human-approval", label: "Missing human approval", description: "Flag actions requiring human review" },
  { id: "prompt-injection", label: "Prompt injection", description: "Detect injection vulnerabilities" },
  { id: "vague-prompts", label: "Vague prompts", description: "Find prompts that lack specificity" },
  { id: "mcp-security", label: "MCP security", description: "Audit Model Context Protocol security" },
  { id: "openapi-schema", label: "OpenAPI/schema quality", description: "Validate API schemas and specs" },
  { id: "auth-checks", label: "Auth checks", description: "Verify authentication is properly enforced" },
  { id: "secrets", label: "Hardcoded secrets", description: "Find exposed credentials and keys" },
  { id: "dependency-risks", label: "Dependency risks", description: "Check for vulnerable dependencies" },
  { id: "user-input-dangerous-code", label: "User input to dangerous code", description: "Trace unsafe data flows" },
  { id: "accuracy", label: "Accuracy regression", description: "Detect changes that may affect output quality" },
  { id: "performance", label: "Performance/runtime", description: "Monitor latency and resource usage" },
  { id: "tool-selection", label: "Tool selection correctness", description: "Verify correct tool routing" },
  { id: "smoke-tests", label: "Live smoke tests", description: "Run live validation tests" },
] as const
