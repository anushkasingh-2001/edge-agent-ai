/**
 * Server-side helpers for AI-personalized finding explanations.
 *
 * Design constraints baked in here (the route just plumbs these):
 *   * No LLM call during scan or list view — the API route is the ONLY caller.
 *   * Per-finding cache keyed by content fingerprint so reopening a finding
 *     never re-bills the model.
 *   * Strict JSON shape with a fixed five-section schema. Anything the model
 *     emits outside that schema (severity, category, file, line, evidence,
 *     rule_id) is DISCARDED before the response is returned. The static
 *     scanner remains the source of truth.
 *   * Deterministic template fallback when API key is missing or the model
 *     call fails / times out. The fallback uses the scanner's existing
 *     structured `reason` so the UI degrades gracefully without going silent.
 *   * Optional per-process session cap via `EDGE_AGENT_EXPLAINER_SESSION_CAP`.
 *     Off by default so clicking through long findings lists keeps using AI;
 *     ops opt in when they want a cost guardrail.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import {
  expandUserPath,
  getScanAllowRoot,
  isPathInside,
} from "@/lib/server-path-utils"

// ---------------------------------------------------------------------------
// Public types — kept in sync with the strict JSON shape the route returns.
// ---------------------------------------------------------------------------

export type ExplanationSource =
  | "ai"
  | "cached_ai"
  | "template_fallback"
  | "unavailable"

/**
 * AI explanation payload returned to the client.
 *
 * When `source === "ai"` (or `"cached_ai"`) the AI-only fields
 * (`what_detected`, `why_risky`, `suggested_fix`) are populated and the
 * template-only fields (`why_may_be_okay`, `what_to_verify`,
 * `confidence_note`) are intentionally omitted so the UI shows just the
 * three project-specific sections.
 *
 * When `source === "template_fallback"` or `"unavailable"`, the
 * template-only fields are also populated so the deterministic fallback
 * still surfaces the scanner's structured reason to the user.
 */
export interface FindingExplanationPayload {
  what_detected: string
  why_risky: string
  suggested_fix: string
  /** Only present for template-fallback / unavailable payloads. */
  why_may_be_okay?: string
  /** Only present for template-fallback / unavailable payloads. */
  what_to_verify?: string[]
  /** Only present for template-fallback / unavailable payloads. */
  confidence_note?: string
  source: ExplanationSource
  model_used: string | null
  cached: boolean
  /**
   * Non-PII diagnostic for the dev console / UI. Populated only when the
   * server falls back to the template because the AI call failed (e.g.
   * `model_http_404`, `network_error: ...`). The API key is ALWAYS
   * redacted before reaching this field. Production builds receive
   * `undefined` so we don't leak status codes to end users.
   */
  debug_error?: string
}

export interface FindingInput {
  /** Stable scanner id (UUID) if present; falls back to numeric UI id. */
  finding_id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
  agent: string
  /** Existing structured/template reason from the scanner (used by fallback
   * AND sent to the model as reference only). */
  reason: string
  suggested_fix: string
  evidence: string
  /** First N lines of source around the finding. Caller MUST limit this. */
  code_snippet: string
  evidence_path?: Array<{ kind: string; label: string; file?: string | null; line?: number | null }>
  confidence?: number
  agent_reachable?: boolean
}

/**
 * Local code context extracted from the source file around the finding.
 *
 * Built server-side from the file the finding points at, validated to be
 * inside the project allow-root before reading. Used both to enrich the
 * AI prompt AND as part of the cache fingerprint so the cached AI answer
 * regenerates when the surrounding code changes.
 *
 * Every string in this object is run through `redactSecrets()` before
 * being persisted or sent to the model.
 */
export interface CodeContext {
  /** The exact line at finding.line, redacted. */
  line: string
  /** Up to 20 lines immediately before, redacted. */
  before: string[]
  /** Up to 20 lines immediately after, redacted. */
  after: string[]
  /** Containing function/method name when detectable. */
  function_name: string | null
  /** Containing class/struct name when detectable. */
  class_name: string | null
  /** Containing function body excerpt, capped to ~120 lines, redacted. */
  function_body_excerpt: string | null
  /** Import statements at the top of the file (Python `import`/`from`,
   *  ES `import`/`require`), capped to ~30 entries. */
  imports: string[]
  /** Best-effort extraction of the call expression on the finding line
   *  (e.g. `os.system(cmd)`). Redacted. */
  call_expression: string | null
  /** Summary of arguments passed to the call (raw string slice). Redacted. */
  arguments_summary: string | null
  /** Caller/tool/agent labels pulled from IR evidence_path. */
  agent_or_tool_path: string[]
  /** Source-to-sink labels pulled from IR evidence_path. */
  evidence_path: string[]
  /** Resolved path the context was read from, or null when no file was
   *  read (path validation failed or finding.file was missing). */
  source_path: string | null
}

export interface ProjectContext {
  /** Absolute, allow-root-validated project path. */
  resolvedProjectPath: string
  /** Display name (project folder name by default). */
  projectName?: string | null
  /** Free-form project type/context hint provided by the caller (e.g. "Next.js + LangGraph agent"). */
  projectType?: string | null
}

