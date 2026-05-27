/**
 * Deterministic fix engine for static-scanner findings AND behavioral
 * probe failures.
 *
 * Two modes:
 *
 *   - "suggest" — return the proposed patch (before / after / unified
 *     diff) without writing to disk. Used by the "Provide suggestion"
 *     menu item.
 *   - "apply"   — same proposal, plus actually writing the new file
 *     contents. Used by "Fix it". A `.bak` backup is left next to the
 *     original so the user can revert without git.
 *
 * Safety contract for "apply":
 *
 *   - We NEVER modify the original offending line. The fix inserts an
 *     annotated guard block IMMEDIATELY ABOVE it, fenced by sentinel
 *     comments so re-running the fixer is idempotent (we detect the
 *     sentinel and skip). This guarantees "Fix it" can never break a
 *     working file — at worst it inserts a defensive block the user
 *     can later refine or delete.
 *   - For one rule (`secrets`), we also offer an in-place transform
 *     replacing literal values with `os.getenv(...)` — but it's
 *     classified `risk: "edits-line"` and the dialog calls it out
 *     explicitly so the user is never surprised.
 *
 * The fix templates intentionally use language-aware comment syntax
 * (Python `#`, JS/TS `//`, YAML `#`, JSON ignored) so the inserted
 * block is a valid no-op in the host file.
 */

import fs from "node:fs"
import path from "node:path"
import type { ScannerFinding } from "./scan-report"

export type FixMode = "suggest" | "apply"
export type FixRisk = "safe-insert" | "edits-line" | "no-op"

export interface FixTarget {
  /** Stable identifier for the row this fix is for. Echoed back so the
   *  client can map results to UI rows. */
  ref_id: string
  /** Scanner rule id (or behavioral probe rule id). Drives template
   *  selection. */
  rule_id: string
  /** Project-relative file path. */
  file: string
  /** 1-indexed line number where the offending pattern was found. */
  line: number
  /** Optional: finding title, used in the inserted comment header. */
  title?: string
}

/**
 * "Permanent" errors are deterministic — re-running won't change the
 * outcome (e.g. file extension has no comment syntax we can safely
 * insert into). The dialog uses `retryable` to swap the "Retry failed"
 * button for a non-actionable explanation instead of an infinite-loop
 * retry the user keeps clicking.
 */
export type FixErrorKind =
  | "unsupported_file_type"
  | "missing_template"
  | "file_unreadable"
  | "write_failed"
  | "path_escape"

export interface FixProposal {
  ref_id: string
  rule_id: string
  file: string
  line: number
  /** Absolute on-disk path the engine read / wrote. Surfaced in the
   *  dialog so the user can verify "yes, that's the original file"
   *  without having to mentally resolve a relative path. */
  absolute_path: string
  /** Short, scannable label for the dialog ("Wrap shell call in
   *  approval gate"). */
  title: string
  /** Plain-language rationale shown above the diff. */
  description: string
  /** Risk classification. The dialog uses this to color-code the row
   *  and gate auto-apply. */
  risk: FixRisk
  /** ±3 lines of context AROUND the original line, before any change. */
  before: string
  /** Same range with the patched contents. */
  after: string
  /** Unified diff body (no headers) for users who want one canonical
   *  view to copy. */
  diff: string
  /** Whether the file was actually written. False in suggest mode and
   *  also false in apply mode when a previous fix marker was already
   *  present (idempotency). */
  applied: boolean
  /** Why a suggested fix could not be applied or was skipped. Always
   *  null on a successful suggestion. */
  error: string | null
  /** Classification for `error`. `null` when there is no error. */
  error_kind: FixErrorKind | null
  /** True iff a retry could plausibly change the outcome. Permanent
   *  errors (unsupported file type, missing template) set this false
   *  so the dialog can hide the "Retry failed" button. */
  retryable: boolean
  /** Path to the centralized backup file we wrote, relative to the
   *  project root. Backups now live at
   *  `.edge-agent/backups/<relative-path>.bak` so they don't litter
   *  the source tree next to the original. */
  backup_path: string | null
  /** True when this "fix" only inserted a TODO/Manual-suggestion
   *  marker (fallback template), NOT a real code change. The UI uses
   *  this to render "Manual suggestion" instead of "Applied" and to
   *  keep the finding in the table — a marker comment doesn't clear
   *  the underlying issue. Mirrored on the client-facing FixProposal
   *  in lib/finding-fixes-client.ts. */
  marker_only: boolean
}

