/**
 * Edge Agent AI — workflow analyzer (server-side).
 *
 * Powers POST /api/workflow/analyze. Given a project path, walks the
 * repository (with strict ignore list + size cap), runs a small fleet of
 * regex-based detectors against each interesting file, and stitches the
 * findings together into a workflow graph (components + edges) plus a
 * Mermaid flowchart and a plain-prose summary.
 *
 * IMPORTANT — what this is NOT:
 *   - Not an AST parser. We deliberately stick to regex/heuristics so we can
 *     add new patterns quickly and stay sandbox-friendly. False positives are
 *     surfaced as evidence strings the user can verify.
 *   - Not a runtime tracer. Nothing in this module ever spawns user code.
 *   - Not a complete scanner replacement. The scanner has its own Python
 *     analyzer for security findings; this module is purely about
 *     "what does this codebase do and how do its pieces hang together".
 *
 * Design notes:
 *   - All output is JSON-serializable so it can be cached or piped to
 *     downstream consumers without ceremony.
 *   - Component ids are stable hashes of `<type>:<file>:<name>` so re-runs
 *     on the same code produce edges that still resolve.
 *   - Detectors are pure functions that take `(file, content, ctx)` and
 *     append to the same `WorkflowAnalysis` accumulator. They never throw —
 *     a corrupt file produces zero detections, not a 500 response.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import type {
  WorkflowAnalysis,
  WorkflowComponent,
  WorkflowComponentType,
  WorkflowEdge,
  WorkflowEntryPoint,
  WorkflowMcpConfig,
  WorkflowModelCall,
  WorkflowModelCallProvider,
  WorkflowOpenApiSpec,
  WorkflowPrompt,
  WorkflowTool,
  WorkflowToolRiskTag,
} from "@/lib/workflow-types"

/* -------------------------------------------------------------------------- */
/* Walker                                                                     */
/* -------------------------------------------------------------------------- */

/** Directories we never descend into. Mirrors the scanner ignore list, plus
 *  electron-builder's `release/` output (which mirrors `.next/standalone/` and
 *  caused the analyzer to report every API route twice). */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "release",
  ".git",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pnpm-store",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "edge-agent-output",
  ".edgeagent",
  "coverage",
  "out",
])

/** Files we *do* try to read. Anything else gets skipped at the readFile step.
 *  We intentionally keep this broad and let detectors decide what's interesting. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
])

/** Hard caps so a malicious repo can't DoS the analyzer. The numbers are
 *  generous for normal projects but bounded for pathological ones. */
const MAX_FILES_TO_READ = 4000
const MAX_FILE_BYTES = 512 * 1024 // 512 KiB per file
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 // 64 MiB aggregate

type WalkedFile = {
  /** Path relative to project root, forward-slashed. */
  rel: string
  /** Absolute path. */
  abs: string
  /** Lowercased extension including the leading dot. */
  ext: string
  /** File contents (already decoded as utf-8). */
  content: string
}

function walkRepo(
  projectPath: string,
  warnings: string[]
): { files: WalkedFile[]; filesScanned: number } {
  const results: WalkedFile[] = []
  let filesScanned = 0
  let totalBytes = 0

  // Iterative DFS so we don't blow the stack on deep dirs.
  const stack: string[] = [projectPath]
  while (stack.length > 0) {
    if (results.length >= MAX_FILES_TO_READ) {
      warnings.push(
        `Repository walk hit the ${MAX_FILES_TO_READ}-file cap; later files were not analyzed.`
      )
      break
    }
    if (totalBytes >= MAX_TOTAL_BYTES) {
      warnings.push(
        `Repository walk hit the ${Math.round(
          MAX_TOTAL_BYTES / (1024 * 1024)
        )} MiB aggregate cap; later files were not analyzed.`
      )
      break
    }
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".env.local") {
        // Skip dotfiles wholesale except a handful that hint at frameworks.
        // .git, .venv, .next, .vscode, etc. are also in IGNORED_DIRS.
        if (
          ent.name === ".github" ||
          ent.name === ".gitlab-ci.yml" ||
          ent.name === ".mcp.json"
        ) {
          // these we DO want to look at
        } else if (ent.name === ".next" || ent.name === ".git") {
          continue
        } else {
          // generic dotfile — usually noise (.DS_Store, .gitignore content, etc.)
          continue
        }
      }
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue
        stack.push(full)
        continue
      }
      if (!ent.isFile()) continue
      filesScanned += 1
      const ext = path.extname(ent.name).toLowerCase()
      if (!TEXT_FILE_EXTENSIONS.has(ext)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.size > MAX_FILE_BYTES) continue
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) continue
      let content: string
      try {
        content = fs.readFileSync(full, "utf-8")
      } catch {
        continue
      }
      totalBytes += stat.size
      const rel = path
        .relative(projectPath, full)
        .split(path.sep)
        .join("/")
      results.push({ rel, abs: full, ext, content })
    }
  }
  return { files: results, filesScanned }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function makeId(type: WorkflowComponentType, file: string, name: string): string {
  // Short, stable, collision-resistant within a single analysis run.
  const hash = crypto
    .createHash("sha1")
    .update(`${type}::${file}::${name}`)
    .digest("hex")
    .slice(0, 10)
  return `c_${type}_${hash}`
}

function lineOf(content: string, matchIndex: number): number {
  // 1-indexed line number of the byte offset.
  let line = 1
  for (let i = 0; i < matchIndex; i += 1) if (content.charCodeAt(i) === 10) line += 1
  return line
}

/**
 * Bracket-aware splitter for Python / TS function parameter lists.
 *
 * A naive `params.split(",")` mangles type annotations like
 * `Dict[str, int]` (becomes `["Dict[str", " int]"]`) which then propagates
 * garbage tokens like `int]]` into our component inputs. This walks the
 * string character-by-character and only treats a comma as a separator
 * when bracket/paren/brace depth is zero.
 */
function splitParamList(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ""
  let inStr: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inStr) {
      buf += ch
      if (ch === inStr && raw[i - 1] !== "\\") inStr = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      buf += ch
      continue
    }
    if (ch === "[" || ch === "(" || ch === "{") depth += 1
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1)
    if (ch === "," && depth === 0) {
      if (buf.trim().length > 0) out.push(buf)
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim().length > 0) out.push(buf)
  return out
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}