export interface ExplainOptions {
  /** Override the OpenAI key (preferred) — otherwise process.env.OPENAI_API_KEY is used. */
  apiKey?: string | null
  /** Override base URL for OpenAI-compatible endpoints. Defaults to api.openai.com. */
  baseUrl?: string | null
  /**
   * Force a specific model id. When provided (typically when the caller is
   * using the user's browser-stored Settings key) this overrides the
   * default `pickModel` tiering — we trust the user's Settings choice so
   * we don't try to call a model their key doesn't have access to.
   */
  model?: string | null
  /** Bypass cache (force a fresh AI call). Used by tests and the rare "regenerate" path. */
  skipCache?: boolean
  /** Inject a custom clock for deterministic tests. */
  now?: () => number
  /** Total request budget in ms (default 25_000). */
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Model policy
// ---------------------------------------------------------------------------

// Defaults are intentionally identical across severity tiers: gpt-4.1-mini
// is the official baseline for AI finding explanations because it's a good
// price/quality balance and is widely entitled on user-supplied OpenAI keys.
// Operators who want to spend more on the hard cases (agent-reachable /
// critical / high) can override the deep tier via env.
const DEFAULT_EXPLAINER_MODEL = "gpt-4.1-mini"
const DEFAULT_EXPLAINER_DEEP_MODEL = "gpt-4.1-mini"

function envModel(name: string, fallback: string): string {
  const v = process.env[name]
  return typeof v === "string" && v.trim() ? v.trim() : fallback
}

/**
 * Pick the model for a finding.
 *
 *  * `EDGE_AGENT_EXPLAINER_DEEP_MODEL` (default: gpt-4.1-mini) for
 *    confirmed agent-reachable / critical / high findings.
 *  * `EDGE_AGENT_EXPLAINER_MODEL` (default: gpt-4.1-mini) for everything
 *    else (the long tail of low/medium presence warnings and
 *    accuracy/quality signals).
 *
 * We deliberately read the env on every call instead of caching at module
 * load so tests can flip the env between cases without re-importing, and
 * dev-server hot reloads pick up Settings changes immediately.
 *
 * The caller can still force a specific model id via `opts.model` in
 * `explainOneFinding`; this only governs the default when nothing was
 * forwarded from Settings.
 */
export function pickModel(finding: Pick<FindingInput, "severity" | "agent_reachable">): string {
  const deep = envModel("EDGE_AGENT_EXPLAINER_DEEP_MODEL", DEFAULT_EXPLAINER_DEEP_MODEL)
  const base = envModel("EDGE_AGENT_EXPLAINER_MODEL", DEFAULT_EXPLAINER_MODEL)
  if (finding.agent_reachable === true) return deep
  if (finding.severity === "critical" || finding.severity === "high") return deep
  return base
}

// Per-process counter. Resets on dev-server reload. We still track it
// so an operator who explicitly sets EDGE_AGENT_EXPLAINER_SESSION_CAP
// gets a working ceiling — but by default there is no cap, so a user
// clicking through every Low finding in a long list keeps getting real
// AI explanations instead of silently degrading to template fallback.
const SESSION_STATE = { explanationsThisSession: 0 }

let _sessionCapOverride: number | null = null

/** Returns the active cap, or `null` for "no cap". The default is
 *  uncapped; ops opt in via env when they want a guardrail. */
function currentSessionCap(): number | null {
  if (_sessionCapOverride != null) return _sessionCapOverride
  const raw = process.env.EDGE_AGENT_EXPLAINER_SESSION_CAP
  if (raw && raw.trim()) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/** Legacy export kept for back-compat with any caller that imported the
 *  old constant. The runtime path no longer consults this value — see
 *  `currentSessionCap()`. Value of 0 advertises "no default cap". */
export const MAX_EXPLANATIONS_PER_SESSION = 0

export function resetSessionCounterForTests(): void {
  SESSION_STATE.explanationsThisSession = 0
}

/** Test-only override so the env-cap regression test stays fast. Pass
 *  `null` to clear (the runtime default is "no cap"). */
export function setSessionCapForTests(cap: number | null): void {
  _sessionCapOverride = cap
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_REL_PATH = path.join(".edgeagent", "cache", "explanations.json")
// v2: switched default explainer model from gpt-5-nano/gpt-5-mini (and
// any caller-provided gpt-4.1) to gpt-4.1-mini. Bumping the schema means
// any old cache file is treated as empty on first read, so users do not
// see stale explanations generated by the previous model defaults.
const CACHE_SCHEMA_VERSION = 2

interface CacheEntry {
  fingerprint: string
  payload: FindingExplanationPayload
  created_at: string
}

interface CacheFile {
  schema_version: number
  entries: Record<string, CacheEntry>
}

function emptyCache(): CacheFile {
  return { schema_version: CACHE_SCHEMA_VERSION, entries: {} }
}

function cacheFilePath(resolvedProjectPath: string): string {
  return path.join(resolvedProjectPath, CACHE_REL_PATH)
}

function readCache(resolvedProjectPath: string): CacheFile {
  const file = cacheFilePath(resolvedProjectPath)
  try {
    if (!fs.existsSync(file)) return emptyCache()
    const raw = fs.readFileSync(file, "utf-8")
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.schema_version !== CACHE_SCHEMA_VERSION || typeof parsed.entries !== "object") {
      // Schema bump => start fresh rather than risk feeding stale shapes back.
      return emptyCache()
    }
    return parsed as CacheFile
  } catch {
    return emptyCache()
  }
}

function writeCacheAtomic(resolvedProjectPath: string, cache: CacheFile): void {
  // Mirror the atomic tmp+rename pattern used by writeBaseScanCache in
  // lib/server-policy.ts so a crash mid-write never produces a half-file.
  const dir = path.join(resolvedProjectPath, ".edgeagent", "cache")
  const file = cacheFilePath(resolvedProjectPath)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o644 })
    fs.renameSync(tmp, file)
  } catch {
    // Cache miss is recoverable; a hard error here isn't worth bubbling.
  }
}

/**
 * Stable fingerprint of an explanation request.
 *
 * Includes: project root, file, line, rule_id, model, and hashes of the
 * code snippet + evidence + the richer local code context (when
 * available). The model AND the surrounding function body are part of
 * the key so:
 *   * re-running the same finding against a stronger model produces a
 *     separate entry rather than silently overwriting the cheap one, and
 *   * editing the containing function (renaming a variable, changing the
 *     call) invalidates the cached AI explanation automatically.
 */
export function fingerprintFinding(
  projectPath: string,
  finding: Pick<FindingInput, "finding_id" | "file" | "line" | "rule_id" | "code_snippet" | "evidence">,
  model: string,
  codeContext?: CodeContext | null,
): string {
  const codeHash = sha256(finding.code_snippet ?? "")
  const evidenceHash = sha256(finding.evidence ?? "")
  // The context hash covers EVERYTHING we send to the model that derives
  // from the source file: the redacted before/after lines, the function
  // body excerpt, imports, the call expression. If any of those change
  // the cached AI answer becomes stale by definition.
  const contextHash = codeContext
    ? sha256(
        JSON.stringify({
          before: codeContext.before,
          line: codeContext.line,
          after: codeContext.after,
          function_name: codeContext.function_name,
          class_name: codeContext.class_name,
          function_body_excerpt: codeContext.function_body_excerpt,
          imports: codeContext.imports,
          call_expression: codeContext.call_expression,
          arguments_summary: codeContext.arguments_summary,
        }),
      )
    : ""
  const key = [
    sha256(projectPath),
    finding.finding_id,
    finding.file,
    finding.line,
    finding.rule_id,
    codeHash,
    evidenceHash,
    contextHash,
    model,
  ].join("|")
  return sha256(key).slice(0, 24)
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex")
}