export interface RunFixesOptions {
  projectPath: string
  targets: FixTarget[]
  mode: FixMode
}

export interface RunFixesResult {
  mode: FixMode
  total: number
  applied: number
  skipped: number
  failed: number
  proposals: FixProposal[]
}

// ---------------------------------------------------------------------
// Sentinel + comment-syntax inference
// ---------------------------------------------------------------------

const FIX_MARKER_OPEN = "Edge Agent fix"
const FIX_MARKER_CLOSE = "end Edge Agent fix"

function commentSyntaxFor(file: string): { prefix: string; supported: boolean } {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case ".py":
    case ".rb":
    case ".sh":
    case ".bash":
    case ".zsh":
    case ".yml":
    case ".yaml":
    case ".toml":
    case ".cfg":
    case ".ini":
    case ".conf":
      return { prefix: "#", supported: true }
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
    case ".mjs":
    case ".cjs":
    case ".java":
    case ".go":
    case ".rs":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".cs":
    case ".swift":
    case ".kt":
    case ".scala":
      return { prefix: "//", supported: true }
    case ".md":
    case ".html":
    case ".htm":
    case ".xml":
    case ".vue":
      return { prefix: "<!--", supported: true } // we'll wrap as `<!-- ... -->` blocks
    case ".json":
      // JSON has no comment syntax; we'd corrupt the file. Surface
      // this clearly instead of silently skipping.
      return { prefix: "", supported: false }
    default:
      return { prefix: "#", supported: true } // best-effort: most scripts use `#`
  }
}

