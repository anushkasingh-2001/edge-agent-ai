/**
 * Shared types for the "Understand Code Workflow" feature.
 *
 * Both the server-side analyzer (lib/server-workflow.ts, executed by the
 * /api/workflow/analyze route) and the client-side renderer
 * (components/views/understand-code-workflow.tsx) import from this file so
 * the wire format stays in sync.
 *
 * NOTE: Static analysis only. The analyzer never executes user code; every
 * piece of data here comes from filesystem traversal + regex pattern
 * matching against the contents of repo files.
 */

/** Component type. Closed union so the renderer can switch on it safely. */
export type WorkflowComponentType =
  | "entrypoint"
  | "api_route"
  | "agent"
  | "graph_node"
  | "prompt"
  | "tool"
  | "model_call"
  | "mcp_server"
  | "openapi_tool"
  | "database"
  | "file_io"
  | "unknown"

/** Single detected node in the workflow graph. */
export type WorkflowComponent = {
  /** Stable id used by edges. Derived from `file` + `name` so it's repeatable. */
  id: string
  name: string
  type: WorkflowComponentType
  /** Path relative to the project root. */
  file: string
  line?: number
  description?: string
  inputs: string[]
  outputs: string[]
  /** Best guess at the framework this component belongs to (e.g. "FastAPI",
   *  "LangGraph", "Next.js"), or undefined if we couldn't tell. */
  framework?: string
  /** Free-form evidence strings (matched regex snippets, etc.) so the user
   *  can verify why we tagged something this way. */
  evidence: string[]
}

export type WorkflowEdge = {
  /** WorkflowComponent.id of the source. */
  from: string
  /** WorkflowComponent.id of the destination. */
  to: string
  /** Short label rendered on the edge in Mermaid. */
  label: string
  /** Optional human-readable trace ("imported by", "calls", "passes state…"). */
  evidence?: string
}

export type WorkflowPrompt = {
  name: string
  file: string
  line?: number
  /** First few hundred chars of the prompt so the UI can show a preview without
   *  shipping every byte of the prompt file. */
  contentPreview: string
  /** Variable names found inside the prompt template: `{language}`, `{{input}}`
   *  etc. Curly braces stripped. */
  variables: string[]
  /** Component ids that reference this prompt. */
  usedBy: string[]
}

export type WorkflowToolRiskTag =
  | "filesystem"
  | "shell"
  | "email"
  | "database_write"
  | "payment"
  | "delete_or_update"
  | "external_api"
  | "code_exec"

export type WorkflowTool = {
  name: string
  file: string
  line?: number
  parameters: string[]
  /** Things the tool body appears to do ("sends email", "calls external API"). */
  sideEffects: string[]
  /** Subset of WorkflowToolRiskTag the matcher fired on. */
  riskTags: WorkflowToolRiskTag[]
  /** Component ids that appear to call this tool. */
  usedBy: string[]
}

export type WorkflowModelCallProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "huggingface"
  | "unknown"

export type WorkflowModelCall = {
  provider: WorkflowModelCallProvider
  /** Model identifier if literal-string detectable (e.g. "gpt-4o", "claude-3-5-sonnet"). */
  model?: string
  file: string
  line?: number
  /** WorkflowPrompt.name values that this call appears to inject. */
  promptRefs: string[]
  /** Free-form evidence (matched snippets). */
  evidence: string[]
}

export type WorkflowMcpConfig = {
  file: string
  /** Top-level server names declared in the config (best-effort JSON parse). */
  servers: string[]
}

export type WorkflowOpenApiSpec = {
  file: string
  /** Title / version pulled from the spec when easy. */
  title?: string
  version?: string
  /** Operation summaries we managed to extract. */
  operations: { method: string; path: string; summary?: string }[]
}

export type WorkflowEntryPoint = {
  /** WorkflowComponent.id this entrypoint corresponds to. */
  id: string
  /** Short reason ("FastAPI app declared here", "Next.js route", "Python __main__"). */
  reason: string
  file: string
  line?: number
}

/** Top-level analysis response. The /api/workflow/analyze endpoint returns
 *  exactly this shape, JSON-serialized. */
export type WorkflowAnalysis = {
  projectName: string
  projectPath: string
  generatedAt: string
  entrypoints: WorkflowEntryPoint[]
  components: WorkflowComponent[]
  prompts: WorkflowPrompt[]
  tools: WorkflowTool[]
  modelCalls: WorkflowModelCall[]
  mcpConfigs: WorkflowMcpConfig[]
  openApiSpecs: WorkflowOpenApiSpec[]
  edges: WorkflowEdge[]
  /** Mermaid flowchart source (no <pre> wrapper). */
  mermaid: string
  /** Plain-prose explanation of the workflow. Generated from detected facts. */
  summary: string
  /** Non-fatal warnings (e.g. "Repository larger than 5000 files, sampled first N"). */
  warnings: string[]
  /** Roll-up of detection counts so the UI can render header chips quickly. */
  stats: {
    filesScanned: number
    componentsDetected: number
    promptsDetected: number
    toolsDetected: number
    modelCallsDetected: number
    durationMs: number
  }
}