// ---------------------------------------------------------------------------
// Secret redaction (runs over EVERY string sent to the model)
// ---------------------------------------------------------------------------

/**
 * Patterns that look like real credentials. Each entry is `[regex, label]`.
 * The replacement uses the label so the redacted text remains informative
 * for the model (e.g. "OPENAI_API_KEY = '<REDACTED_OPENAI_KEY>'") without
 * leaking the actual secret.
 *
 * This list is intentionally narrower than the Python scanner's gitleaks
 * patterns because here we only have to redact secrets in the ~40-line
 * window we send to the model, not detect every kind of leak.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // OpenAI / OpenAI project keys
  [/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "<REDACTED_OPENAI_KEY>"],
  // Anthropic
  [/sk-ant-(?:api03-)?[A-Za-z0-9_-]{16,}/g, "<REDACTED_ANTHROPIC_KEY>"],
  // GitHub PATs (ghp_ / gho_ / ghu_ / ghs_ / ghr_)
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "<REDACTED_GITHUB_TOKEN>"],
  // AWS access key id
  [/AKIA[0-9A-Z]{16}/g, "<REDACTED_AWS_KEY>"],
  // Stripe
  [/sk_live_[A-Za-z0-9]{16,}/g, "<REDACTED_STRIPE_KEY>"],
  [/pk_live_[A-Za-z0-9]{16,}/g, "<REDACTED_STRIPE_KEY>"],
  // Slack
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "<REDACTED_SLACK_TOKEN>"],
  // Generic Bearer-style JWTs (3-part dotted)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<REDACTED_JWT>"],
  // PEM private keys (one-line collapsed and multi-line both end up here
  // because we redact line-by-line — match the marker only).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "<REDACTED_PRIVATE_KEY_BEGIN>"],
  [/-----END [A-Z ]*PRIVATE KEY-----/g, "<REDACTED_PRIVATE_KEY_END>"],
  // Common DB URLs that embed username:password
  [/(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:\/\s"'<>]+:[^@\/\s"'<>]+@[^\s"'<>]+/g, "<REDACTED_DB_URL>"],
  // password=... / api_key=... / token=... / secret=... assignments.
  // The negative lookahead `(?!<REDACTED_)` ensures we don't double-redact
  // a value that an earlier (more informative) vendor pattern already
  // replaced — otherwise `<REDACTED_OPENAI_KEY>` would be collapsed to
  // the less-informative `<REDACTED_SECRET>`.
  [
    /((?:password|passwd|pwd|api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|auth[_-]?token|bearer)\s*[:=]\s*["'])(?!<REDACTED_)[^"'\n]{4,}(["'])/gi,
    "$1<REDACTED_SECRET>$2",
  ],
]

/**
 * Redact credential-shaped substrings from one string.
 *
 * Safe to apply to arbitrary code: the patterns are conservative enough
 * that they don't touch identifiers like `apiKeyVar` or function calls
 * — only literal-looking secrets are replaced.
 *
 * Order matters: vendor-specific patterns (OpenAI / Anthropic / Stripe /
 * AWS / GitHub PAT) run BEFORE the generic `api_key="..."` assignment
 * pattern so the redacted text keeps the most informative label.
 */