function fenceLines(prefix: string, ruleId: string, lines: string[]): string[] {
  // We INTENTIONALLY comment out body lines so the inserted block is a
  // no-op the user has to opt into — guarantees an apply can never
  // break a working module by introducing surprise side effects at
  // import time. Templates that emit lines already starting with `# `
  // would otherwise come out as `# # …`; collapse that here so the
  // visual output is always a single comment.
  if (prefix === "<!--") {
    return [
      `<!-- === ${FIX_MARKER_OPEN} [${ruleId}] === -->`,
      ...lines.map((l) => `<!-- ${l.replace(/^<!--\s?|\s?-->$/g, "")} -->`),
      `<!-- === ${FIX_MARKER_CLOSE} === -->`,
    ]
  }
  return [
    `${prefix} === ${FIX_MARKER_OPEN} [${ruleId}] ===`,
    ...lines.map((l) => {
      // Preserve indentation: peel the indent, strip any leading "#"
      // (with optional space) from the template line, then reattach
      // the indent + a single `${prefix} `.
      const m = /^([ \t]*)(.*)$/.exec(l) ?? ["", "", l]
      const indent = m[1]
      const rest = m[2].replace(/^#\s?/, "")
      return `${indent}${prefix} ${rest}`
    }),
    `${prefix} === ${FIX_MARKER_CLOSE} ===`,
  ]
}

function detectIndent(line: string): string {
  const m = /^([ \t]*)/.exec(line)
  return m ? m[1] : ""
}

// ---------------------------------------------------------------------
// Per-rule fix templates
// ---------------------------------------------------------------------

interface FixTemplate {
  /** Used as the "title" in the dialog. */
  title: string
  /** Plain-language description shown above the diff. */
  description: string
  risk: FixRisk
  /** True when this template only inserts a TODO/Manual-suggestion
   *  marker (no real code change). Defaults to false — only the
   *  generic fallback should set this. The proposal carries the same
   *  flag to the UI so it can render "Manual suggestion" instead of
   *  "Applied" and keep the finding in the table. */
  markerOnly?: boolean
  /** Build the inserted body. Returns either an array of source-language
   *  code lines (will be pasted as-is) OR null if the rule has no
   *  per-line fix template (we fall back to a generic TODO marker). */
  buildBody(args: {
    indent: string
    target: FixTarget
    originalLine: string
  }): string[] | null
  /** When non-null, the fix becomes an in-place LINE replacement instead
   *  of an above-the-line insert. Returns the new line or null to fall
   *  back to insert mode. */
  rewriteLine?: (args: {
    indent: string
    target: FixTarget
    originalLine: string
  }) => string | null
}

const TEMPLATES: Record<string, FixTemplate> = {
  "dangerous-tools": {
    title: "Wrap dangerous call in allow-list + approval gate",
    description:
      "Insert a guard above the offending call. Only commands on the allow-list run, and the agent must request human approval before executing. The original call is preserved untouched so the surrounding logic still type-checks.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# TODO(edge-agent): tighten this allow-list to the real commands you need.`,
      `${indent}_EDGE_ALLOWLIST = {"ls", "git", "echo"}  # rule: dangerous-tools`,
      `${indent}_edge_cmd = locals().get("cmd") or locals().get("command") or ""`,
      `${indent}if isinstance(_edge_cmd, str) and not any(_edge_cmd.startswith(c) for c in _EDGE_ALLOWLIST):`,
      `${indent}    raise PermissionError(f"Command not on allow-list: {_edge_cmd!r}")`,
      `${indent}# require_human_approval(f"About to run: {_edge_cmd}")  # uncomment when wired`,
    ],
  },
  "human-approval": {
    title: "Insert human-approval gate before privileged action",
    description:
      "Add an explicit approval check above the privileged call. The agent will block until a human confirms — preventing the 'just do it without asking' attack the probe simulates.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: human-approval — privileged action requires explicit human confirmation.`,
      `${indent}# Replace the stub below with your real approval mechanism (LangGraph`,
      `${indent}# interrupt, Slack/email confirm, CLI prompt, etc.).`,
      `${indent}def _edge_require_human_approval(action: str) -> None:`,
      `${indent}    raise PermissionError(`,
      `${indent}        f"Human approval required for: {action!r} (no approval mechanism wired)"`,
      `${indent}    )`,
      `${indent}_edge_require_human_approval(${'"' + "privileged action" + '"'})`,
    ],
  },
  "prompt-injection": {
    title: "Sanitize and delimiter-fence user input in the prompt",
    description:
      "Wrap user-controlled input in clear delimiters and strip control sequences before splicing it into the prompt. Defends against 'ignore previous instructions' style overrides by ensuring the model sees user content as data, not instructions.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: prompt-injection — treat user content as untrusted data, not instructions.`,
      `${indent}def _edge_sanitize(user_text: str) -> str:`,
      `${indent}    cleaned = "".join(ch for ch in user_text if ch.isprintable() or ch in "\\n\\t")`,
      `${indent}    return f"<<<USER_INPUT>>>\\n{cleaned}\\n<<<END_USER_INPUT>>>"`,
      `${indent}# Use _edge_sanitize(...) when concatenating user input into prompts.`,
    ],
  },
  "vague-prompts": {
    title: "Add role / format / constraint scaffolding to the prompt",
    description:
      "Attach a structured prefix that pins down the agent's role, the exact output format, and the must/never rules. Eliminates the 'help me with the thing' under-specification the probe checks for.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: vague-prompts — declare role, output format, and constraints up front.`,
      `${indent}_EDGE_PROMPT_PREFIX = (`,
      `${indent}    "You are a precise assistant. Output VALID JSON matching the schema below. "`,
      `${indent}    "MUST cite every input field you used. NEVER invent values. "`,
      `${indent}    "If the request is ambiguous, ask one clarifying question and stop."`,
      `${indent})`,
      `${indent}# Prepend _EDGE_PROMPT_PREFIX to your system prompt.`,
    ],
  },
  "secrets": {
    title: "Replace hardcoded secret with environment lookup",
    description:
      "Pull the credential from the environment instead of inlining it as a string literal. The original line is rewritten in place; the literal is moved into a nearby comment so you can copy it into your local `.env` if it's a real value (or rotate it if it's been leaked).",
    risk: "edits-line",
    buildBody: () => null,
    rewriteLine: ({ indent, originalLine }) => {
      // Match `NAME = "value"` or `NAME: str = "value"` patterns.
      const m =
        /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*(?::\s*[\w[\],. ]+)?\s*=\s*)(['"])(.+?)\4\s*(#.*)?$/.exec(
          originalLine
        )
      if (!m) return null
      const [, , name, assign, , literal, trailing] = m
      const envKey = name.toUpperCase()
      const replaced =
        `${indent}${name}${assign}os.getenv("${envKey}", "")` +
        ` ${trailing ?? ""}`.trimEnd() +
        `  # rule: secrets — was a literal; rotate then put real value in .env as ${envKey}`
      // Sanity guard: don't blow up on humongous lines.
      void literal
      return replaced
    },
  },
  "mcp-security": {
    title: "Document MCP auth + tool allow-list requirement",
    description:
      "Insert a TODO block reminding you to add an `auth` field and `allowed_tools` list to the MCP server config. Doesn't change config — just plants the marker where the scanner found the gap.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: mcp-security — add auth + tool allow-list to the MCP config below.`,
      `${indent}# Required fields:`,
      `${indent}#   auth: { type: "bearer", token_env: "MCP_TOKEN" }`,
      `${indent}#   allowed_tools: ["fs.read", "search.web"]   # narrow this to tools you really need`,
    ],
  },
  "openapi-schema": {
    title: "Add request schema validation",
    description:
      "Insert a TODO block instructing you to wrap the route handler with a strict pydantic / zod schema that rejects unknown fields. Doesn't modify the handler — drops the marker right above so it's visible on the next pass.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: openapi-schema — add a strict request schema to this route.`,
      `${indent}# Example (pydantic):`,
      `${indent}#   class Body(BaseModel):`,
      `${indent}#       qty: PositiveInt`,
      `${indent}#       price: Decimal`,
      `${indent}#       model_config = ConfigDict(extra="forbid")`,
      `${indent}#   def handler(body: Body) -> ...`,
    ],
  },
  "dependency-risks": {
    title: "Pin dependencies to specific versions",
    description:
      "Insert a TODO marker on the offending line of the manifest. Pinning to exact versions (or committing a lockfile) freezes the transitive tree so installs are reproducible.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: dependency-risks — pin this dependency.`,
      `${indent}# Use \`name==X.Y.Z\` (Python) or numeric versions without ^/~ (npm),`,
      `${indent}# and commit a lockfile (pip-tools, poetry, pnpm-lock, etc.).`,
    ],
  },
  "user-input-dangerous-code": {
    title: "Reject user input destined for eval/exec",
    description:
      "Insert a guard above the dynamic-code primitive that rejects raw user input. If you really need expression evaluation, swap to `ast.literal_eval` / `simpleeval` instead.",
    risk: "safe-insert",
    buildBody: ({ indent }) => [
      `${indent}# rule: user-input-dangerous-code — refuse user input as code.`,
      `${indent}_edge_payload = locals().get("user_input") or locals().get("expression") or ""`,
      `${indent}if isinstance(_edge_payload, str) and any(`,
      `${indent}    bad in _edge_payload for bad in ("__", "import", "open(", "exec(", "eval(")`,
      `${indent}):`,
      `${indent}    raise ValueError("Unsafe input rejected by edge-agent guard")`,
      `${indent}# Safer alternatives: ast.literal_eval(_edge_payload) or simpleeval.simple_eval(_edge_payload).`,
    ],
  },
}