function clipPreview(s: string, max = 280): string {
  const trimmed = s.replace(/\s+/g, " ").trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

/** Append a component, returning the id. Dedupes by id. */
function pushComponent(
  acc: WorkflowComponent[],
  comp: WorkflowComponent
): string {
  if (!acc.some((c) => c.id === comp.id)) acc.push(comp)
  return comp.id
}

/* -------------------------------------------------------------------------- */
/* Python detectors                                                           */
/* -------------------------------------------------------------------------- */

const PY_FASTAPI_ROUTE = /@\s*(app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/g
const PY_FASTAPI_ADD_ROUTE = /\.add_api_route\s*\(\s*["']([^"']+)["']/g
const PY_FASTAPI_APP = /\b(FastAPI|APIRouter)\s*\(/g
const PY_CLASS_DEF = /^\s*class\s+([A-Z][A-Za-z0-9_]*)\s*[\(:]/gm
const PY_FUNC_DEF = /^\s*(?:async\s+)?def\s+([a-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm
const PY_OPENAI_CALL = /\b(openai\.(ChatCompletion|Completion|Image|Audio|Embeddings)\.create|OpenAI\s*\(|client\.(chat\.completions|completions|embeddings)\.create|AsyncOpenAI\s*\()\b/g
const PY_ANTHROPIC_CALL = /\b(anthropic\.Anthropic\s*\(|Anthropic\s*\(\)|messages\.create)\b/g
const PY_GEMINI_CALL = /\b(google\.generativeai|genai\.GenerativeModel|GenerativeModel\s*\()/g
const PY_OLLAMA_CALL = /\bollama\.(chat|generate|embeddings)\s*\(/g
const PY_HF_CALL = /\b(huggingface_hub|transformers\.pipeline|AutoModelForCausalLM|InferenceClient\s*\()/g
const PY_MODEL_LITERAL = /(?:model|model_name|model_id)\s*=\s*["']([^"']{2,80})["']/g
const PY_LANGCHAIN_IMPORT = /\bfrom\s+langchain(?:_[a-z_]+)?\b|\bimport\s+langchain\b/
const PY_LANGGRAPH_IMPORT = /\bfrom\s+langgraph\b|\bimport\s+langgraph\b/
const PY_LANGGRAPH_NODE = /\bgraph\.(add_node|add_edge|add_conditional_edges|set_entry_point|set_finish_point)\s*\(\s*["']([^"']+)["']?/g
const PY_LLAMA_INDEX = /\bfrom\s+llama_index\b|\bimport\s+llama_index\b/
const PY_PYDANTIC_AI = /\bfrom\s+pydantic_ai\b|\bimport\s+pydantic_ai\b|\bAgent\s*\(\s*["']openai:/
const PY_AGNO = /\bfrom\s+agno\b|\bimport\s+agno\b/
const PY_WHISPER = /\bwhisper\.load_model\s*\(|\bfrom\s+faster_whisper\b/g
const PY_DANGEROUS = {
  shell: /\b(subprocess\.(run|Popen|call|check_output)|os\.system\s*\(|os\.popen\s*\()/g,
  code_exec: /\b(eval|exec)\s*\(/g,
  filesystem: /\b(open\s*\([^)]*['"]w['"]|os\.remove|os\.unlink|shutil\.rmtree|pathlib\.[A-Za-z]+\(.+?\)\.write)/g,
  email: /\bsmtplib\b|\bsend_email\s*\(|\bsendgrid\b/gi,
  database_write: /\.(execute|executemany)\s*\(\s*["'`](INSERT|UPDATE|DELETE|DROP|ALTER)/gi,
  payment: /\b(stripe\.Charge|stripe\.PaymentIntent|refund|paypal_)/gi,
  external_api: /\b(requests\.(get|post|put|patch|delete)|httpx\.(get|post|put|patch|delete)|urllib\.request)\b/g,
}

function detectPython(
  file: WalkedFile,
  acc: WorkflowAnalysis
): void {
  if (file.ext !== ".py") return
  const { rel, content } = file

  // ---- FastAPI / APIRouter routes ------------------------------------------
  for (const m of content.matchAll(PY_FASTAPI_ROUTE)) {
    const method = m[2].toUpperCase()
    const route = m[3]
    const compId = pushComponent(acc.components, {
      id: makeId("api_route", rel, `${method} ${route}`),
      name: `${method} ${route}`,
      type: "api_route",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework: "FastAPI",
      description: `FastAPI endpoint declared in ${rel}`,
      inputs: [],
      outputs: [],
      evidence: [`@${m[1]}.${m[2]}("${route}")`],
    })
    if (acc.entrypoints.find((e) => e.id === compId) === undefined) {
      acc.entrypoints.push({
        id: compId,
        reason: `FastAPI ${method} ${route}`,
        file: rel,
        line: lineOf(content, m.index ?? 0),
      })
    }
  }
  for (const m of content.matchAll(PY_FASTAPI_ADD_ROUTE)) {
    const route = m[1]
    pushComponent(acc.components, {
      id: makeId("api_route", rel, route),
      name: route,
      type: "api_route",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework: "FastAPI",
      inputs: [],
      outputs: [],
      evidence: [`add_api_route("${route}")`],
    })
  }
  // FastAPI app declaration → entrypoint
  for (const m of content.matchAll(PY_FASTAPI_APP)) {
    const compId = pushComponent(acc.components, {
      id: makeId("entrypoint", rel, `${m[1]} app`),
      name: `${m[1]} application`,
      type: "entrypoint",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework: "FastAPI",
      inputs: ["HTTP requests"],
      outputs: ["HTTP responses"],
      evidence: [m[0]],
    })
    if (!acc.entrypoints.find((e) => e.id === compId)) {
      acc.entrypoints.push({
        id: compId,
        reason: `FastAPI/APIRouter app declared with ${m[1]}()`,
        file: rel,
        line: lineOf(content, m.index ?? 0),
      })
    }
  }

  // ---- Framework imports → tag whole file ---------------------------------
  let framework: string | undefined
  if (PY_LANGGRAPH_IMPORT.test(content)) framework = "LangGraph"
  else if (PY_LANGCHAIN_IMPORT.test(content)) framework = "LangChain"
  else if (PY_LLAMA_INDEX.test(content)) framework = "LlamaIndex"
  else if (PY_PYDANTIC_AI.test(content)) framework = "Pydantic AI"
  else if (PY_AGNO.test(content)) framework = "Agno"

  // ---- LangGraph nodes / edges --------------------------------------------
  if (PY_LANGGRAPH_IMPORT.test(content)) {
    for (const m of content.matchAll(PY_LANGGRAPH_NODE)) {
      const op = m[1]
      const name = m[2]
      if (op === "add_node") {
        pushComponent(acc.components, {
          id: makeId("graph_node", rel, name),
          name,
          type: "graph_node",
          file: rel,
          line: lineOf(content, m.index ?? 0),
          framework: "LangGraph",
          inputs: ["state"],
          outputs: ["state"],
          evidence: [`graph.add_node("${name}", …)`],
        })
      }
      // We don't try to wire add_edge → edges here because the second arg is
      // often a variable; the summary edges step does that with imports.
    }
  }

  // ---- Classes that look like agents / tools / chains / workflows ----------
  for (const m of content.matchAll(PY_CLASS_DEF)) {
    const name = m[1]
    const lower = name.toLowerCase()
    let type: WorkflowComponentType | null = null
    if (
      lower.endsWith("agent") ||
      lower.includes("transcrib") ||
      lower.includes("summari")
    ) {
      type = "agent"
    } else if (lower.endsWith("tool")) {
      type = "tool"
    } else if (
      lower.endsWith("chain") ||
      lower.endsWith("graph") ||
      lower.endsWith("workflow") ||
      lower.endsWith("pipeline")
    ) {
      type = "graph_node"
    }
    if (!type) continue
    pushComponent(acc.components, {
      id: makeId(type, rel, name),
      name,
      type,
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework,
      inputs: [],
      outputs: [],
      evidence: [`class ${name}`],
    })
  }

  // ---- Standalone tool-shaped functions -----------------------------------
  // Heuristic: top-level `def` whose name contains a strong verb that suggests
  // I/O / side effects, OR a function with a docstring tag like `@tool`.
  const toolVerbs =
    /^(send|fetch|update|delete|create|process|notify|refund|charge|run|execute|call|invoke|scrape|query|search)_/
  for (const m of content.matchAll(PY_FUNC_DEF)) {
    const name = m[1]
    if (name.startsWith("_")) continue
    if (!toolVerbs.test(name)) continue
    // `splitParamList` is bracket-aware so type annotations like
    // `Dict[str, int]` aren't split mid-generic — without this we used to
    // produce phantom params like `int]]` or `str]` which then collided
    // as React keys downstream.
    const params = uniq(
      splitParamList(m[2])
        .map((p) => p.split(":")[0].split("=")[0].trim())
        .filter(
          (p) =>
            p.length > 0 &&
            p !== "self" &&
            p !== "cls" &&
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(p)
        )
    )
    const tool: WorkflowTool = {
      name,
      file: rel,
      line: lineOf(content, m.index ?? 0),
      parameters: params,
      sideEffects: [],
      riskTags: [],
      usedBy: [],
    }
    // Scan THIS function body cheaply: take the substring from the def to the
    // next top-level def or end of file, look for danger patterns.
    const start = m.index ?? 0
    const tailEnd = (() => {
      // crude: next /^def / or /^class /
      const m2 = content.slice(start + 1).search(/^(def\s|class\s|@app\.|@router\.)/m)
      return m2 === -1 ? content.length : start + 1 + m2
    })()
    const body = content.slice(start, tailEnd)
    for (const [tag, rx] of Object.entries(PY_DANGEROUS)) {
      const found = Array.from(body.matchAll(rx))
      if (found.length > 0) {
        tool.riskTags.push(tag as WorkflowToolRiskTag)
        tool.sideEffects.push(`${tag}: ${clipPreview(found[0][0], 80)}`)
      }
    }
    acc.tools.push(tool)
    // Also surface it as a tool component so it shows up in the graph.
    pushComponent(acc.components, {
      id: makeId("tool", rel, name),
      name,
      type: "tool",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework,
      inputs: params,
      outputs: [],
      evidence: [`def ${name}(${m[2].trim()})`],
    })
  }

  // ---- Model calls (provider attribution) ----------------------------------
  const recordModelCall = (
    provider: WorkflowModelCallProvider,
    matchIdx: number,
    snippet: string
  ): void => {
    const line = lineOf(content, matchIdx)
    // Try to find a `model=` literal within a 400-byte window so we can tag
    // the actual model name without parsing.
    const window = content.slice(Math.max(0, matchIdx - 200), matchIdx + 400)
    let model: string | undefined
    for (const mm of window.matchAll(PY_MODEL_LITERAL)) {
      const candidate = mm[1]
      if (candidate.length > 0) {
        model = candidate
        break
      }
    }
    acc.modelCalls.push({
      provider,
      model,
      file: rel,
      line,
      promptRefs: [],
      evidence: [clipPreview(snippet, 120)],
    })
    pushComponent(acc.components, {
      id: makeId("model_call", rel, `${provider}:${model ?? line}`),
      name: model ? `${provider} (${model})` : `${provider} call`,
      type: "model_call",
      file: rel,
      line,
      framework: provider === "openai" ? "OpenAI" : provider,
      inputs: ["prompt"],
      outputs: ["completion"],
      evidence: [clipPreview(snippet, 120)],
    })
  }
  for (const m of content.matchAll(PY_OPENAI_CALL)) recordModelCall("openai", m.index ?? 0, m[0])
  for (const m of content.matchAll(PY_ANTHROPIC_CALL)) recordModelCall("anthropic", m.index ?? 0, m[0])
  for (const m of content.matchAll(PY_GEMINI_CALL)) recordModelCall("gemini", m.index ?? 0, m[0])
  for (const m of content.matchAll(PY_OLLAMA_CALL)) recordModelCall("ollama", m.index ?? 0, m[0])
  for (const m of content.matchAll(PY_HF_CALL)) recordModelCall("huggingface", m.index ?? 0, m[0])
  for (const m of content.matchAll(PY_WHISPER)) {
    pushComponent(acc.components, {
      id: makeId("model_call", rel, "whisper"),
      name: "Whisper (local)",
      type: "model_call",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework: "Whisper",
      inputs: ["audio path"],
      outputs: ["transcript"],
      evidence: [m[0]],
    })
  }

  // ---- __main__ entrypoint -------------------------------------------------
  if (/if\s+__name__\s*==\s*["']__main__["']\s*:/.test(content)) {
    const mIdx = content.search(/if\s+__name__\s*==\s*["']__main__["']\s*:/)
    const compId = pushComponent(acc.components, {
      id: makeId("entrypoint", rel, "__main__"),
      name: `${path.basename(rel)} (__main__)`,
      type: "entrypoint",
      file: rel,
      line: lineOf(content, mIdx),
      framework: framework ?? "Python",
      inputs: ["argv"],
      outputs: [],
      evidence: [`if __name__ == "__main__":`],
    })
    if (!acc.entrypoints.find((e) => e.id === compId)) {
      acc.entrypoints.push({
        id: compId,
        reason: "Python __main__ guard",
        file: rel,
        line: lineOf(content, mIdx),
      })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* TypeScript / JavaScript detectors                                          */
/* -------------------------------------------------------------------------- */

const TS_NEXT_ROUTE_HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g
const TS_EXPRESS_ROUTE = /\b(app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g
const TS_NEXT_API_PAGES = /export\s+default\s+(?:async\s+)?function\s+handler\b/
const TS_OPENAI_SDK = /\bnew\s+OpenAI\s*\(|openai\.chat\.completions\.create\b|openai\.completions\.create\b/g
const TS_ANTHROPIC_SDK = /\bnew\s+Anthropic\s*\(|anthropic\.messages\.create\b/g
const TS_GEMINI_SDK = /\bnew\s+GoogleGenerativeAI\s*\(/g
const TS_LANGCHAIN_IMPORT = /from\s+["']@?langchain/
const TS_LANGGRAPH_IMPORT = /from\s+["']@?langchain\/langgraph|from\s+["']@?langgraph/
const TS_CLASS_DEF = /\bclass\s+([A-Z][A-Za-z0-9_]*)\b/g
const TS_MODEL_LITERAL = /\bmodel\s*:\s*["']([^"']{2,80})["']/g
const TS_TOOL_DEF = /\b(?:export\s+)?(?:const|function|async\s+function)\s+([a-zA-Z_][\w]*)\s*[:=]?\s*(?:tool|defineTool|new\s+DynamicTool)\b/g

function detectTypeScript(
  file: WalkedFile,
  acc: WorkflowAnalysis
): void {
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(file.ext)) return
  const { rel, content } = file

  // ---- Next.js app-router route handlers ----------------------------------
  // Heuristic: file lives under /api/ and exports any of GET/POST/...
  const isApiRoute =
    /\/api\//.test(rel) &&
    /\/route\.(ts|js|tsx|jsx)$/.test(rel) &&
    TS_NEXT_ROUTE_HANDLER.test(content)
  if (isApiRoute) {
    // Re-iterate (regex global state already consumed).
    for (const m of content.matchAll(
      /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g
    )) {
      const method = m[1]
      const route = rel
        .replace(/^app\//, "/")
        .replace(/^\//, "/")
        .replace(/\/route\.(ts|js|tsx|jsx)$/, "")
      const compId = pushComponent(acc.components, {
        id: makeId("api_route", rel, `${method} ${route}`),
        name: `${method} ${route}`,
        type: "api_route",
        file: rel,
        line: lineOf(content, m.index ?? 0),
        framework: "Next.js",
        inputs: [],
        outputs: [],
        evidence: [`export async function ${method}(…)`],
      })
      if (!acc.entrypoints.find((e) => e.id === compId)) {
        acc.entrypoints.push({
          id: compId,
          reason: `Next.js ${method} ${route}`,
          file: rel,
          line: lineOf(content, m.index ?? 0),
        })
      }
    }
  }

  // ---- Next.js pages-router handlers ---------------------------------------
  if (/\/pages\/api\//.test(rel) && TS_NEXT_API_PAGES.test(content)) {
    const route = rel.replace(/^pages/, "").replace(/\.(ts|js|tsx|jsx)$/, "")
    pushComponent(acc.components, {
      id: makeId("api_route", rel, route),
      name: route,
      type: "api_route",
      file: rel,
      framework: "Next.js (pages)",
      inputs: [],
      outputs: [],
      evidence: [`export default handler in ${rel}`],
    })
  }

  // ---- Express routes ------------------------------------------------------
  for (const m of content.matchAll(TS_EXPRESS_ROUTE)) {
    const method = m[2].toUpperCase()
    const route = m[3]
    pushComponent(acc.components, {
      id: makeId("api_route", rel, `${method} ${route}`),
      name: `${method} ${route}`,
      type: "api_route",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework: "Express",
      inputs: [],
      outputs: [],
      evidence: [m[0]],
    })
  }

  // ---- Framework hints -----------------------------------------------------
  let framework: string | undefined
  if (TS_LANGGRAPH_IMPORT.test(content)) framework = "LangGraph (JS)"
  else if (TS_LANGCHAIN_IMPORT.test(content)) framework = "LangChain (JS)"

  // ---- Classes ending in Agent / Tool etc. --------------------------------
  for (const m of content.matchAll(TS_CLASS_DEF)) {
    const name = m[1]
    const lower = name.toLowerCase()
    let type: WorkflowComponentType | null = null
    if (lower.endsWith("agent")) type = "agent"
    else if (lower.endsWith("tool")) type = "tool"
    else if (
      lower.endsWith("chain") ||
      lower.endsWith("graph") ||
      lower.endsWith("workflow")
    )
      type = "graph_node"
    if (!type) continue
    pushComponent(acc.components, {
      id: makeId(type, rel, name),
      name,
      type,
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework,
      inputs: [],
      outputs: [],
      evidence: [`class ${name}`],
    })
  }

  // ---- Tool-style declarations -------------------------------------------
  for (const m of content.matchAll(TS_TOOL_DEF)) {
    const name = m[1]
    acc.tools.push({
      name,
      file: rel,
      line: lineOf(content, m.index ?? 0),
      parameters: [],
      sideEffects: [],
      riskTags: [],
      usedBy: [],
    })
    pushComponent(acc.components, {
      id: makeId("tool", rel, name),
      name,
      type: "tool",
      file: rel,
      line: lineOf(content, m.index ?? 0),
      framework,
      inputs: [],
      outputs: [],
      evidence: [clipPreview(m[0], 80)],
    })
  }

  // ---- Model calls ---------------------------------------------------------
  const recordModelCall = (
    provider: WorkflowModelCallProvider,
    matchIdx: number,
    snippet: string
  ): void => {
    const window = content.slice(Math.max(0, matchIdx - 200), matchIdx + 400)
    let model: string | undefined
    for (const mm of window.matchAll(TS_MODEL_LITERAL)) {
      model = mm[1]
      break
    }
    acc.modelCalls.push({
      provider,
      model,
      file: rel,
      line: lineOf(content, matchIdx),
      promptRefs: [],
      evidence: [clipPreview(snippet, 120)],
    })
    pushComponent(acc.components, {
      id: makeId("model_call", rel, `${provider}:${model ?? matchIdx}`),
      name: model ? `${provider} (${model})` : `${provider} call`,
      type: "model_call",
      file: rel,
      line: lineOf(content, matchIdx),
      framework: provider === "openai" ? "OpenAI" : provider,
      inputs: ["prompt"],
      outputs: ["completion"],
      evidence: [clipPreview(snippet, 120)],
    })
  }
  for (const m of content.matchAll(TS_OPENAI_SDK)) recordModelCall("openai", m.index ?? 0, m[0])
  for (const m of content.matchAll(TS_ANTHROPIC_SDK)) recordModelCall("anthropic", m.index ?? 0, m[0])
  for (const m of content.matchAll(TS_GEMINI_SDK)) recordModelCall("gemini", m.index ?? 0, m[0])
}

/* -------------------------------------------------------------------------- */
/* Prompt detector                                                            */
/* -------------------------------------------------------------------------- */

// `{var}`, `{{var}}`, or `{var.attr}`. Stripped to the bare identifier.
const PROMPT_VAR_BRACE = /\{\{?\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}?\}/g

// Variable assignments whose name *or* value smells like a prompt. The
// previous version only matched the literal token "prompt" / "system" / a
// handful of caps; on a Whisper meeting-summarizer repo that meant the
// canonical `MEETING_SUMMARY_PROMPT`, `multilingual_template`, etc. all
// slipped through and the UI showed "0 prompts". We now match either:
//   1. var names containing `prompt`, `template`, `instruction`, `system`,
//      `message`, or `role` (case-insensitive); OR
//   2. any triple-quoted string body — those are almost always prompts in
//      practice (we filter by length after the match).
const PROMPT_INLINE_STR =
  /([A-Za-z_][\w]*?(?:prompt|template|instruction|system|messages?|role)[\w]*)\s*[:=]\s*(f?"""[\s\S]+?"""|f?'''[\s\S]+?'''|f?["'][^"'\n]{40,}["'])/gi

// Triple-quoted strings anywhere, used as a fallback so we still spot
// prompt-shaped blocks named in unusual ways.
const TRIPLE_QUOTED = /(f?"""[\s\S]{60,}?"""|f?'''[\s\S]{60,}?''')/g

// OpenAI / Anthropic-style `messages=[{"role": "...", "content": "..."}]`
// where the content blob is the prompt. We capture the role + content.
const MESSAGES_BLOCK =
  /\{\s*["']role["']\s*:\s*["'](system|user|assistant|developer)["']\s*,\s*["']content["']\s*:\s*("""[\s\S]+?"""|'''[\s\S]+?'''|["'][^"'\n]+["'])\s*\}/g

/** Cheap "does this string look like a prompt body?" test. Used to filter
 *  out triple-quoted blocks that are clearly docstrings or test fixtures. */
function looksLikePromptBody(s: string): boolean {
  if (s.length < 40) return false
  // Skip docstrings/comments that start with markdown table sigils etc.
  if (/^[\s>#-]+/.test(s) && s.length < 200) return false
  // Strong positive signals.
  if (/\byou are\b/i.test(s)) return true
  if (/<\s*(system|user|assistant|context|input|output)/i.test(s)) return true
  if (/\b(instructions?|task|role|step\s*\d+|return\s+a|respond\s+in|output\s+format)\b/i.test(s))
    return true
  if (/\{[a-zA-Z_][\w.]*\}/.test(s)) return true // has template vars
  // Weak fallback: long enough + multiple sentences.
  return s.length > 120 && /[.!?]\s+[A-Z]/.test(s)
}

function detectPrompts(file: WalkedFile, acc: WorkflowAnalysis): void {
  const { rel, content } = file
  // Tracks character ranges we've already turned into a prompt so the
  // TRIPLE_QUOTED fallback doesn't double-count the same string.
  const consumed: Array<[number, number]> = []
  const isConsumed = (start: number): boolean =>
    consumed.some(([s, e]) => start >= s && start < e)

  // 1. Prompt FILES — .md / .txt under prompts/ or named *prompt*.
  const lower = rel.toLowerCase()
  const looksLikePromptFile =
    (file.ext === ".md" || file.ext === ".mdx" || file.ext === ".txt") &&
    (lower.includes("/prompt") ||
      lower.startsWith("prompt") ||
      /prompt/.test(path.basename(lower)) ||
      /instruction|system/.test(path.basename(lower)))
  if (looksLikePromptFile) {
    const variables = uniq(
      Array.from(content.matchAll(PROMPT_VAR_BRACE)).map((m) => m[1])
    )
    const name = path.basename(rel).replace(/\.(md|mdx|txt)$/i, "")
    acc.prompts.push({
      name,
      file: rel,
      contentPreview: clipPreview(content, 400),
      variables,
      usedBy: [],
    })
    pushComponent(acc.components, {
      id: makeId("prompt", rel, name),
      name,
      type: "prompt",
      file: rel,
      inputs: variables,
      outputs: [],
      evidence: [`Prompt file at ${rel}`],
    })
  }

  // 2. INLINE prompt-shaped Python/TS strings (named).
  if (file.ext === ".py" || file.ext === ".ts" || file.ext === ".tsx" || file.ext === ".js") {
    for (const m of content.matchAll(PROMPT_INLINE_STR)) {
      const varName = m[1]
      const body = m[2]
      const cleaned = body.replace(/^f?("""|''')|("""|''')$|^f?["']|["']$/g, "")
      if (cleaned.length < 20) continue
      const variables = uniq(
        Array.from(cleaned.matchAll(PROMPT_VAR_BRACE)).map((mm) => mm[1])
      )
      const lineNo = lineOf(content, m.index ?? 0)
      acc.prompts.push({
        name: `${varName} @ ${path.basename(rel)}:${lineNo}`,
        file: rel,
        line: lineNo,
        contentPreview: clipPreview(cleaned, 280),
        variables,
        usedBy: [],
      })
      pushComponent(acc.components, {
        id: makeId("prompt", rel, `${varName}@${lineNo}`),
        name: `${varName} (${path.basename(rel)}:${lineNo})`,
        type: "prompt",
        file: rel,
        line: lineNo,
        inputs: variables,
        outputs: ["prompt text"],
        evidence: [clipPreview(body, 120)],
      })
      const start = m.index ?? 0
      consumed.push([start, start + m[0].length])
    }
  }

  // 3. messages=[{"role": "system", "content": "…"}] style.
  if (file.ext === ".py" || /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) {
    for (const m of content.matchAll(MESSAGES_BLOCK)) {
      const role = m[1]
      const body = m[2]
      const cleaned = body.replace(/^("""|''')|("""|''')$|^["']|["']$/g, "")
      if (cleaned.length < 20) continue
      const lineNo = lineOf(content, m.index ?? 0)
      const name = `${role} message @ ${path.basename(rel)}:${lineNo}`
      acc.prompts.push({
        name,
        file: rel,
        line: lineNo,
        contentPreview: clipPreview(cleaned, 280),
        variables: uniq(
          Array.from(cleaned.matchAll(PROMPT_VAR_BRACE)).map((mm) => mm[1])
        ),
        usedBy: [],
      })
      pushComponent(acc.components, {
        id: makeId("prompt", rel, `${role}@${lineNo}`),
        name,
        type: "prompt",
        file: rel,
        line: lineNo,
        inputs: [],
        outputs: ["prompt text"],
        evidence: [clipPreview(body, 120)],
      })
      const start = m.index ?? 0
      consumed.push([start, start + m[0].length])
    }
  }

  // 4. FALLBACK: long triple-quoted strings that *look* like prompts but
  //    didn't match the named pattern above (e.g. assigned through a
  //    return statement, or used positionally). Filtered by heuristics
  //    so docstrings don't pollute the inventory.
  if (file.ext === ".py") {
    for (const m of content.matchAll(TRIPLE_QUOTED)) {
      const start = m.index ?? 0
      if (isConsumed(start)) continue
      // Skip docstrings: triple-quote immediately follows `def ` or `class `
      // signature line + newline + indent + opening quote (cheap check: is
      // the preceding non-whitespace one of `:` `(`?).
      const prevChar = content.slice(Math.max(0, start - 8), start).trimEnd().slice(-1)
      if (prevChar === ":" || prevChar === "(") continue
      const raw = m[1]
      const cleaned = raw.replace(/^f?("""|''')|("""|''')$/g, "")
      if (!looksLikePromptBody(cleaned)) continue
      const lineNo = lineOf(content, start)
      const name = `prompt @ ${path.basename(rel)}:${lineNo}`
      acc.prompts.push({
        name,
        file: rel,
        line: lineNo,
        contentPreview: clipPreview(cleaned, 280),
        variables: uniq(
          Array.from(cleaned.matchAll(PROMPT_VAR_BRACE)).map((mm) => mm[1])
        ),
        usedBy: [],
      })
      pushComponent(acc.components, {
        id: makeId("prompt", rel, `inline@${lineNo}`),
        name,
        type: "prompt",
        file: rel,
        line: lineNo,
        inputs: [],
        outputs: ["prompt text"],
        evidence: [clipPreview(raw, 120)],
      })
      consumed.push([start, start + m[0].length])
    }
  }
}

/* -------------------------------------------------------------------------- */
/* MCP / OpenAPI detector                                                     */
/* -------------------------------------------------------------------------- */

function detectMcpAndOpenApi(file: WalkedFile, acc: WorkflowAnalysis): void {
  const name = path.basename(file.rel).toLowerCase()

  // ----- MCP configs --------------------------------------------------------
  const isMcpFile =
    name === "mcp.json" ||
    name === ".mcp.json" ||
    /^mcp\.config\./.test(name) ||
    name === "claude_desktop_config.json"
  if (isMcpFile) {
    let servers: string[] = []
    try {
      const parsed: any = JSON.parse(file.content)
      const root = parsed?.mcpServers ?? parsed?.servers ?? parsed ?? {}
      if (root && typeof root === "object") {
        servers = Object.keys(root).filter((k) => typeof root[k] === "object")
      }
    } catch {
      // unparseable — still surface the file
    }
    acc.mcpConfigs.push({ file: file.rel, servers })
    for (const s of servers) {
      pushComponent(acc.components, {
        id: makeId("mcp_server", file.rel, s),
        name: s,
        type: "mcp_server",
        file: file.rel,
        framework: "MCP",
        inputs: ["tool calls"],
        outputs: ["tool results"],
        evidence: [`MCP server "${s}" in ${name}`],
      })
    }
  }

  // ----- OpenAPI specs ------------------------------------------------------
  const isOpenApiFile =
    name === "openapi.json" ||
    name === "openapi.yaml" ||
    name === "openapi.yml" ||
    name === "swagger.json" ||
    name === "swagger.yaml"
  if (isOpenApiFile) {
    const spec: WorkflowOpenApiSpec = { file: file.rel, operations: [] }
    try {
      let doc: any
      if (file.ext === ".json") doc = JSON.parse(file.content)
      else {
        // very rough YAML title/version extractor — full parser would need
        // the `yaml` dep, which is already in package.json. We could pull it
        // in lazily here later; for MVP, just regex.
        const titleM = file.content.match(/^\s*title\s*:\s*(.+)$/m)
        const versionM = file.content.match(/^\s*version\s*:\s*(.+)$/m)
        doc = {
          info: {
            title: titleM ? titleM[1].trim().replace(/["']/g, "") : undefined,
            version: versionM ? versionM[1].trim().replace(/["']/g, "") : undefined,
          },
          paths: {},
        }
      }
      spec.title = doc?.info?.title
      spec.version = doc?.info?.version
      const paths = doc?.paths ?? {}
      for (const [p, methods] of Object.entries(paths)) {
        if (!methods || typeof methods !== "object") continue
        for (const [method, op] of Object.entries(methods as Record<string, any>)) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
          spec.operations.push({
            method: method.toUpperCase(),
            path: p,
            summary: (op as any)?.summary,
          })
        }
      }
    } catch {
      /* tolerate malformed specs */
    }
    acc.openApiSpecs.push(spec)
    pushComponent(acc.components, {
      id: makeId("openapi_tool", file.rel, spec.title ?? name),
      name: spec.title ?? name,
      type: "openapi_tool",
      file: file.rel,
      framework: "OpenAPI",
      inputs: spec.operations.map((o) => `${o.method} ${o.path}`),
      outputs: [],
      evidence: [`OpenAPI spec at ${file.rel}`],
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Edge inference                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Edges we can derive cheaply from text:
 *  - api_route → model_call / tool / agent in the same file
 *  - agent → tool / model_call in the same file
 *  - entrypoint → api_route in the same file
 *  - model_call → prompt if a prompt component shares the same file
 *  - any → mcp_server / openapi_tool when imports / config mention them
 */
function inferEdges(acc: WorkflowAnalysis): void {
  const byFile = new Map<string, WorkflowComponent[]>()
  for (const c of acc.components) {
    const arr = byFile.get(c.file) ?? []
    arr.push(c)
    byFile.set(c.file, arr)
  }

  const addEdge = (e: WorkflowEdge): void => {
    if (e.from === e.to) return
    if (
      !acc.edges.some(
        (existing) =>
          existing.from === e.from &&
          existing.to === e.to &&
          existing.label === e.label
      )
    )
      acc.edges.push(e)
  }

  for (const comps of byFile.values()) {
    const entrypoints = comps.filter((c) => c.type === "entrypoint")
    const routes = comps.filter((c) => c.type === "api_route")
    const agents = comps.filter((c) => c.type === "agent")
    const tools = comps.filter((c) => c.type === "tool")
    const prompts = comps.filter((c) => c.type === "prompt")
    const calls = comps.filter((c) => c.type === "model_call")
    const nodes = comps.filter((c) => c.type === "graph_node")

    // entrypoint → route
    for (const ep of entrypoints) {
      for (const r of routes)
        addEdge({ from: ep.id, to: r.id, label: "serves", evidence: "same file" })
    }
    // route → agent → model_call / tool
    for (const r of routes) {
      for (const a of agents)
        addEdge({ from: r.id, to: a.id, label: "invokes", evidence: "same file" })
      for (const c of calls)
        addEdge({ from: r.id, to: c.id, label: "calls", evidence: "same file" })
      for (const t of tools)
        addEdge({ from: r.id, to: t.id, label: "uses", evidence: "same file" })
    }
    for (const a of agents) {
      for (const c of calls)
        addEdge({ from: a.id, to: c.id, label: "calls", evidence: "same file" })
      for (const t of tools)
        addEdge({ from: a.id, to: t.id, label: "uses", evidence: "same file" })
    }
    // model_call → prompt
    for (const c of calls)
      for (const p of prompts)
        addEdge({ from: p.id, to: c.id, label: "feeds", evidence: "same file" })
    // graph nodes → calls / tools
    for (const n of nodes) {
      for (const c of calls)
        addEdge({ from: n.id, to: c.id, label: "calls", evidence: "same file" })
      for (const t of tools)
        addEdge({ from: n.id, to: t.id, label: "uses", evidence: "same file" })
    }
  }

  // Cross-file inference is intentionally minimal in the MVP: too many false
  // positives without proper import resolution.
}

/* -------------------------------------------------------------------------- */
/* Prompt/Tool ↔ component back-references                                    */
/* -------------------------------------------------------------------------- */

function linkPromptsAndTools(acc: WorkflowAnalysis): void {
  // Map prompt name → component id (when a prompt component exists)
  const promptCompByName = new Map<string, string>()
  for (const c of acc.components) {
    if (c.type === "prompt") promptCompByName.set(c.name, c.id)
  }

  for (const p of acc.prompts) {
    // usedBy = components in the same file that aren't this prompt
    p.usedBy = uniq(
      acc.components
        .filter((c) => c.file === p.file && c.type !== "prompt")
        .map((c) => c.id)
    )
  }
  for (const t of acc.tools) {
    t.usedBy = uniq(
      acc.components
        .filter((c) => c.file === t.file && c.type !== "tool")
        .map((c) => c.id)
    )
  }
  // promptRefs on model calls: same-file prompts are likely candidates
  for (const m of acc.modelCalls) {
    m.promptRefs = uniq(
      acc.prompts.filter((p) => p.file === m.file).map((p) => p.name)
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Mermaid generator                                                          */
/* -------------------------------------------------------------------------- */

// Mermaid node shapes. Each entry is the *bracket* pair around a
// double-quoted label that we append separately, so e.g. `prompt` becomes
// `id>"label"]`. Shapes that are syntactically picky (asymmetric `>…]`,
// trapezoid `[/…\]`) get normalized to safer variants here — we used to ship
// a `>"` / `"]` pair for prompts which doubled the quotes and broke parsing.
const MERMAID_SHAPE: Record<WorkflowComponentType, [string, string]> = {
  entrypoint: ["(", ")"],
  api_route: ["[/", "/]"],
  agent: ["[[", "]]"],
  graph_node: ["{{", "}}"],
  prompt: [">", "]"],
  tool: ["[(", ")]"],
  model_call: ["{{", "}}"],
  mcp_server: ["[/", "/]"],
  openapi_tool: ["[/", "/]"],
  database: ["[(", ")]"],
  file_io: ["[(", ")]"],
  unknown: ["[", "]"],
}

function escapeMermaidLabel(s: string): string {
  // Mermaid is finicky about quote characters and parentheses inside labels.
  // We coerce them to safe equivalents and clip to keep nodes readable.
  return s
    .replace(/"/g, "'")
    .replace(/\(/g, "[")
    .replace(/\)/g, "]")
    .replace(/[\n\r]/g, " ")
    .slice(0, 48)
}

/**
 * Build a high-level Mermaid diagram from the analysis.
 *
 * The earlier version emitted one node per component — for a 33-component
 * repo that produced a flowchart so dense it rendered at single-pixel font
 * size. This version is opinionated:
 *
 *   - **Group with subgraphs** (Entry / API routes / Workflow components /
 *     Tools / LLM / External services) so the user can scan the structure
 *     at a glance.
 *   - **Drop noise** — individual prompts and individual model_call
 *     invocations are aggregated into a single "Prompts" / per-provider
 *     "LLM" bucket; full detail remains in the inventory tabs.
 *   - **Shorter labels** — subgraph headings already convey type, so node
 *     labels are just the name + (file:line in a comment for accessibility).
 *   - **LR direction** — flow reads naturally left-to-right; combined with
 *     `useMaxWidth: false` on the renderer the diagram can stretch and
 *     scroll instead of cramming.
 *   - **Risky tools highlighted** with a Mermaid `classDef`.
 */
function buildMermaid(acc: WorkflowAnalysis): string {
  if (acc.components.length === 0) {
    return [
      "flowchart LR",
      '  empty["No workflow components detected.\\nTry a richer agent repo."]',
    ].join("\n")
  }

  // ---- Bucketize -----------------------------------------------------------
  const entries = acc.components.filter((c) => c.type === "entrypoint")
  const routes = acc.components.filter((c) => c.type === "api_route")
  const agents = acc.components.filter(
    (c) => c.type === "agent" || c.type === "graph_node"
  )
  const tools = acc.components.filter((c) => c.type === "tool")
  const externals = acc.components.filter(
    (c) => c.type === "mcp_server" || c.type === "openapi_tool"
  )

  // LLM bucket: one node per unique provider — dedup so we don't have 30
  // openai dots stacked on top of each other.
  type LLMNode = { id: string; label: string }
  const llmNodes: LLMNode[] = []
  const llmSeen = new Set<string>()
  for (const m of acc.modelCalls) {
    const key = `${m.provider}:${m.model ?? "?"}`
    if (llmSeen.has(key)) continue
    llmSeen.add(key)
    const id = makeId(
      "model_call",
      "(aggregate)",
      key
    )
    llmNodes.push({
      id,
      label: m.model ? `${m.provider} (${m.model})` : `${m.provider}`,
    })
  }

  // Prompts: aggregate into ONE node if there are >2 — otherwise the
  // diagram becomes unreadable.
  const promptComponents = acc.components.filter((c) => c.type === "prompt")
  const aggregatePrompts = promptComponents.length > 2
  const promptAggregateId = aggregatePrompts
    ? makeId("prompt", "(aggregate)", "all-prompts")
    : null

  // Per-section caps so a single section can't drown the others.
  const SECTION_CAP = 10
  const cap = <T extends { name: string }>(xs: T[]): T[] => xs.slice(0, SECTION_CAP)
  const remainder = <T,>(xs: T[]): number =>
    Math.max(0, xs.length - SECTION_CAP)

  // ---- Build the source ---------------------------------------------------
  const lines: string[] = []
  lines.push("flowchart LR")
  // classDefs for visual differentiation. `entry` greens-out the start node,
  // `risky` reds-out dangerous tools.
  lines.push(
    "  classDef entry fill:#065f46,stroke:#10b981,color:#fff",
    "  classDef route fill:#1e3a8a,stroke:#60a5fa,color:#fff",
    "  classDef agent fill:#4c1d95,stroke:#a78bfa,color:#fff",
    "  classDef tool fill:#7c2d12,stroke:#fb923c,color:#fff",
    "  classDef risky fill:#7f1d1d,stroke:#f87171,color:#fff,stroke-width:2px",
    "  classDef llm fill:#581c87,stroke:#e879f9,color:#fff",
    "  classDef ext fill:#155e75,stroke:#67e8f9,color:#fff",
    "  classDef prompt fill:#78350f,stroke:#fbbf24,color:#fff"
  )

  // -- Entry subgraph -------------------------------------------------------
  if (entries.length > 0) {
    lines.push(`  subgraph SG_entry["Entry"]`)
    lines.push(`    direction TB`)
    for (const e of cap(entries))
      lines.push(`    ${e.id}(["${escapeMermaidLabel(e.name)}"])`)
    if (remainder(entries) > 0)
      lines.push(
        `    SG_entry_more["+${remainder(entries)} more"]`
      )
    lines.push(`  end`)
    for (const e of cap(entries)) lines.push(`  class ${e.id} entry`)
  }

  // -- API routes -----------------------------------------------------------
  if (routes.length > 0) {
    lines.push(`  subgraph SG_routes["API routes (${routes.length})"]`)
    lines.push(`    direction TB`)
    for (const r of cap(routes))
      lines.push(`    ${r.id}[/"${escapeMermaidLabel(r.name)}"/]`)
    if (remainder(routes) > 0)
      lines.push(`    SG_routes_more["+${remainder(routes)} more"]`)
    lines.push(`  end`)
    for (const r of cap(routes)) lines.push(`  class ${r.id} route`)
  }

  // -- Workflow components (agents + graph nodes) ---------------------------
  if (agents.length > 0) {
    lines.push(`  subgraph SG_agents["Workflow components (${agents.length})"]`)
    lines.push(`    direction TB`)
    for (const a of cap(agents))
      lines.push(`    ${a.id}[["${escapeMermaidLabel(a.name)}"]]`)
    if (remainder(agents) > 0)
      lines.push(`    SG_agents_more["+${remainder(agents)} more"]`)
    lines.push(`  end`)
    for (const a of cap(agents)) lines.push(`  class ${a.id} agent`)
  }

  // -- Tools ----------------------------------------------------------------
  if (tools.length > 0) {
    lines.push(`  subgraph SG_tools["Tools (${tools.length})"]`)
    lines.push(`    direction TB`)
    for (const t of cap(tools)) {
      lines.push(`    ${t.id}[("${escapeMermaidLabel(t.name)}")]`)
    }
    if (remainder(tools) > 0)
      lines.push(`    SG_tools_more["+${remainder(tools)} more"]`)
    lines.push(`  end`)
    // Highlight risky tools differently from normal ones.
    for (const t of cap(tools)) {
      const matchingTool = acc.tools.find(
        (x) => x.file === t.file && x.name === t.name
      )
      const risky = matchingTool && matchingTool.riskTags.length > 0
      lines.push(`  class ${t.id} ${risky ? "risky" : "tool"}`)
    }
  }

  // -- LLM bucket -----------------------------------------------------------
  if (llmNodes.length > 0 || aggregatePrompts) {
    lines.push(
      `  subgraph SG_llm["LLM layer${acc.modelCalls.length > 0 ? ` (${acc.modelCalls.length} calls)` : ""}"]`
    )
    lines.push(`    direction TB`)
    for (const n of llmNodes)
      lines.push(`    ${n.id}{{"${escapeMermaidLabel(n.label)}"}}`)
    if (aggregatePrompts && promptAggregateId)
      lines.push(
        `    ${promptAggregateId}>"${promptComponents.length} prompts"]`
      )
    else
      for (const p of promptComponents)
        lines.push(`    ${p.id}>"${escapeMermaidLabel(p.name)}"]`)
    lines.push(`  end`)
    for (const n of llmNodes) lines.push(`  class ${n.id} llm`)
    if (aggregatePrompts && promptAggregateId)
      lines.push(`  class ${promptAggregateId} prompt`)
    else for (const p of promptComponents) lines.push(`  class ${p.id} prompt`)
  }

  // -- External services ----------------------------------------------------
  if (externals.length > 0) {
    lines.push(`  subgraph SG_ext["External services (${externals.length})"]`)
    lines.push(`    direction TB`)
    for (const x of cap(externals))
      lines.push(`    ${x.id}[/"${escapeMermaidLabel(x.name)}"/]`)
    if (remainder(externals) > 0)
      lines.push(`    SG_ext_more["+${remainder(externals)} more"]`)
    lines.push(`  end`)
    for (const x of cap(externals)) lines.push(`  class ${x.id} ext`)
  }

  // ---- Edges --------------------------------------------------------------
  // Re-target edges that pointed at individual prompt/model_call nodes onto
  // their aggregate buckets so they don't dangle.
  const visibleIds = new Set<string>()
  for (const arr of [entries, routes, agents, tools, externals]) {
    for (const c of cap(arr)) visibleIds.add(c.id)
  }
  if (aggregatePrompts && promptAggregateId) visibleIds.add(promptAggregateId)
  else for (const p of promptComponents) visibleIds.add(p.id)
  for (const n of llmNodes) visibleIds.add(n.id)

  // Pre-build a lookup from component id → "best aggregate" replacement.
  const remap = new Map<string, string>()
  if (aggregatePrompts && promptAggregateId) {
    for (const p of promptComponents) remap.set(p.id, promptAggregateId)
  }
  // Every model_call gets redirected to the matching LLM aggregate.
  for (const mc of acc.components.filter((c) => c.type === "model_call")) {
    const matchingCall = acc.modelCalls.find(
      (m) => m.file === mc.file && (mc.name.includes(m.provider) || mc.framework === m.provider)
    )
    if (!matchingCall) continue
    const key = `${matchingCall.provider}:${matchingCall.model ?? "?"}`
    const llmId = makeId("model_call", "(aggregate)", key)
    if (llmNodes.some((n) => n.id === llmId)) remap.set(mc.id, llmId)
  }

  const seenEdges = new Set<string>()
  for (const e of acc.edges) {
    const from = remap.get(e.from) ?? e.from
    const to = remap.get(e.to) ?? e.to
    if (from === to) continue
    if (!visibleIds.has(from) || !visibleIds.has(to)) continue
    const key = `${from}->${to}:${e.label}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    lines.push(`  ${from} -- "${escapeMermaidLabel(e.label)}" --> ${to}`)
  }

  return lines.join("\n")
}

/* -------------------------------------------------------------------------- */
/* Plain-prose summary                                                        */
/* -------------------------------------------------------------------------- */

/* ----- domain inference (for the plain-English description) ----------- */

/**
 * Coarse "what kind of business problem does this code solve" tag, derived
 * from tool/agent/route names + the project name. This is a *different
 * dimension* from `Archetype` — the archetype says "it's a LangGraph agent"
 * (mechanism), the domain says "it's a sales assistant" (purpose). The
 * non-technical opener uses the domain; the "How it does this" walkthrough
 * uses the archetype.
 */
type Domain =
  | "sales-and-outreach"
  | "customer-support"
  | "meetings-and-lectures"
  | "audio-content"
  | "code-and-development"
  | "scheduling"
  | "research-and-knowledge"
  | "content-creation"
  | "data-analysis"
  | "email-automation"
  | "general-assistant"

function inferDomain(acc: WorkflowAnalysis): Domain {
  const corpus = [
    ...acc.components.map((c) => `${c.name} ${c.file}`),
    ...acc.tools.map((t) => `${t.name} ${t.file}`),
    acc.projectName,
  ]
    .join(" ")
    .toLowerCase()

  // Order matters — more specific domains first. The `[a-z]*` tail lets a
  // root keyword match its inflected forms (meeting → meetings, transcrib
  // → transcriber/transcribed, etc.) without needing a long alternation.
  if (/\b(sales|crm|lead[a-z]*|prospect[a-z]*|cadence[a-z]*|outreach|pipeline|salesforce|hubspot)\b/.test(corpus))
    return "sales-and-outreach"
  if (/\b(support[a-z]*|ticket[a-z]*|complaint[a-z]*|refund[a-z]*|helpdesk|zendesk|intercom)\b/.test(corpus))
    return "customer-support"
  if (/\b(meeting[a-z]*|minute[a-z]*|lecture[a-z]*|notetaker[a-z]*|standup[a-z]*|interview[a-z]*)\b/.test(corpus))
    return "meetings-and-lectures"
  if (/\b(transcrib[a-z]*|whisper|stt|tts|speech[a-z]*|audio[a-z]*|video[a-z]*|podcast[a-z]*)\b/.test(corpus))
    return "audio-content"
  if (/\b(github|gitlab|commit[a-z]*|pull.?request[a-z]*|code.?review[a-z]*|repository[a-z]*|repo[_-]?scan[a-z]*)\b/.test(corpus))
    return "code-and-development"
  if (/\b(calendar[a-z]*|schedule[a-z]*|appointment[a-z]*|booking[a-z]*|reserve[a-z]*|google.?calendar)\b/.test(corpus))
    return "scheduling"
  if (/\b(rag|retriev[a-z]*|wiki|knowledge.?base[a-z]*|qa[_-]?bot|docs?[_-]?search|vector[a-z]*)\b/.test(corpus))
    return "research-and-knowledge"
  if (/\b(blog[a-z]*|article[a-z]*|content[a-z]*|copywrit[a-z]*|caption[a-z]*|seo|marketing.?copy)\b/.test(corpus))
    return "content-creation"
  if (/\b(analytic[a-z]*|dashboard[a-z]*|metric[a-z]*|kpi|report.?gen[a-z]*|insight[a-z]*|forecast[a-z]*)\b/.test(corpus))
    return "data-analysis"
  if (/\b(send.?email[a-z]*|smtp|sendgrid|mailgun|outreach.?email[a-z]*)\b/.test(corpus))
    return "email-automation"
  return "general-assistant"
}

/**
 * Extract plain-English **user-facing** capabilities — things a non-technical
 * person would recognise as "this app can do X for me". Driven by tool names
 * and route paths, deduped, max ~6 items.
 */
function inferUserCapabilities(acc: WorkflowAnalysis): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (s: string): void => {
    if (seen.has(s)) return
    seen.add(s)
    out.push(s)
  }

  for (const t of acc.tools) {
    const n = t.name.toLowerCase()
    if (/^(search|find|lookup|fetch|list|query|get|read)_/.test(n))
      add("look things up for you (search records, contacts, files, etc.)")
    if (/^(create|add|new|generate|make|register|insert)_/.test(n))
      add("create new records or content")
    if (/^(send|notify|email|message|dm|post)_/.test(n))
      add("send messages or notifications on your behalf")
    if (/^(update|edit|modify|set|change|rename)_/.test(n))
      add("update existing data")
    if (/^(delete|remove|drop|cancel|purge)_/.test(n))
      add("delete data — used carefully, this can affect real systems")
    if (/^(refund|charge|pay|invoice|bill)/.test(n))
      add("handle payments or refunds")
    if (/^(schedule|book|reserve|cancel.?booking)/.test(n))
      add("schedule things on a calendar")
    if (/(transcrib|summari|extract|distill|condense)/.test(n))
      add("read long content and pull out the key parts")
    if (/(translate|localiz|multilingual)/.test(n))
      add("work across multiple languages")
  }

  const routes = acc.components.filter((c) => c.type === "api_route")
  for (const r of routes) {
    const n = r.name.toLowerCase()
    if (/(upload|ingest|transcrib|process.?file)/.test(n))
      add("accept files you upload (audio, video, documents)")
    if (/(query|ask|qa|chat|conversation|message)/.test(n))
      add("answer follow-up questions about what it has processed")
    if (/(summary|minute|brief|report|result)/.test(n) && !/upload/.test(n))
      add("show you the generated summary or minutes whenever you ask")
    if (/(export|download|share)/.test(n)) add("export the results so you can keep them")
    if (/(timeline|transcript)/.test(n) && !seen.has("look things up for you")) {
      add("show the full transcript or timeline of what was said")
    }
  }

  // Whisper / summarizer indicate user-visible capabilities even without
  // matching tool names.
  if (acc.components.some((c) => c.framework === "Whisper" || /transcrib/i.test(c.name)))
    add("turn audio or video into searchable text")
  if (acc.components.some((c) => /summari/i.test(c.name)))
    add("write you a clean summary of long content")

  // Multi-language signal: any prompt with a `language` / `locale` variable.
  if (
    acc.prompts.some((p) => p.variables.some((v) => /lang|locale/i.test(v))) &&
    !seen.has("work across multiple languages")
  )
    add("work across multiple languages")

  return out
}

/**
 * Plain-English (truly non-technical) description of what the app does.
 * No jargon — avoids words like "API", "endpoint", "LLM", "prompt", "agent",
 * "framework", "graph", "state". Composed from the inferred domain.
 */
function describeWhatThisAppDoes(
  acc: WorkflowAnalysis,
  arch: Archetype
): string {
  const project = acc.projectName
  const domain = inferDomain(acc)
  const caps = inferUserCapabilities(acc)
  const lines: string[] = ["## What this app does", ""]

  let opener: string
  switch (domain) {
    case "sales-and-outreach":
      opener = `**${project}** is a **sales assistant**. Instead of clicking through multiple tools, you can talk to it in plain language — for example, ask it to find prospects, look up contacts, or start outreach campaigns — and it figures out what you want and takes the action for you.`
      break
    case "customer-support":
      opener = `**${project}** is a **customer-support helper**. It reads incoming requests, looks up customer information, and can take routine actions (like processing refunds or sending notifications) without a human agent having to click through each step.`
      break
    case "meetings-and-lectures":
      opener = `**${project}** helps you **make sense of recorded meetings or lectures**. You give it an audio or video file, and it gives you back a clean transcript plus a written summary. You can come back later and ask follow-up questions like "what did we decide about the budget?" or "what was my action item?".`
      break
    case "audio-content":
      opener = `**${project}** **turns audio or video into text and pulls structured information out of it** — summaries, key points, answers to questions, that kind of thing.`
      break
    case "code-and-development":
      opener = `**${project}** is a **developer assistant**. It inspects code, pull requests, or repositories and produces summaries, reviews, or refactoring suggestions that would otherwise take a human reviewer time to write.`
      break
    case "scheduling":
      opener = `**${project}** is a **scheduling helper**. You tell it in plain language what you'd like to book (e.g. "lunch with Sam next Thursday after 1pm") and it figures out availability and creates the calendar event for you.`
      break
    case "research-and-knowledge":
      opener = `**${project}** is a **smart search assistant**. It has access to a collection of documents, and you can ask it questions in plain English instead of skimming links — it finds the relevant parts and writes you a clear answer.`
      break
    case "content-creation":
      opener = `**${project}** is a **content-generation tool**. Give it a topic, audience, or rough outline, and it produces a draft you can edit instead of writing one from scratch.`
      break
    case "data-analysis":
      opener = `**${project}** is a **data analyst in a box**. You ask questions about your data in plain English — "how many sign-ups did we get last week?" — and it figures out where to look and explains the answer.`
      break
    case "email-automation":
      opener = `**${project}** handles **email on your behalf** — drafting, sending, or routing messages without you having to write each one manually.`
      break
    default:
      // Fall back to the archetype-based description for ambiguous repos.
      opener =
        arch === "fastapi-rest-api" || arch === "express-api" || arch === "nextjs-app"
          ? `**${project}** is a **web service** — it exposes a handful of addresses that apps or websites can call to get information or trigger actions.`
          : arch === "python-cli"
            ? `**${project}** is a **command-line tool** you run from your terminal — it processes whatever you pass in and prints (or saves) a result.`
            : `**${project}** is a **software project**. Edge Agent AI couldn't pin it to a familiar category from names alone, but the technical breakdown below should make its purpose clearer.`
  }

  lines.push(opener)

  if (caps.length > 0) {
    lines.push("")
    lines.push("Specifically, you can use it to:")
    lines.push(...caps.slice(0, 6).map((c) => `• ${c}`))
    if (caps.length > 6)
      lines.push(`• …and ${caps.length - 6} more capabilities (see the Tools tab below).`)
  }

  return lines.join("\n")
}

/**
 * Coarse-grained label for "what shape of project is this?". Lets the
 * narrative writer open with a confident, plain-English sentence instead
 * of a counts-and-stats listing. Order matters — the first matching rule
 * wins, so more specific archetypes go first.
 */
type Archetype =
  | "meeting-summarizer"
  | "audio-pipeline"
  | "rag-chatbot"
  | "chatbot"
  | "langgraph-agent"
  | "multi-agent-system"
  | "tool-using-agent"
  | "openapi-driven-agent"
  | "fastapi-rest-api"
  | "nextjs-app"
  | "express-api"
  | "python-cli"
  | "unknown"

function inferArchetype(acc: WorkflowAnalysis): Archetype {
  // Pull cheap signals once.
  const namesAndFiles = acc.components
    .map((c) => `${c.name} ${c.file}`.toLowerCase())
    .join(" ")
  const hasWhisper = acc.components.some(
    (c) => c.framework === "Whisper" || /whisper/i.test(c.name)
  )
  const hasMeeting =
    /\b(meeting|minute|lecture|transcript|summari[sz])/.test(namesAndFiles)
  const hasAudioLike =
    hasWhisper ||
    /\b(audio|transcrib|speech|stt|tts)/.test(namesAndFiles)
  const hasRag =
    /\b(retriev|rag|embed|chroma|pinecone|faiss|vector|qdrant|weaviate)/.test(
      namesAndFiles
    )
  const hasChat =
    /\b(chat|conversat|message|reply|respon)/.test(namesAndFiles)
  const hasLangGraph = acc.components.some(
    (c) => c.framework === "LangGraph" || c.framework === "LangGraph (JS)"
  )
  const agentCount = acc.components.filter(
    (c) => c.type === "agent" || c.type === "graph_node"
  ).length
  const toolCount = acc.tools.length
  const fastApi = acc.components.some((c) => c.framework === "FastAPI")
  const nextJs = acc.components.some(
    (c) => c.framework === "Next.js" || c.framework === "Next.js (pages)"
  )
  const express = acc.components.some((c) => c.framework === "Express")
  const hasModelCall = acc.modelCalls.length > 0
  const hasOpenApi = acc.openApiSpecs.length > 0

  if (hasMeeting && (hasWhisper || hasAudioLike) && hasModelCall)
    return "meeting-summarizer"
  if (hasAudioLike && hasModelCall) return "audio-pipeline"
  if (hasRag && hasModelCall) return "rag-chatbot"
  if (hasLangGraph) return "langgraph-agent"
  if (agentCount >= 2 && hasModelCall) return "multi-agent-system"
  if (agentCount >= 1 && toolCount >= 1 && hasModelCall)
    return "tool-using-agent"
  if (hasChat && hasModelCall) return "chatbot"
  if (hasOpenApi && (hasModelCall || toolCount >= 1)) return "openapi-driven-agent"
  if (fastApi) return "fastapi-rest-api"
  if (nextJs) return "nextjs-app"
  if (express) return "express-api"
  if (acc.entrypoints.some((e) => /__main__/.test(e.reason))) return "python-cli"
  return "unknown"
}

// archetypeOneLiner / describeMeetingSummarizerFlow / describeGenericFlow /
// inferRouteCapabilities were superseded by describeWhatThisAppDoes +
// inferUserCapabilities + describeHowItWorks (this version is fully
// domain-aware and non-technical at the top; the previous helpers produced
// duplicated, more technical copy and have been removed for clarity).

/* ----- "How it works" — numbered, file-anchored step list ---------------- */

/**
 * Produces a step-by-step walk through what actually happens when a request
 * hits this repo. Each step is anchored to a real file so the user can read
 * the code that backs the claim. The narrative branches by archetype so a
 * meeting-summarizer reads naturally vs. a generic FastAPI service.
 */
function describeHowItWorks(acc: WorkflowAnalysis, arch: Archetype): string {
  const lines: string[] = ["## How it does this", ""]
  lines.push(
    "Here's the actual mechanism, in plain order — file paths in backticks so you can open them yourself."
  )
  lines.push("")
  const entry = acc.entrypoints[0]
  const transcriber = acc.components.find(
    (c) =>
      /transcrib/i.test(c.name) ||
      c.framework === "Whisper" ||
      /whisper/i.test(c.name)
  )
  const summarizer = acc.components.find((c) => /summari/i.test(c.name))
  const qaHandler = acc.components.find(
    (c) =>
      /(query|qa|question|chat)/i.test(c.name) &&
      (c.type === "agent" || c.type === "tool" || c.type === "graph_node")
  )
  const langPrompt = acc.prompts.find((p) =>
    p.variables.some((v) => /lang|locale/i.test(v))
  )
  const promptCount = acc.prompts.length
  const providers = uniq(acc.modelCalls.map((m) => m.provider))
  const routes = acc.components.filter((c) => c.type === "api_route")

  let step = 1
  const push = (text: string): void => {
    lines.push(`${step++}. ${text}`)
  }

  // ----- archetype-specific walkthrough -----
  if (arch === "meeting-summarizer" || arch === "audio-pipeline") {
    if (entry)
      push(
        `**The app starts up.** \`${entry.file}\` boots a small web server that listens for incoming requests.`
      )
    if (routes.length > 0) {
      const uploadRoute = routes.find((r) =>
        /(upload|transcrib|ingest|process)/i.test(r.name)
      )
      if (uploadRoute)
        push(
          `**You upload your audio or video** to \`${uploadRoute.name}\` (handled in \`${uploadRoute.file}\`). You can also tell it the language and what kind of content it is.`
        )
      else
        push(
          `**A request comes in** through one of the app's ${routes.length} addresses.`
        )
    }
    if (transcriber)
      push(
        `**The app turns speech into text.** \`${transcriber.file}\`${transcriber.framework === "Whisper" ? " loads the Whisper speech-recognition model and " : " "}reads through your file to produce a written transcript${transcriber.framework === "Whisper" ? ", complete with timestamps so you can see when each line was said" : ""}.`
      )
    if (summarizer && providers.length > 0)
      push(
        `**The app asks an AI model for a summary.** \`${summarizer.file}\` writes a request that includes the transcript${
          langPrompt
            ? ` plus details like ${langPrompt.variables.map((v) => `\`${v}\``).join(", ")}`
            : ""
        }, sends it to ${providers.join(" / ")}, and gets back a clean summary${
          langPrompt && langPrompt.variables.some((v) => /lang/i.test(v))
            ? " written in whatever language you chose"
            : ""
        }.`
      )
    if (qaHandler) {
      const qaRoute = routes.find((r) => /(query|qa|question|chat|ask)/i.test(r.name))
      push(
        `**Later, when you ask a follow-up question** ${qaRoute ? `at \`${qaRoute.name}\`` : "through the chat endpoint"}, \`${qaHandler.file}\` looks up the saved transcript and summary and asks the AI a fresh question on your behalf.`
      )
    }
    push(
      `**The app sends the results back to you.**${promptCount > 0 ? ` Behind the scenes, ${promptCount} different request templates control exactly what the AI is asked at each step — the Prompts tab below lets you read them.` : ""}`
    )
  } else if (arch === "rag-chatbot") {
    push(
      `**The app keeps a searchable index of your documents.** Each document is split into chunks and stored along with a "fingerprint" the app can use to find similar content later.`
    )
    if (routes.length > 0 && entry)
      push(
        `**You ask a question** through one of the addresses defined in \`${entry.file}\`.`
      )
    push(
      `**The app finds the most relevant chunks** by comparing your question's fingerprint to every document chunk it has stored.`
    )
    if (providers.length > 0)
      push(
        `**Your question + the relevant chunks** are bundled into a request and sent to ${providers.join(" / ")}, which writes the answer using both your question and the supporting evidence.`
      )
    push(`**The answer is sent back to you** — usually with citations to the chunks it used.`)
  } else if (arch === "langgraph-agent" || arch === "multi-agent-system") {
    if (entry)
      push(
        `**The app sets up its workflow.** \`${entry.file}\` defines a series of steps and the rules for how the app moves between them.`
      )
    push(
      `**Your request arrives** and starts at the first step, carrying along a "scratchpad" that every step can read from and write to.`
    )
    const steps = acc.components
      .filter((c) => c.type === "agent" || c.type === "graph_node")
      .slice(0, 4)
    push(
      `**Each step** (${steps.map((c) => `\`${c.name}\``).join(", ")}${steps.length < acc.components.filter((c) => c.type === "agent" || c.type === "graph_node").length ? ", …" : ""}) either asks an AI model for help or runs one of the app's tools, then writes the result back to the scratchpad so the next step can use it.`
    )
    if (acc.tools.length > 0)
      push(
        `**The app has ${acc.tools.length} tools available** — when the AI decides it needs to take an action in the real world (look something up, send a message, change a record), it tells the app which tool to use and the app runs it.`
      )
    push(
      `**The app stops** when it reaches a finish step, and gives you back the final scratchpad — usually the AI's answer plus any data the tools collected along the way.`
    )
  } else if (arch === "tool-using-agent" || arch === "chatbot") {
    if (entry)
      push(`**The app starts up** from \`${entry.file}\` and waits for requests.`)
    if (routes.length > 0)
      push(`**You send a message** through one of the app's ${routes.length} address${routes.length === 1 ? "" : "es"}.`)
    if (providers.length > 0)
      push(
        `**The app asks ${providers.join(" / ")}** what to do, sending along your message plus a description of the tools the AI is allowed to use.`
      )
    if (acc.tools.length > 0)
      push(
        `**If the AI decides to use a tool**, the app runs the matching function (${acc.tools.slice(0, 3).map((t) => `\`${t.name}\``).join(", ")}${acc.tools.length > 3 ? ", …" : ""}), then tells the AI what happened so it can finish its answer.`
      )
    push(`**The app sends the AI's reply back to you.**`)
  } else {
    // Generic fallback — still useful, still file-anchored.
    if (entry) push(`**The app starts up** from \`${entry.file}\`.`)
    if (routes.length > 0)
      push(
        `**It listens at ${routes.length} address${routes.length === 1 ? "" : "es"}** — ${routes.slice(0, 4).map((r) => `\`${r.name}\``).join(", ")}${routes.length > 4 ? `, plus ${routes.length - 4} more` : ""}.`
      )
    const agents = acc.components.filter((c) => c.type === "agent" || c.type === "graph_node")
    if (agents.length > 0)
      push(
        `**${agents.length} component${agents.length === 1 ? "" : "s"} do the heavy lifting** (${agents.slice(0, 3).map((c) => `\`${c.name}\``).join(", ")}${agents.length > 3 ? ", …" : ""}).`
      )
    if (providers.length > 0)
      push(
        `**The AI work goes to ${providers.join(" / ")}** — ${acc.modelCalls.length} call${acc.modelCalls.length === 1 ? "" : "s"} in total.`
      )
    if (acc.tools.length > 0)
      push(
        `**${acc.tools.length} tool${acc.tools.length === 1 ? "" : "s"} can be called** when the app needs to take an action (${acc.tools.slice(0, 3).map((t) => `\`${t.name}\``).join(", ")}${acc.tools.length > 3 ? ", …" : ""}).`
      )
    push(`**The app sends the result back to you.**`)
  }

  return lines.join("\n")
}

function describeRisks(acc: WorkflowAnalysis): string | null {
  const risky = acc.tools.filter((t) => t.riskTags.length > 0)
  const lines: string[] = []
  if (risky.length > 0) {
    const tagSummary = uniq(risky.flatMap((t) => t.riskTags))
    lines.push(
      `**Heads-up:** ${risky.length} tool${risky.length === 1 ? "" : "s"} ${risky.length === 1 ? "looks" : "look"} potentially risky (${tagSummary.join(", ")}) — review ${risky
        .slice(0, 3)
        .map((t) => `\`${t.name}\``)
        .join(", ")}${risky.length > 3 ? ` and ${risky.length - 3} more` : ""}.`
    )
  }
  const unpinned = acc.modelCalls.filter((m) => !m.model).length
  if (unpinned > 0) {
    lines.push(
      `${unpinned} LLM call${unpinned === 1 ? "" : "s"} ${unpinned === 1 ? "doesn't" : "don't"} pin a specific model name — consider hard-coding the model id for reproducibility.`
    )
  }
  return lines.length > 0 ? lines.join(" ") : null
}

/**
 * Build the full narrative summary. Three explicit sections + an optional
 * risk callout. The renderer treats `## Heading` lines as section headers,
 * `N. ` lines as numbered list items, and `• ` lines as bullets.
 *
 *   1. `## What this app does` — plain English, no jargon, what a
 *      non-technical reader would understand. Driven by inferred domain
 *      (sales / meetings / support / etc.) plus user-facing capabilities.
 *   2. `## How it does this` — file-anchored step-by-step walkthrough of
 *      the actual mechanism, softened wording but still concrete.
 *   3. (optional) Risk callouts at the bottom.
 *
 * The older "archetype one-liner" and "generic flow paragraph" sections
 * were folded into the new structure — they were saying the same thing
 * twice in subtly different (and more technical) wording.
 */
function buildSummary(acc: WorkflowAnalysis): string {
  if (
    acc.components.length === 0 &&
    acc.modelCalls.length === 0 &&
    acc.entrypoints.length === 0
  ) {
    return "Edge Agent AI walked the repo but didn't detect any common AI-agent patterns. This may not be an agent repository, or it may use a framework Edge Agent doesn't recognise yet."
  }

  const archetype = inferArchetype(acc)
  const whatItDoes = describeWhatThisAppDoes(acc, archetype)
  const howItWorks = describeHowItWorks(acc, archetype)
  const risks = describeRisks(acc)

  return [whatItDoes, howItWorks, risks].filter(Boolean).join("\n\n")
}

/* -------------------------------------------------------------------------- */
/* Markdown report                                                            */
/* -------------------------------------------------------------------------- */

export function renderMarkdownReport(analysis: WorkflowAnalysis): {
  markdown: string
  filename: string
} {
  const stamp = analysis.generatedAt.replace(/[:.]/g, "-")
  const safeName = analysis.projectName.replace(/[^A-Za-z0-9._-]+/g, "-")
  const filename = `edge-agent-ai-workflow-report-${safeName}-${stamp}.md`

  const lines: string[] = []
  lines.push(`# Workflow Report — ${analysis.projectName}`)
  lines.push("")
  lines.push(`*Generated by Edge Agent AI at ${analysis.generatedAt}*`)
  lines.push("")
  lines.push(`Project path: \`${analysis.projectPath}\``)
  lines.push("")

  lines.push("## Summary")
  lines.push(analysis.summary)
  lines.push("")

  lines.push("## Entry points")
  if (analysis.entrypoints.length === 0) lines.push("_None detected._")
  else
    for (const e of analysis.entrypoints) {
      lines.push(
        `- **${e.reason}** — \`${e.file}${typeof e.line === "number" ? `:${e.line}` : ""}\``
      )
    }
  lines.push("")

  lines.push("## Workflow diagram")
  lines.push("")
  lines.push("```mermaid")
  lines.push(analysis.mermaid)
  lines.push("```")
  lines.push("")

  lines.push("## Components")
  if (analysis.components.length === 0) lines.push("_None detected._")
  else {
    lines.push("| Name | Type | File | Framework |")
    lines.push("| --- | --- | --- | --- |")
    for (const c of analysis.components) {
      lines.push(
        `| ${c.name} | ${c.type} | \`${c.file}${typeof c.line === "number" ? `:${c.line}` : ""}\` | ${c.framework ?? ""} |`
      )
    }
  }
  lines.push("")

  lines.push("## Prompts")
  if (analysis.prompts.length === 0) lines.push("_No prompts detected._")
  else {
    for (const p of analysis.prompts) {
      lines.push(`### ${p.name}`)
      lines.push(`\`${p.file}${typeof p.line === "number" ? `:${p.line}` : ""}\``)
      if (p.variables.length > 0) lines.push(`Variables: ${p.variables.map((v) => `\`${v}\``).join(", ")}`)
      lines.push("")
      lines.push("```")
      lines.push(p.contentPreview)
      lines.push("```")
      lines.push("")
    }
  }

  lines.push("## Tools")
  if (analysis.tools.length === 0) lines.push("_No tools detected._")
  else {
    lines.push("| Name | File | Parameters | Risk tags |")
    lines.push("| --- | --- | --- | --- |")
    for (const t of analysis.tools) {
      lines.push(
        `| ${t.name} | \`${t.file}${typeof t.line === "number" ? `:${t.line}` : ""}\` | ${t.parameters.join(", ")} | ${t.riskTags.join(", ") || "—"} |`
      )
    }
  }
  lines.push("")

  lines.push("## Model calls")
  if (analysis.modelCalls.length === 0) lines.push("_No LLM calls detected._")
  else {
    lines.push("| Provider | Model | File | Prompts |")
    lines.push("| --- | --- | --- | --- |")
    for (const m of analysis.modelCalls) {
      lines.push(
        `| ${m.provider} | ${m.model ?? "?"} | \`${m.file}${typeof m.line === "number" ? `:${m.line}` : ""}\` | ${m.promptRefs.join(", ") || "—"} |`
      )
    }
  }
  lines.push("")

  if (analysis.mcpConfigs.length > 0) {
    lines.push("## MCP configurations")
    for (const m of analysis.mcpConfigs) {
      lines.push(`- \`${m.file}\` — servers: ${m.servers.join(", ") || "(none parsed)"}`)
    }
    lines.push("")
  }
  if (analysis.openApiSpecs.length > 0) {
    lines.push("## OpenAPI specs")
    for (const s of analysis.openApiSpecs) {
      lines.push(`- \`${s.file}\` — ${s.title ?? "(no title)"} ${s.version ? `v${s.version}` : ""}`)
      for (const op of s.operations) {
        lines.push(`    - **${op.method}** ${op.path}${op.summary ? ` — ${op.summary}` : ""}`)
      }
    }
    lines.push("")
  }

  if (analysis.warnings.length > 0) {
    lines.push("## Warnings")
    for (const w of analysis.warnings) lines.push(`- ${w}`)
    lines.push("")
  }

  lines.push("## Recommended next steps")
  const recs: string[] = []
  if (analysis.tools.some((t) => t.riskTags.length > 0))
    recs.push(
      "Review the tools tagged with risk markers; consider adding human-approval gating or removing dangerous side effects."
    )
  if (analysis.prompts.some((p) => p.variables.length === 0))
    recs.push("Some prompt templates have no variables — confirm they're not hard-coding instructions that should be configurable.")
  if (analysis.modelCalls.some((m) => !m.model))
    recs.push("Some LLM calls didn't have an inferable model name — pin them to specific models in the source for reproducibility.")
  if (analysis.entrypoints.length === 0)
    recs.push("No clear entry point was detected; add an explicit FastAPI app, Next.js route, or `if __name__ == '__main__':` block.")
  if (recs.length === 0) recs.push("No immediate workflow concerns flagged.")
  for (const r of recs) lines.push(`- ${r}`)
  lines.push("")

  return { markdown: lines.join("\n"), filename }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the analyzer against a resolved project path. The caller is responsible
 * for validating that the path exists, is a directory, and lives inside the
 * scan allowlist — see the route handler.
 */
export function analyzeWorkflow(projectPath: string): WorkflowAnalysis {
  const start = Date.now()
  const projectName = path.basename(projectPath)
  const warnings: string[] = []

  const acc: WorkflowAnalysis = {
    projectName,
    projectPath,
    generatedAt: new Date().toISOString(),
    entrypoints: [],
    components: [],
    prompts: [],
    tools: [],
    modelCalls: [],
    mcpConfigs: [],
    openApiSpecs: [],
    edges: [],
    mermaid: "",
    summary: "",
    warnings,
    stats: {
      filesScanned: 0,
      componentsDetected: 0,
      promptsDetected: 0,
      toolsDetected: 0,
      modelCallsDetected: 0,
      durationMs: 0,
    },
  }

  const { files, filesScanned } = walkRepo(projectPath, warnings)

  for (const f of files) {
    // Each detector is tolerant of files outside its remit (early-returns
    // on extension mismatch), so we can let the dispatcher be dumb.
    detectPython(f, acc)
    detectTypeScript(f, acc)
    detectPrompts(f, acc)
    detectMcpAndOpenApi(f, acc)
  }

  linkPromptsAndTools(acc)
  inferEdges(acc)

  acc.mermaid = buildMermaid(acc)
  acc.summary = buildSummary(acc)

  acc.stats.filesScanned = filesScanned
  acc.stats.componentsDetected = acc.components.length
  acc.stats.promptsDetected = acc.prompts.length
  acc.stats.toolsDetected = acc.tools.length
  acc.stats.modelCallsDetected = acc.modelCalls.length
  acc.stats.durationMs = Date.now() - start

  return acc
}