export function redactSecrets(input: string): string {
  if (!input) return input
  let out = input
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement)
  }
  // Second pass: anything that pattern-matches an obvious password assignment
  // we didn't already catch (cheap heuristic: long base64-ish strings after
  // = in a quote). Conservative on length so we don't redact short literals
  // that are probably not secrets.
  out = out.replace(
    /(["'])([A-Za-z0-9+/=_-]{32,})(["'])/g,
    (_m, q1, body: string, q2) => {
      // Don't double-redact placeholders already inserted upstream.
      if (body.startsWith("<REDACTED_")) return `${q1}${body}${q2}`
      // Only redact if it looks high-entropy (mix of cases AND digits OR
      // length >= 48), to avoid scrubbing English strings.
      const hasUpper = /[A-Z]/.test(body)
      const hasLower = /[a-z]/.test(body)
      const hasDigit = /\d/.test(body)
      if ((hasUpper && hasLower && hasDigit) || body.length >= 48) {
        return `${q1}<REDACTED_LITERAL>${q2}`
      }
      return `${q1}${body}${q2}`
    },
  )
  return out
}

// ---------------------------------------------------------------------------
// Local code-context extraction
// ---------------------------------------------------------------------------

/**
 * Default symmetric window size — 20 lines before AND 20 after.
 * Combined with the line itself this gives the model 41 lines of redacted
 * context, well below the 6–8k-token target.
 */
const CONTEXT_WINDOW = 20
const FUNCTION_BODY_MAX_LINES = 120
const MAX_IMPORTS = 30

/**
 * Read the source file the finding points at and extract a rich,
 * redacted code context object the model can use to give a specific
 * explanation.
 *
 * Path safety: the absolute resolved path of `finding.file` (which can
 * be relative to the project root OR already absolute) is REQUIRED to
 * lie inside `resolvedProjectPath`. If it doesn't, we return a minimal
 * context object with `source_path: null` and no file content.
 *
 * Failure modes (missing file, permission denied, binary, too large)
 * all degrade gracefully to "no extra context" rather than throwing —
 * the caller will simply send the smaller prompt to the model.
 */
export function buildCodeContext(
  finding: Pick<FindingInput, "file" | "line" | "code_snippet" | "evidence_path">,
  resolvedProjectPath: string,
): CodeContext {
  // When path-validation fails or the file can't be read, the only
  // signal we have is the snippet the client forwarded as
  // ``finding.code_snippet`` — which, after the recent extractor
  // changes, IS the verbatim call expression for sink findings. Seed
  // the empty context with that snippet so the AI prompt still gets a
  // specific call rather than an empty placeholder.
  const snippet = redactSecrets((finding.code_snippet ?? "").trim())
  const empty: CodeContext = {
    line: snippet,
    before: [],
    after: [],
    function_name: null,
    class_name: null,
    function_body_excerpt: null,
    imports: [],
    call_expression: looksLikeFullCall(snippet) ? snippet : null,
    arguments_summary: null,
    agent_or_tool_path: collectAgentToolPath(finding.evidence_path),
    evidence_path: collectEvidenceLabels(finding.evidence_path),
    source_path: null,
  }
  if (!finding.file || typeof finding.line !== "number" || !Number.isFinite(finding.line)) {
    return empty
  }

  // Resolve the file path. We accept either a project-relative path (the
  // common case) or an absolute path. Both forms MUST resolve to a path
  // inside the project root after `path.resolve`. The allow-root check
  // happens implicitly because we restrict to the project subtree here.
  let resolvedFile: string
  try {
    const candidate = path.isAbsolute(finding.file)
      ? finding.file
      : path.join(resolvedProjectPath, finding.file)
    resolvedFile = path.resolve(candidate)
  } catch {
    return empty
  }
  if (!isPathInside(resolvedFile, resolvedProjectPath)) {
    return empty
  }

  // Read the file. Hard size cap so a runaway 100 MB file can't blow up
  // the explainer process.
  let text: string
  try {
    const stat = fs.statSync(resolvedFile)
    if (!stat.isFile()) return empty
    if (stat.size > 2 * 1024 * 1024) return empty // 2 MB
    text = fs.readFileSync(resolvedFile, "utf-8")
  } catch {
    return empty
  }

  const lines = text.split(/\r?\n/)
  const idx = Math.max(0, Math.min(lines.length - 1, finding.line - 1))
  const language = detectLanguage(resolvedFile)

  const beforeRaw = lines.slice(Math.max(0, idx - CONTEXT_WINDOW), idx)
  const afterRaw = lines.slice(idx + 1, idx + 1 + CONTEXT_WINDOW)
  const lineRaw = lines[idx] ?? ""

  const imports = extractImports(lines, language).slice(0, MAX_IMPORTS).map(redactSecrets)

  const containing = extractContainingFunction(lines, idx, language)
  const funcBody = containing?.body
    ? containing.body.slice(0, FUNCTION_BODY_MAX_LINES).map(redactSecrets).join("\n")
    : null

  const { call, args } = extractCallExpression(lineRaw)
  // The scanner now plumbs the verbatim call expression through
  // ``Finding.code`` (see ``ir/extract_python.py::_capture_call_text``
  // and ``ir/extract_ts_js.py``). When that text already looks like a
  // full call we prefer it — it round-trips multi-line invocations and
  // preserves the exact spelling the developer used, which the
  // file-line heuristic cannot. Fall back to the line-derived
  // extraction otherwise.
  const scannerSnippet = (finding.code_snippet ?? "").trim()
  const preferScannerSnippet = looksLikeFullCall(scannerSnippet)
  const callExpressionRaw = preferScannerSnippet ? scannerSnippet : call

  return {
    line: redactSecrets(lineRaw),
    before: beforeRaw.map(redactSecrets),
    after: afterRaw.map(redactSecrets),
    function_name: containing?.functionName ?? null,
    class_name: containing?.className ?? null,
    function_body_excerpt: funcBody,
    imports,
    call_expression: callExpressionRaw ? redactSecrets(callExpressionRaw) : null,
    arguments_summary: args ? redactSecrets(args) : null,
    agent_or_tool_path: empty.agent_or_tool_path,
    evidence_path: empty.evidence_path,
    source_path: resolvedFile,
  }
}

function detectLanguage(file: string): "python" | "ts" | "js" | "other" {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".py" || ext === ".pyi") return "python"
  if (ext === ".ts" || ext === ".tsx") return "ts"
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "js"
  return "other"
}

function extractImports(lines: string[], language: "python" | "ts" | "js" | "other"): string[] {
  const out: string[] = []
  const max = Math.min(lines.length, 200) // imports live near the top
  for (let i = 0; i < max; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (language === "python") {
      if (/^(?:from\s+[\w.]+\s+import\s+|import\s+\w)/.test(trimmed)) out.push(trimmed)
    } else if (language === "ts" || language === "js") {
      if (
        /^(?:import\s+[^;]+from\s+['"][^'"]+['"]|import\s+['"][^'"]+['"]|const\s+[\w{},\s]+\s*=\s*require\(['"][^'"]+['"]\))/.test(
          trimmed,
        )
      ) {
        out.push(trimmed)
      }
    }
  }
  return out
}

interface ContainingFunction {
  functionName: string | null
  className: string | null
  body: string[]
}

/**
 * Heuristic, language-aware extraction of the function (and optionally
 * class) that contains `idx`. Indentation-based for Python; brace-based
 * for TS/JS. Good enough for the explainer prompt — we just want the
 * surrounding semantic block.
 */
function extractContainingFunction(
  lines: string[],
  idx: number,
  language: "python" | "ts" | "js" | "other",
): ContainingFunction | null {
  if (language === "python") {
    return extractPythonFunction(lines, idx)
  }
  if (language === "ts" || language === "js") {
    return extractTsJsFunction(lines, idx)
  }
  return null
}

function extractPythonFunction(lines: string[], idx: number): ContainingFunction | null {
  const findingIndent = leadingIndent(lines[idx] ?? "")
  let funcStart = -1
  let funcName: string | null = null
  let funcIndent = -1
  let className: string | null = null
  // Walk upwards looking for a `def` (or `async def`) at indentation less
  // than the finding's. Stop at the first match.
  for (let i = idx; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const ind = leadingIndent(line)
    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)
    if (defMatch && ind < findingIndent) {
      funcStart = i
      funcName = defMatch[1]
      funcIndent = ind
      break
    }
  }
  if (funcStart < 0) return null
  // Now look further up for an enclosing `class Foo:` at indent < funcIndent.
  for (let i = funcStart - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const ind = leadingIndent(line)
    const m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line)
    if (m && ind < funcIndent) {
      className = m[1]
      break
    }
  }
  // Find the end of the function body: first line at indent <= funcIndent
  // after at least one body line.
  let funcEnd = lines.length
  for (let i = funcStart + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const ind = leadingIndent(line)
    if (ind <= funcIndent) {
      funcEnd = i
      break
    }
  }
  return {
    functionName: funcName,
    className,
    body: lines.slice(funcStart, funcEnd),
  }
}