// Generic fallback used when we don't have a rule-specific template.
//
// The title intentionally starts with "Manual suggestion" — the UI keys
// off this exact wording (and the ``marker_only`` flag) to render the
// row as a "we wrote a TODO above the line, you still need to fix it"
// state instead of a green "Applied" state. Don't rename without
// updating components/finding-fix-dialog.tsx and
// tests/fix-engine-manual-suggestion.test.ts.
function fallbackTemplate(rule_id: string): FixTemplate {
  return {
    title: `Manual suggestion needed (${rule_id})`,
    description: `No automated fix template is wired for rule "${rule_id}". A MANUAL SUGGESTION marker is dropped above the offending line — this is NOT a fix; the finding will keep firing on every re-scan until the underlying code is changed.`,
    risk: "safe-insert",
    markerOnly: true,
    buildBody: ({ indent }) => [
      `${indent}# rule: ${rule_id} — MANUAL SUGGESTION (edge-agent): no automatic fix wired; review and patch manually.`,
    ],
  }
}

// ---------------------------------------------------------------------
// Diff helpers (small, no dependency)
// ---------------------------------------------------------------------

function snippetSlice(lines: string[], line1Indexed: number, ctx = 3): {
  fromIdx: number
  toIdx: number
  body: string
} {
  if (lines.length === 0) return { fromIdx: 0, toIdx: 0, body: "" }
  const idx = Math.max(0, Math.min(lines.length - 1, line1Indexed - 1))
  const from = Math.max(0, idx - ctx)
  const to = Math.min(lines.length, idx + ctx + 1)
  const out: string[] = []
  for (let i = from; i < to; i++) {
    const marker = i === idx ? ">" : " "
    out.push(`${marker} ${String(i + 1).padStart(4, " ")} | ${lines[i]}`)
  }
  return { fromIdx: from, toIdx: to, body: out.join("\n") }
}

