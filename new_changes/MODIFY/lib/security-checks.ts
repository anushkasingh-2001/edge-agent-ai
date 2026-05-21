export interface SecurityCheck {
  id: string
  label: string
  description: string
  scannerCategories: string[]
}

export const SECURITY_CHECKS: ReadonlyArray<SecurityCheck> = [
  {
    id: "dangerous-tools",
    label: "Dangerous tools",
    description: "Agent-callable tools that can cause real side effects",
    scannerCategories: ["Dangerous tool / side effect"],
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
    description: "Prompts missing role, tool policy, output schema, approval rules, or grounding constraints",
    scannerCategories: ["Prompt contract"],
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
    scannerCategories: ["Accuracy risk"],
  },
] as const

const RAW_CATEGORY_TO_LABEL: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const c of SECURITY_CHECKS) {
    for (const raw of c.scannerCategories) m.set(raw, c.label)
  }
  return m
})()

export function displayCategoryLabel(rawCategory: string): string {
  return RAW_CATEGORY_TO_LABEL.get(rawCategory) ?? rawCategory
}