function extractTsJsFunction(lines: string[], idx: number): ContainingFunction | null {
  // Brace-tracking from the finding line going upwards: find the nearest
  // function/method declaration whose `{` opens a scope still active at
  // the finding line. Cheap heuristic; works for plain decls, arrow fns
  // bound to const/let, and class methods.
  const DECL_REGEX =
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>|(?:public|private|protected|static|\s)+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/
  let depth = 0
  let funcStart = -1
  let funcName: string | null = null
  for (let i = idx; i >= 0; i--) {
    const line = lines[i] ?? ""
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    depth += closes - opens
    if (depth < 0) {
      // We found the line that opened the scope containing the finding.
      const m = DECL_REGEX.exec(line)
      if (m) {
        funcName = m[1] || m[2] || m[3] || null
        funcStart = i
        break
      }
      // Decl might be on an earlier line if the `{` was on its own line.
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const m2 = DECL_REGEX.exec(lines[j] ?? "")
        if (m2) {
          funcName = m2[1] || m2[2] || m2[3] || null
          funcStart = j
          break
        }
      }
      if (funcStart < 0) funcStart = i
      break
    }
  }
  if (funcStart < 0) return null

  // Look upward from funcStart for an enclosing `class Foo`.
  let className: string | null = null
  for (let i = funcStart - 1; i >= 0; i--) {
    const m = /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(lines[i] ?? "")
    if (m) {
      className = m[1]
      break
    }
  }

  // Forward-track to find the closing brace of this scope.
  let d = 0
  let funcEnd = lines.length
  let seenOpen = false
  for (let i = funcStart; i < lines.length; i++) {
    const line = lines[i] ?? ""
    for (const ch of line) {
      if (ch === "{") {
        d++
        seenOpen = true
      } else if (ch === "}") {
        d--
        if (seenOpen && d === 0) {
          funcEnd = i + 1
          break
        }
      }
    }
    if (seenOpen && d === 0) break
  }
  return {
    functionName: funcName,
    className,
    body: lines.slice(funcStart, funcEnd),
  }
}

function leadingIndent(s: string): number {
  let i = 0
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++
  return i
}

/**
 * Best-effort extraction of the call expression at a given line.
 *
 * Returns `{call, args}` where `call` is the FULL call expression
 * including the callee, arguments and matching closing paren
 * (e.g. `os.system("rm -rf " + user_input)`) and `args` is just the
 * parenthesised content for downstream display.
 *
 * When the matching ``)`` lies on a later line we accept the slice up
 * to the end of the input line — the caller can still pass a multi-line
 * window if it wants a tighter result. When no opening paren is found,
 * both fields are `null` and the caller will fall back to the raw
 * source line.
 */