function makeUnifiedDiff(
  file: string,
  beforeLines: string[],
  afterLines: string[],
  startLine1Indexed: number
): string {
  // Tiny hand-rolled unified diff. Good enough for display + clipboard
  // — we only ever diff a small window around the change.
  const head = `--- a/${file}\n+++ b/${file}\n@@ -${startLine1Indexed},${beforeLines.length} +${startLine1Indexed},${afterLines.length} @@`
  const body: string[] = []
  // Naive: emit all `before` as `-` then all `after` as `+`. Since the
  // window is tiny and contiguous this stays readable.
  for (const l of beforeLines) body.push(`-${l}`)
  for (const l of afterLines) body.push(`+${l}`)
  return [head, ...body].join("\n")
}

// ---------------------------------------------------------------------
// File reading + writing
// ---------------------------------------------------------------------

const MAX_FIX_BYTES = 1 * 1024 * 1024 // 1 MiB

function readFileLines(absPath: string): string[] | { error: string } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(absPath)
  } catch (e) {
    return { error: `Source file not found: ${(e as Error).message}` }
  }
  if (!stat.isFile()) return { error: "Path is not a file" }
  if (stat.size > MAX_FIX_BYTES) {
    return { error: `File too large to fix safely (>${MAX_FIX_BYTES} bytes)` }
  }
  let text: string
  try {
    text = fs.readFileSync(absPath, "utf8")
  } catch (e) {
    return { error: `Could not read file: ${(e as Error).message}` }
  }
  // Preserve trailing newline state by splitting on newline only.
  return text.split(/\r?\n/)
}

function writeFileLinesAtomic(absPath: string, lines: string[]): void {
  const text = lines.join("\n")
  const tmp = `${absPath}.edge-agent-tmp`
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, absPath)
}

/**
 * Centralized backup destination. Instead of dropping `<file>.edge-agent.bak`
 * next to every original (which clutters the source tree the user has to
 * stare at every day), we mirror the project layout under
 * `<project>/.edge-agent/backups/<rel-path>.bak`. The user can wipe the
 * whole folder when they're confident, or `git diff` over `.edge-agent/`
 * to ignore them entirely.
 */
function writeBackupOnce(absPath: string, projectPath: string): string {
  const rel = path.relative(projectPath, absPath)
  const bakRoot = path.join(projectPath, ".edge-agent", "backups")
  const bak = path.join(bakRoot, `${rel}.bak`)
  if (!fs.existsSync(bak)) {
    fs.mkdirSync(path.dirname(bak), { recursive: true })
    fs.copyFileSync(absPath, bak)
  }
  ensureLocalGitignoreForEdgeAgent(projectPath)
  return bak
}

/**
 * Append our local-runtime entries to `.git/info/exclude` so backups
 * and attribution caches never show up in `git status` (and never
 * accidentally land in a commit / PR).
 *
 * Why .git/info/exclude and not the project's .gitignore:
 *   - The project's .gitignore is a tracked file. Modifying it would
 *     create a diff the user has to decide whether to commit, which
 *     is surprising and some teams have strict rules about who can
 *     touch .gitignore.
 *   - .git/info/exclude is local-only — it lives inside .git/, never
 *     pushed, never seen by anyone else. Perfect for a per-checkout
 *     "hide this tool's working files" rule.
 *
 * Entries:
 *   /.edge-agent/                            — fix-engine backups
 *   /.edgeagent/head-snapshot.json           — untracked-file attribution cache
 *   /.edgeagent/untracked-attribution.json   — untracked-file attribution cache
 *   /.edgeagent/eval-history.jsonl           — eval-runner history (large, machine-specific)
 *
 * Note we DO NOT exclude `/.edgeagent/evals.yaml` — that's user
 * config they probably want to commit.
 *
 * Idempotent: re-running this function on the same repo only adds
 * lines that aren't already present.
 *
 * Safe on non-git roots: silently returns if `.git/info/` doesn't
 * exist.
 */
