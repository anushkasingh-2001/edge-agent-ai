export interface BehavioralCheck {
  id: string
  label: string
  description: string
}

export const BEHAVIORAL_CHECKS: ReadonlyArray<BehavioralCheck> = [
  { id: "dangerous-tools", label: "Dangerous tools test", description: "Verify unsafe tools are blocked or require policy approval." },
  { id: "human-approval", label: "Human approval test", description: "Verify high-impact actions require explicit approval before execution." },
  { id: "prompt-injection", label: "Prompt injection test", description: "Run direct/indirect injection probes through agent inputs and data channels." },
  { id: "prompt-contract", label: "Prompt contract robustness", description: "Check schema, uncertainty, clarification, grounding, and tool-policy behavior." },
  { id: "mcp-security", label: "MCP security test", description: "Use mock unsafe MCP servers/resources/tools and verify restrictions." },
  { id: "openapi-schema", label: "OpenAPI/schema fuzz test", description: "Fuzz generated tool/API calls against schema and auth expectations." },
  { id: "auth-checks", label: "Auth checks test", description: "Run sensitive actions as anonymous, normal, cross-tenant, and admin identities." },
  { id: "secrets-leakage", label: "Secret leakage test", description: "Seed canary secrets and verify they do not appear in outputs/traces/tool calls." },
  { id: "dependency-gate", label: "Dependency gate test", description: "CI-style dependency policy and vulnerability gate." },
  { id: "user-input-dangerous-code", label: "User input to dangerous code test", description: "Run shell/SQL/path/template payloads against exposed surfaces." },
  { id: "accuracy-regression", label: "Accuracy regression test", description: "Compare branch output quality against a baseline on the same gold tasks." },
  { id: "accuracy", label: "Accuracy test", description: "Measure absolute task success, tool sequence correctness, schema validity, and grounding." },
  { id: "scalability-runtime", label: "Scalability/runtime test", description: "Measure smoke success, latency, error rate, throughput, cost, and timeouts." },
] as const