function extractCallExpression(line: string): { call: string | null; args: string | null } {
  if (!line) return { call: null, args: null }
  // Find the rightmost identifier-followed-by-( on the line (handles
  // chained calls like `subprocess.run(...)` and `await foo.bar(...)`).
  const re = /([A-Za-z_$][\w$.]*)\s*\(/g
  let m: RegExpExecArray | null
  let lastMatch: { name: string; nameStart: number; openIdx: number } | null = null
  while ((m = re.exec(line)) !== null) {
    lastMatch = {
      name: m[1],
      nameStart: m.index,
      openIdx: m.index + m[0].length - 1,
    }
  }
  if (!lastMatch) return { call: null, args: null }
  // Balanced scan for the matching closing paren on the same line.
  let depth = 0
  let close = -1
  for (let i = lastMatch.openIdx; i < line.length; i++) {
    const c = line[i]
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  const argsStart = lastMatch.openIdx + 1
  const args = close > lastMatch.openIdx
    ? line.slice(argsStart, close).trim()
    : line.slice(argsStart).trim()
  // The full call expression: callee + balanced parens (or the entire
  // tail of the line when the closing paren isn't reachable). We
  // deliberately slice from `nameStart` so leading whitespace /
  // assignments are dropped, keeping the snippet focused on the call.
  const callEnd = close >= 0 ? close + 1 : line.length
  const call = line.slice(lastMatch.nameStart, callEnd).trim()
  return { call: call || null, args: args.length > 0 ? args : null }
}

/**
 * Heuristic: does `text` look like a runtime call expression
 * (``name(...)``) as opposed to a bare identifier or the empty string?
 * Used by `buildCodeContext` to decide whether the scanner-provided
 * snippet is rich enough to skip the file-line extraction step.
 */
function looksLikeFullCall(text: string | null | undefined): boolean {
  if (!text) return false
  return /[A-Za-z_$][\w$.]*\s*\(/.test(text) && text.includes(")")
}

function collectAgentToolPath(
  evidence_path: FindingInput["evidence_path"] | undefined,
): string[] {
  if (!Array.isArray(evidence_path)) return []
  return evidence_path
    .filter((e) => e && (e.kind === "agent" || e.kind === "tool" || e.kind === "caller"))
    .map((e) => `${e.kind}:${e.label}`)
    .slice(0, 8)
}

function collectEvidenceLabels(
  evidence_path: FindingInput["evidence_path"] | undefined,
): string[] {
  if (!Array.isArray(evidence_path)) return []
  return evidence_path
    .map((e) => {
      const loc = e.file && e.line ? ` (${e.file}:${e.line})` : ""
      return `${e.kind}: ${e.label}${loc}`
    })
    .slice(0, 12)
}

// ---------------------------------------------------------------------------
// Template fallback
// ---------------------------------------------------------------------------

const STRUCTURED_SECTIONS = [
  { key: "what_detected", prefix: "What was detected:" },
  { key: "why_risky", prefix: "Why it can be risky:" },
  { key: "why_may_be_okay", prefix: "Why this may be okay:" },
  { key: "what_to_verify", prefix: "What to verify:" },
] as const

/**
 * Build a deterministic explanation from the scanner's existing structured
 * `reason` text. This is what we return when the model is unavailable.
 *
 * The scanner's `reason` field is built by
 * `scanner/src/edge_agent_scanner/analyzers/finding_explanations.py::format_reason`
 * and always has the four sections above when it was emitted by the new IR
 * analyzers. If the finding pre-dates the structured format we fall back to
 * single-paragraph mode so the UI still has something to show.
 */
export function buildTemplateFallback(finding: FindingInput, source: ExplanationSource): FindingExplanationPayload {
  const reason = finding.reason ?? ""
  const sections: Partial<Record<(typeof STRUCTURED_SECTIONS)[number]["key"], string>> = {}
  let foundStructured = false
  for (let i = 0; i < STRUCTURED_SECTIONS.length; i++) {
    const { key, prefix } = STRUCTURED_SECTIONS[i]
    const start = reason.indexOf(prefix)
    if (start < 0) continue
    foundStructured = true
    const contentStart = start + prefix.length
    let end = reason.length
    for (let j = i + 1; j < STRUCTURED_SECTIONS.length; j++) {
      const next = reason.indexOf(STRUCTURED_SECTIONS[j].prefix, contentStart)
      if (next >= 0) {
        end = next
        break
      }
    }
    sections[key] = reason.slice(contentStart, end).trim()
  }

  const verifyText = sections.what_to_verify ?? ""
  const verifyList = verifyText
    .split(/(?:\n|;\s)+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    what_detected: sections.what_detected ?? (foundStructured ? "" : reason.trim() || finding.title),
    why_risky:
      sections.why_risky ??
      `Severity ${finding.severity} from rule ${finding.rule_id}. The static scanner flagged this without enough context to expand here.`,
    suggested_fix: finding.suggested_fix || "See scanner suggested-fix text.",
    // The template-only sections are populated in fallback payloads so the
    // UI can keep showing the scanner's "Why this may be okay" / "What to
    // verify" / "Confidence note" when the AI explainer is unavailable.
    // For successful AI payloads these fields are deliberately omitted
    // upstream so the drawer renders just the three project-specific
    // sections the user asked for.
    why_may_be_okay:
      sections.why_may_be_okay ??
      "May be a known-good usage; verify whether agent or user input can reach this code.",
    what_to_verify: verifyList.length > 0 ? verifyList.slice(0, 6) : [verifyText || "Confirm scanner evidence on the cited file:line."],
    confidence_note:
      source === "unavailable"
        ? "Generated from the scanner template because the AI explainer is currently unavailable."
        : "Generated from the deterministic scanner template; not personalized by AI.",
    source,
    model_used: null,
    cached: false,
  }
}

// ---------------------------------------------------------------------------
// AI call
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"

function buildSystemPrompt(): string {
  // The prompt is intentionally specific about the JSON shape AND about what
  // the model is NOT allowed to do (change severity / category / file /
  // line / evidence). The route also enforces those guarantees by ignoring
  // any of those fields if the model returns them, so this prompt is for
  // quality, not for safety — safety lives in the post-processing layer.
  return [
    "You are explaining one static scanner finding to a developer.",
    "Use the provided local code context to INFER what this specific code is doing.",
    "Do not give a generic explanation. Be concrete and project-specific.",
    "",
    "Return STRICT JSON with EXACTLY these three keys (and nothing else):",
    "  - what_detected: string",
    "  - why_risky: string",
    "  - suggested_fix: string",
    "Do NOT include severity, category, file, line, evidence, rule_id, model, source, why_may_be_okay, what_to_verify, confidence_note, or any extra keys.",
    "",
    "Rules for `what_detected`:",
    "- Read `code_context.call_expression` FIRST — it is the verbatim source of the call that triggered the finding (e.g. `os.system(\"rm -rf \" + user_input)`), not just the normalized sink name (`os.system`).",
    "- Build your explanation around what THAT call is doing. Mention the arguments, the operation, and the containing function/class when available.",
    "- Only fall back to the bare sink label / category if `code_context.call_expression` is empty.",
    "- If a command/tool string is visible (ffmpeg, rm, curl, python, sox, ...), name it and what it appears to do (e.g. 'This line appears to run ffmpeg to convert uploaded lecture audio before transcription.').",
    "- Mention the likely domain workflow (audio conversion, transcription, file cleanup, HTTP upload, DB write, etc.) when the context supports it.",
    "- If purpose is unclear, say exactly what is unclear and what extra context would be needed. Do not invent facts.",
    "- Avoid generic phrasing like 'this executes a command' unless the purpose is genuinely unknown.",
    "",
    "Rules for `why_risky`:",
    "- Explain the ACTUAL risk in this exact context.",
    "- For OS commands: focus on user-controlled filenames, paths, URLs, transcript text, shell=True, string concatenation in the command.",
    "- For data export / audio.export: focus on private content path, retention, external sharing.",
    "- For accuracy-regression / model-configuration findings, explain as a quality/accuracy risk, not a security bug — focus on summary / translation / action-item quality regression.",
    "- If `agent_reachable` is false, explicitly say: 'presence warning, not a confirmed agent exploit path'.",
    "- Use the word 'critical' only when severity is exactly 'critical'.",
    "- For TypeScript / React export-or-type cases, do NOT describe them as real data export unless the evidence proves runtime data export.",
    "",
    "Rule-specific framings — these OVERRIDE the generic templates:",
    "- `prompt-injection-placeholder`: ONLY frame this as prompt injection if the constructed string flows into an LLM/prompt sink (chat.completions.create / messages= / PromptTemplate / model.generate / tokenizer.apply_chat_template). If the code is a `print(...)`, `logger.*`, `st.write`, or any other non-LLM consumer, DO NOT call it prompt injection — explain that the scanner flagged a tainted f-string but it does not reach a model.",
    "- `env-proxy-mutation` with PATH/LD_LIBRARY_PATH/DYLD_LIBRARY_PATH/PYTHONPATH: this is a DLL/library/binary SEARCH PATH change, not network routing. Explain it as 'modifies the process search path used to LOAD libraries (e.g. PyTorch/cuDNN DLLs on Windows)'. Do NOT mention proxy or network routing for these keys.",
    "- `env-proxy-mutation` with HTTP_PROXY/HTTPS_PROXY/*_BASE_URL/*_ENDPOINT: this IS network routing. Explain it can silently redirect every outbound API/model call through an attacker-controlled endpoint.",
    "- `dangerous-tools` on `subprocess.Popen([...])` / `subprocess.run([...])` without `shell=True`: do NOT call it shell injection. Explain it as an external-process presence warning — focus on untrusted media/file path validation, trusted binary path (ffmpeg/sox/etc.), process timeout/cleanup, and output temp path restrictions.",
    "- `dangerous-tools` only counts as command injection if the call uses a STRING command with `shell=True` AND any argument is user/config-controlled.",
    "- `model-supply-chain-risk`: frame this as a supply-chain/remote-code-load risk. The artifact (.onnx/.pt/.safetensors/.bin/...) is downloaded at runtime; without a SHA256/signature check, the upstream URL/CDN can swap it. When ONNXRuntime/torch.load/pickle later loads it, the swap becomes code execution. Mention pinning to an immutable revision (HF commit SHA) AND checksum verification AND keeping TLS on.",
    "- `tls-verification-disabled`: explain as an active-MITM exposure. Severity should align with what the connection downloads (model/binary = high; generic HTTP = medium; localhost/test = low). Suggested fix is to ship a CA bundle and pass `verify=<path>`/`cafile=` rather than disabling verification.",
    "- `prompt-contract` with family=extraction: only mention output schema / null handling / hallucination guard. Do NOT recommend a tool-use policy or approval rule for extraction prompts.",
    "- `prompt-contract` with family=action: mention role, task boundary, tool-use policy, approval rules, unsafe action boundaries, output schema. This is the only family that needs an approval policy.",
    "- `dependency-risks` grouped: when the title says 'N low dependency risks in <file>', list a few example packages from the evidence (it includes them) and recommend pinning + lockfile + hashes; do NOT pick one package and treat it as the whole story.",
    "",
    "Rules for `suggested_fix`:",
    "- Give concrete, code-level guidance specific to the detected purpose.",
    "- For OS commands: prefer subprocess.run([...], shell=False), allow-list paths, use tempfile, avoid command-string concatenation, restrict cwd.",
    "- For audio/file exports: scope to least data, validate output path, enforce retention cleanup, block external sharing without explicit policy.",
    "- For model configuration: pin model id, add regression tests / gold examples for translation/summarization/action items.",
    "- If the command is fixed and already safe, suggest adding a small comment or a safe wrapper so the scanner can recognize it.",
    "",
    "Severity guardrail:",
    "- The static scanner is the source of truth for severity / category / file / line / evidence / rule_id. NEVER write text that contradicts or restates those (e.g. do not say 'this is critical' unless severity is exactly 'critical').",
    "",
    "Output format:",
    "- Plain language, under 80 words per field.",
    "- Respond with the JSON object only — no markdown, no fences.",
  ].join("\n")
}

/**
 * Approximate token count for the budget we want to enforce on the user
 * prompt. ~4 chars per token is a coarse but well-known heuristic for
 * English/code blends. We aim for ≤8k token total prompt (system+user).
 */
const PROMPT_CHAR_BUDGET = 28_000

function buildUserPrompt(
  finding: FindingInput,
  project: ProjectContext,
  codeContext: CodeContext,
): string {
  // Compact, code-aware context. We deliberately do NOT include the full
  // report or any file contents beyond the local window we extracted. All
  // strings inside `codeContext` were redacted upstream in buildCodeContext.
  const compact = {
    project_name: project.projectName ?? path.basename(project.resolvedProjectPath),
    project_type: project.projectType ?? null,
    finding: {
      title: finding.title,
      rule_id: finding.rule_id,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence ?? null,
      agent_reachable: finding.agent_reachable ?? false,
      file: finding.file,
      line: finding.line,
      evidence: redactSecrets(finding.evidence ?? ""),
      scanner_reference_reason: finding.reason,
      scanner_reference_suggested_fix: finding.suggested_fix,
    },
    code_context: {
      line: codeContext.line,
      before: codeContext.before,
      after: codeContext.after,
      function_name: codeContext.function_name,
      class_name: codeContext.class_name,
      function_body_excerpt: codeContext.function_body_excerpt,
      imports: codeContext.imports,
      call_expression: codeContext.call_expression,
      arguments_summary: codeContext.arguments_summary,
      agent_or_tool_path: codeContext.agent_or_tool_path,
      evidence_path: codeContext.evidence_path,
    },
  }

  let json = JSON.stringify(compact, null, 2)
  // Hard char budget so we don't blow past 6–8k tokens even on huge
  // function bodies. Trim the function_body_excerpt first, then before/
  // after windows, then bail out by truncating the JSON tail.
  if (json.length > PROMPT_CHAR_BUDGET) {
    if (codeContext.function_body_excerpt && codeContext.function_body_excerpt.length > 2000) {
      compact.code_context.function_body_excerpt =
        codeContext.function_body_excerpt.slice(0, 2000) + "\n# ... truncated ..."
      json = JSON.stringify(compact, null, 2)
    }
  }
  if (json.length > PROMPT_CHAR_BUDGET) {
    compact.code_context.before = codeContext.before.slice(-10)
    compact.code_context.after = codeContext.after.slice(0, 10)
    json = JSON.stringify(compact, null, 2)
  }
  if (json.length > PROMPT_CHAR_BUDGET) {
    json = json.slice(0, PROMPT_CHAR_BUDGET) + "\n/* ... truncated for budget ... */"
  }

  return [
    "Explain this finding for the developer who is reading the detail panel.",
    "Use the local code context to give a project-specific explanation.",
    "",
    "Project + finding + code context (JSON):",
    json,
    "",
    "Respond with the JSON object only — no markdown, no fences.",
  ].join("\n")
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Remove any occurrence of `secret` from `text`, plus a generic redaction
 * for anything that looks like an OpenAI/Anthropic-shaped key. Used before
 * returning ANY error string the client could observe — the AI key (whether
 * it came from process.env or from the user's browser-stored Settings) must
 * never appear in error messages, debug fields, or logs.
 */
function redactKey(text: string, secret: string | null | undefined): string {
  let out = text
  if (secret && secret.length >= 8) {
    out = out.split(secret).join("<redacted-api-key>")
  }
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "<redacted-api-key>")
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, "<redacted-api-key>")
  return out
}

export { redactKey as _redactKeyForTests }

/**
 * Parse + sanitize the model's JSON reply. The new schema is exactly three
 * AI fields: `what_detected`, `why_risky`, `suggested_fix`. Anything else
 * the model emits (severity / category / file / line / why_may_be_okay /
 * what_to_verify / confidence_note) is DISCARDED — the scanner stays the
 * source of truth, and the slim shape matches the UI's three-section panel.
 *
 * Returns null if the reply isn't usable (no JSON, missing required keys,
 * wrong types). The caller will fall back to the template when this
 * returns null.
 */
function parseModelReply(
  rawText: string,
): Pick<FindingExplanationPayload, "what_detected" | "why_risky" | "suggested_fix"> | null {
  if (!rawText) return null
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const o = parsed as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "")
  const what_detected = str("what_detected")
  const why_risky = str("why_risky")
  const suggested_fix = str("suggested_fix")
  if (!what_detected || !why_risky) return null
  return {
    what_detected,
    why_risky,
    suggested_fix: suggested_fix || "See scanner suggested-fix text.",
  }
}

async function callOpenAI(
  finding: FindingInput,
  project: ProjectContext,
  model: string,
  codeContext: CodeContext,
  opts: ExplainOptions,
): Promise<
  | { what_detected: string; why_risky: string; suggested_fix: string; model_used: string }
  | { error: string }
> {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) return { error: "missing_api_key" }

  const baseUrl = (opts.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/+$/, "")
  const url = `${baseUrl}/chat/completions`
  const body = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(finding, project, codeContext) },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" } as const,
  }

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (e) {
    // Defensive: redact any substring that looks like the key before it
    // can land in an error message bubbling out of fetch (some Node
    // versions include the URL or headers in network errors).
    const msg = redactKey(e instanceof Error ? e.message : String(e), apiKey)
    return { error: `network_error: ${msg}` }
  }

  if (!resp.ok) {
    // We do NOT echo `detail` back to the caller — provider error bodies
    // sometimes embed the rejected request (which contains the
    // Authorization header on some compat servers). The route also
    // swallows this `error` and returns the template fallback, but
    // keeping the message generic ensures the key never leaks even if
    // a future refactor forwards it.
    try {
      await resp.text()
    } catch {
      /* ignore */
    }
    return { error: `model_http_${resp.status}` }
  }

  let json: unknown
  try {
    json = await resp.json()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: `bad_response_json: ${msg}` }
  }

  const text = extractAssistantText(json)
  const parsed = parseModelReply(text)
  if (!parsed) return { error: "unparseable_model_reply" }
  return { ...parsed, model_used: model }
}