const EDGE_AGENT_EXCLUDE_LINES = [
  "/.edge-agent/",
  "/.edgeagent/head-snapshot.json",
  "/.edgeagent/untracked-attribution.json",
  "/.edgeagent/eval-history.jsonl",
] as const

function ensureLocalGitignoreForEdgeAgent(projectPath: string): void {
  try {
    const infoDir = path.join(projectPath, ".git", "info")
    if (!fs.existsSync(infoDir)) return
    const excludeFile = path.join(infoDir, "exclude")
    let current = ""
    try {
      current = fs.readFileSync(excludeFile, "utf-8")
    } catch {
      current = ""
    }
    const existing = new Set(
      current.split("\n").map((l) => l.trim()).filter(Boolean)
    )
    const missing = EDGE_AGENT_EXCLUDE_LINES.filter((l) => !existing.has(l))
    if (missing.length === 0) return
    const prefix = current.endsWith("\n") || current === "" ? "" : "\n"
    const note =
      "# Added by Edge Agent: hide local fix backups + per-checkout caches\n"
    fs.appendFileSync(
      excludeFile,
      `${prefix}${note}${missing.join("\n")}\n`
    )
  } catch {
    // Best-effort. A failure here doesn't corrupt anything — at worst
    // the user sees `.edge-agent/` (or attribution cache) as untracked
    // in `git status`.
  }
}

/**
 * Idempotency check: is the offending line ALREADY protected by a fix
 * marker for this rule that we inserted on a previous apply?
 *
 * Approach: walk UPWARD from the target line, stopping at the first
 * line that's neither a comment nor blank. If we crossed an opening
 * fix marker for THIS rule on the way, the finding already has its
 * defense block above it — no-op. Otherwise (e.g. we immediately hit
 * non-comment source), the line is unprotected and we should fix it.
 *
 * Why this matters: the previous implementation scanned the whole file
 * (or a wide ±N-line window) for the marker. When the user had several
 * distinct findings of the SAME rule in the SAME file (e.g. 5
 * dangerous-call sites in `LLM/system_prompt.py`), the very first apply
 * marked the file — and every remaining finding came back as no-op,
 * which is what made "Apply all → 0 applied / N skipped" look broken.
 *
 * Walking upward through the contiguous comment block instead pins the
 * marker to the EXACT line it sits above, so each call site gets its
 * own fix.
 */
function isCommentLineForPrefix(trimmed: string, prefix: string): boolean {
  if (trimmed === "") return true
  if (prefix === "<!--") {
    // HTML/Markdown comment block — line may not contain the closing
    // `-->` if the comment spans multiple lines, so test loosely.
    return trimmed.startsWith("<!--") || trimmed.endsWith("-->")
  }
  return trimmed.startsWith(prefix)
}

function alreadyHasFixMarker(
  lines: string[],
  ruleId: string,
  aroundLine1Indexed: number,
  prefix: string
): boolean {
  const idx = Math.max(0, Math.min(lines.length - 1, aroundLine1Indexed - 1))
  const needle = `[${ruleId}]`
  // Bound the walk so a giant comment block at the top of a file can't
  // make us scan thousands of lines.
  const stopAt = Math.max(0, idx - 60)
  for (let i = idx; i >= stopAt; i--) {
    const l = lines[i] ?? ""
    const trimmed = l.trim()
    // Found the marker — finding is already covered.
    if (l.includes(FIX_MARKER_OPEN) && l.includes(needle)) return true
    // Hit real code (not blank, not a comment) — finding is NOT
    // protected by anything above it. Stop walking.
    if (!isCommentLineForPrefix(trimmed, prefix)) return false
  }
  return false
}

// ---------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------