function extractAssistantText(json: unknown): string {
  if (!json || typeof json !== "object") return ""
  const choices = (json as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) return ""
  const first = choices[0] as Record<string, unknown>
  const msg = first?.message as Record<string, unknown> | undefined
  if (!msg) return ""
  if (typeof msg.content === "string") return msg.content
  // Some endpoints return content as an array of parts.
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("")
  }
  return ""
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

export interface ResolvedProject {
  resolved: string
  allowRoot: string
}

export function resolveAndValidateProjectPath(rawPath: unknown): ResolvedProject {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new ExplanationError("projectPath is required.", 400)
  }
  const allowRoot = getScanAllowRoot()
  const resolved = path.resolve(expandUserPath(rawPath))
  if (!isPathInside(resolved, allowRoot)) {
    throw new ExplanationError("projectPath is outside the allowed directory.", 403)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new ExplanationError("projectPath is not a directory.", 400)
  }
  return { resolved, allowRoot }
}

export class ExplanationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Compute an explanation for one finding. Cache → model → template fallback.
 *
 * This function is what the route handler calls. It's also unit-testable in
 * isolation because every external dependency (OpenAI fetch, env, cache IO)
 * is parameterizable through `ExplainOptions` + the cache file location.
 */
export async function explainOneFinding(
  finding: FindingInput,
  project: ProjectContext,
  opts: ExplainOptions = {},
): Promise<FindingExplanationPayload> {
  // Caller-supplied model (typically from the user's Settings → OpenAI slot)
  // wins over the env-driven default (gpt-4.1-mini). Trusting the user's
  // Settings choice means an explicit "I want gpt-4.1" still works without
  // requiring an env restart, while the default stays cheap and predictable.
  const callerModel =
    typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : null
  const model = callerModel ?? pickModel(finding)

  // Build the redacted local code context BEFORE computing the cache
  // fingerprint so that edits to the surrounding function invalidate the
  // cached answer. This also gates the AI prompt content.
  const codeContext = buildCodeContext(finding, project.resolvedProjectPath)
  const fp = fingerprintFinding(project.resolvedProjectPath, finding, model, codeContext)

  // 1. Cache hit short-circuit — no model call, no session-counter spend.
  if (!opts.skipCache) {
    const cache = readCache(project.resolvedProjectPath)
    const hit = cache.entries[fp]
    if (hit) {
      return { ...hit.payload, source: "cached_ai", cached: true }
    }
  }

  // 2. Optional per-session cap. Off by default — ops who want a guardrail
  // can set EDGE_AGENT_EXPLAINER_SESSION_CAP=N. Without that env var, the
  // explainer happily runs through the entire findings list.
  const cap = currentSessionCap()
  if (cap != null && SESSION_STATE.explanationsThisSession >= cap) {
    return buildTemplateFallback(finding, "unavailable")
  }

  // 3. API key check before incrementing the counter.
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    return buildTemplateFallback(finding, "template_fallback")
  }

  SESSION_STATE.explanationsThisSession += 1

  const result = await callOpenAI(finding, project, model, codeContext, opts)
  if ("error" in result) {
    const fallback = buildTemplateFallback(finding, "template_fallback")
    if (process.env.NODE_ENV !== "production") {
      fallback.debug_error = redactKey(result.error, apiKey)
    }
    return fallback
  }

  // Successful AI: emit ONLY the three AI fields. The template-only
  // sections are deliberately omitted so the UI renders just the three
  // project-specific sections (what / why / fix) the user asked for.
  const payload: FindingExplanationPayload = {
    what_detected: result.what_detected,
    why_risky: result.why_risky,
    suggested_fix: result.suggested_fix,
    source: "ai",
    model_used: result.model_used,
    cached: false,
  }

  // 4. Persist successful AI explanations to the per-project cache. The
  // cached payload keeps the same slim shape so cache hits also render
  // exactly three sections.
  const cache = readCache(project.resolvedProjectPath)
  cache.entries[fp] = {
    fingerprint: fp,
    payload: { ...payload, cached: true, source: "cached_ai" },
    created_at: new Date((opts.now ?? Date.now)()).toISOString(),
  }
  writeCacheAtomic(project.resolvedProjectPath, cache)

  return payload
}