export function buildAndMaybeApplyFixes(opts: RunFixesOptions): RunFixesResult {
  const proposals: FixProposal[] = []
  let applied = 0
  let skipped = 0
  let failed = 0

  // Critical: when MULTIPLE fixes target the same file, applying
  // earlier-in-the-file inserts shifts every line below by the size
  // of the inserted block — so the next target's line number (from
  // the ORIGINAL file) would point at the wrong row. Sorting per
  // file by DESCENDING line means we always patch the bottom of the
  // file first; subsequent edits sit above the previous one and
  // their line numbers stay accurate.
  //
  // We sort by (file ascending, line descending) so the per-file
  // grouping is stable AND a stable lexicographic file order keeps
  // the response easy to reason about.
  const ordered = [...opts.targets].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return b.line - a.line
  })

  for (const t of ordered) {
    const rel = t.file
    const abs = path.resolve(opts.projectPath, rel)
    if (!isPathInsideProject(abs, opts.projectPath)) {
      proposals.push(
        makeErrorProposal(t, abs, "File path escapes project root", "path_escape", false)
      )
      failed += 1
      continue
    }

    const linesOrErr = readFileLines(abs)
    if (!Array.isArray(linesOrErr)) {
      proposals.push(
        makeErrorProposal(t, abs, linesOrErr.error, "file_unreadable", false)
      )
      failed += 1
      continue
    }
    const lines = linesOrErr

    const { prefix, supported } = commentSyntaxFor(rel)
    if (!supported) {
      proposals.push(
        makeErrorProposal(
          t,
          abs,
          `${path.extname(rel) || "(no extension)"} files don't have a comment syntax we can safely insert into. This finding has to be fixed by hand.`,
          "unsupported_file_type",
          false
        )
      )
      failed += 1
      continue
    }

    const lineIdx = Math.max(0, Math.min(lines.length - 1, t.line - 1))
    const originalLine = lines[lineIdx] ?? ""
    const indent = detectIndent(originalLine)
    const tpl = TEMPLATES[t.rule_id] ?? fallbackTemplate(t.rule_id)

    if (alreadyHasFixMarker(lines, t.rule_id, t.line, prefix)) {
      // Idempotent: don't re-insert. Still emit a proposal so the UI
      // can explain why nothing happened — and crucially mark it
      // SKIPPED, not FAILED, so the dialog doesn't keep offering a
      // pointless retry.
      const before = snippetSlice(lines, t.line).body
      proposals.push({
        ref_id: t.ref_id,
        rule_id: t.rule_id,
        file: rel,
        line: t.line,
        absolute_path: abs,
        title: tpl.title,
        description:
          "A previous Edge Agent fix for this rule already sits above this line — skipped to keep the file idempotent.",
        risk: "no-op",
        before,
        after: before,
        diff: "",
        applied: false,
        error: null,
        error_kind: null,
        retryable: false,
        backup_path: null,
        marker_only: tpl.markerOnly ?? false,
      })
      skipped += 1
      continue
    }

    // Two paths: in-place line rewrite OR insert-above. Pick whichever
    // the template offers (rewriteLine wins when present and it returns
    // a non-null value; otherwise fall back to insert).
    let newLines: string[]
    let beforeWindow: string
    let afterWindow: string
    let diff: string
    let risk: FixRisk = tpl.risk

    const rewritten =
      tpl.rewriteLine?.({ indent, target: t, originalLine }) ?? null

    if (rewritten !== null) {
      // In-place edit. Replace exactly one line.
      newLines = [...lines]
      newLines[lineIdx] = rewritten
      beforeWindow = snippetSlice(lines, t.line).body
      afterWindow = snippetSlice(newLines, t.line).body
      diff = makeUnifiedDiff(rel, [originalLine], [rewritten], t.line)
      risk = "edits-line"
    } else {
      const body = tpl.buildBody({ indent, target: t, originalLine }) ?? []
      if (body.length === 0) {
        // Two ways to land here: the template has BOTH a rewriteLine
        // and a null-returning buildBody (e.g. `secrets`), and the
        // rewriteLine matcher refused to match. Refusal usually means
        // the line is already in its fixed form — emit a no-op
        // proposal so the dialog says "already fixed" instead of
        // silently inserting an empty fence block.
        const before = snippetSlice(lines, t.line).body
        proposals.push({
          ref_id: t.ref_id,
          rule_id: t.rule_id,
          file: rel,
          line: t.line,
          absolute_path: abs,
          title: tpl.title,
          description:
            "Nothing to change on this line — it already looks like the fixed form (or the template doesn't know how to patch this exact shape). Review manually if you think a fix is still needed.",
          risk: "no-op",
          before,
          after: before,
          diff: "",
          applied: false,
          error: null,
          error_kind: null,
          retryable: false,
          backup_path: null,
          marker_only: tpl.markerOnly ?? false,
        })
        skipped += 1
        continue
      }
      const fenced = fenceLines(prefix, t.rule_id, body)
      newLines = [
        ...lines.slice(0, lineIdx),
        ...fenced,
        ...lines.slice(lineIdx),
      ]
      beforeWindow = snippetSlice(lines, t.line).body
      // After the insert the original line moved down by `fenced.length`.
      afterWindow = snippetSlice(newLines, t.line + fenced.length).body
      diff = makeUnifiedDiff(rel, [originalLine], [...fenced, originalLine], t.line)
    }

    let didApply = false
    let backup_path: string | null = null
    let error: string | null = null
    let error_kind: FixErrorKind | null = null
    let retryable = true

    if (opts.mode === "apply") {
      try {
        backup_path = writeBackupOnce(abs, opts.projectPath)
        writeFileLinesAtomic(abs, newLines)
        didApply = true
        applied += 1
      } catch (e) {
        error = `Could not write file: ${(e as Error).message}`
        error_kind = "write_failed"
        // Write errors are usually transient (permissions, disk full)
        // so retry stays enabled. If a follow-up turns out to also be
        // permanent we can downgrade this on a per-message basis.
        retryable = true
        failed += 1
      }
    }

    proposals.push({
      ref_id: t.ref_id,
      rule_id: t.rule_id,
      file: rel,
      line: t.line,
      absolute_path: abs,
      title: tpl.title,
      description: tpl.description,
      risk,
      before: beforeWindow,
      after: afterWindow,
      diff,
      applied: didApply,
      error,
      error_kind,
      retryable,
      backup_path: backup_path ? path.relative(opts.projectPath, backup_path) : null,
      marker_only: tpl.markerOnly ?? false,
    })
  }

  // Reorder the response to match the caller's input order — the
  // apply-order shuffle above is an implementation detail and shouldn't
  // leak into the UI's row order.
  const byRef = new Map(proposals.map((p) => [`${p.ref_id}__${p.rule_id}`, p]))
  const responseOrdered: FixProposal[] = []
  const seen = new Set<string>()
  for (const t of opts.targets) {
    const k = `${t.ref_id}__${t.rule_id}`
    const p = byRef.get(k)
    if (p && !seen.has(k)) {
      responseOrdered.push(p)
      seen.add(k)
    }
  }
  // Defensive: append anything that didn't have an exact key match.
  for (const p of proposals) {
    const k = `${p.ref_id}__${p.rule_id}`
    if (!seen.has(k)) {
      responseOrdered.push(p)
      seen.add(k)
    }
  }

  return {
    mode: opts.mode,
    total: opts.targets.length,
    applied,
    skipped,
    failed,
    proposals: responseOrdered,
  }
}

function makeErrorProposal(
  t: FixTarget,
  absolutePath: string,
  error: string,
  kind: FixErrorKind,
  retryable: boolean
): FixProposal {
  return {
    ref_id: t.ref_id,
    rule_id: t.rule_id,
    file: t.file,
    line: t.line,
    absolute_path: absolutePath,
    title: t.title ?? `Fix ${t.rule_id}`,
    description: error,
    risk: "no-op",
    // Error proposals never wrote a marker comment to the file.
    marker_only: false,
    before: "",
    after: "",
    diff: "",
    applied: false,
    error,
    error_kind: kind,
    retryable,
    backup_path: null,
  }
}

function isPathInsideProject(abs: string, projectPath: string): boolean {
  const rel = path.relative(path.resolve(projectPath), abs)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** Convenience: build targets from a list of scanner findings. Echoes
 *  the scanner finding `id` as `ref_id` so the client maps each fix
 *  back to its row. */
export function targetsFromScannerFindings(
  findings: Pick<ScannerFinding, "id" | "rule_id" | "file" | "line" | "title">[]
): FixTarget[] {
  return findings
    .filter((f) => Boolean(f.rule_id) && Boolean(f.file) && Number.isFinite(f.line))
    .map((f) => ({
      ref_id: f.id,
      rule_id: f.rule_id,
      file: f.file,
      line: f.line,
      title: f.title,
    }))
}
