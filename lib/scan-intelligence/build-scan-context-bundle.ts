/**
 * Build a small, redacted, size-capped context bundle for one cluster or
 * surface. This is the ONLY code that reads source for the LLM, and it
 * is deliberately conservative:
 *
 *   - Never sends the whole repo, node_modules, .git, .env files, or
 *     huge generated files.
 *   - Reads only the containing function/class body plus a focused line
 *     window and the source→sink path nodes' windows.
 *   - Redacts secrets via the canonical `redactSecrets` before any text
 *     enters the bundle.
 *   - Caps total size to the mode's token budget (chars/4 heuristic).
 *   - Rejects path traversal — files must resolve inside the project.
 *
 * Beyond raw slices, the bundle now carries STRUCTURED context the
 * verifier/gap-auditor can reason over without guessing:
 *
 *   - the containing function/class name + signature + body,
 *   - a structured source→sink path (kind/label/file:line per node),
 *   - structured guards/sanitizers detected in the function body,
 *   - nearby route/tool/prompt/model context from the scan report.
 *
 * Returns `null` when nothing safe could be read.
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { redactSecrets } from "../server-finding-explanations"
import { findContainingBlock, type CodeBlock } from "./code-structure"
import { GUARD_PATTERNS, matchingLines } from "./patterns"
import type { Cluster, EvidencePathNode, RiskSurface } from "./types"

const WINDOW = 20 // lines before/after the focus line
const CHARS_PER_TOKEN = 4
const MAX_FILE_BYTES = 512 * 1024 // skip huge/generated files
const MAX_BLOCK_BODY_LINES = 120
const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
])

export interface ScanContextBundle {
  text: string
  files: string[]
  tokens: number
  contextHash: string
}

interface Slice {
  file: string
  startLine: number
  lines: string[]
  /** Optional label rendered in the slice header (e.g. function name). */
  label?: string
}

function isUnsafeRelPath(rel: string): boolean {
  if (!rel) return true
  if (path.isAbsolute(rel)) return true
  const parts = rel.split(/[\\/]/)
  if (parts.includes("..")) return true
  if (parts.some((p) => SKIP_SEGMENTS.has(p))) return true
  if (/\.env(\.|$)/i.test(rel)) return true
  return false
}

/** Resolve a finding-relative file path safely inside `projectPath`. */
function safeResolve(projectPath: string, rel: string): string | null {
  if (isUnsafeRelPath(rel)) return null
  const abs = path.resolve(projectPath, rel)
  const root = path.resolve(projectPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function readAllLines(projectPath: string, rel: string): string[] | null {
  const abs = safeResolve(projectPath, rel)
  if (!abs) return null
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    return fs.readFileSync(abs, "utf-8").split(/\r?\n/)
  } catch {
    return null
  }
}

function windowSlice(rel: string, all: string[], focusLine: number): Slice {
  const focus = Number.isFinite(focusLine) && focusLine > 0 ? focusLine : 1
  const start = Math.max(1, focus - WINDOW)
  const end = Math.min(all.length, focus + WINDOW)
  const lines = all.slice(start - 1, end).map((l) => redactSecrets(l))
  return { file: rel, startLine: start, lines }
}

function blockSlice(rel: string, all: string[], block: CodeBlock): Slice {
  const start = block.startLine
  const end = Math.min(all.length, block.endLine, start + MAX_BLOCK_BODY_LINES - 1)
  const lines = all.slice(start - 1, end).map((l) => redactSecrets(l))
  return {
    file: rel,
    startLine: start,
    lines,
    label: `${block.kind} ${block.name}`,
  }
}

/** Render the structured source→sink path (no file reads needed). */
function renderPath(nodes: EvidencePathNode[] | undefined): string | null {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const rows = nodes.map((n, i) => {
    const loc = n.file ? ` (${n.file}${typeof n.line === "number" ? `:${n.line}` : ""})` : ""
    const arrow = i === 0 ? "" : "-> "
    return `  ${arrow}[${redactSecrets(n.kind)}] ${redactSecrets(n.label)}${loc}`
  })
  return `SOURCE->SINK PATH:\n${rows.join("\n")}`
}

/** Render structured guards/sanitizers found inside the function body. */
function renderGuards(block: Slice | null): string | null {
  if (!block) return null
  const hits = matchingLines(GUARD_PATTERNS, block.lines, block.startLine)
  if (hits.length === 0) return null
  const rows = hits.map((h) => `  - ${block.file}:${h.line}: ${h.text}`)
  return `GUARDS / SANITIZERS DETECTED:\n${rows.join("\n")}`
}

/**
 * Render nearby route/tool/prompt/model context for `file` from the raw
 * scan report inventories. Text-only — does NOT read additional files, so
 * the bundle's `files` list stays limited to the focused source.
 */
function renderRelatedContext(
  report: Record<string, unknown> | undefined,
  file: string,
): string | null {
  if (!report) return null
  const buckets: Array<[string, string]> = [
    ["agents_detected", "agent"],
    ["tools_detected", "tool"],
    ["prompts_detected", "prompt"],
    ["models_detected", "model"],
    ["routes_detected", "route"],
  ]
  const rows: string[] = []
  for (const [key, kind] of buckets) {
    const arr = report[key]
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (e.file !== file) continue
      const name = typeof e.name === "string" ? e.name : kind
      const line = typeof e.line === "number" ? `:${e.line}` : ""
      rows.push(`  - ${kind}: ${redactSecrets(String(name))} (${file}${line})`)
      if (rows.length >= 12) break
    }
    if (rows.length >= 12) break
  }
  if (rows.length === 0) return null
  return `ROUTE / TOOL / PROMPT / MODEL CONTEXT:\n${rows.join("\n")}`
}

function sliceBlock(s: Slice): string {
  const header = s.label
    ? `--- ${s.file}:${s.startLine} (${s.label}) ---`
    : `--- ${s.file}:${s.startLine} ---`
  const body = s.lines.map((l, idx) => `${s.startLine + idx} | ${l}`).join("\n")
  return `${header}\n${body}`
}

/**
 * Assemble structured text parts + code slices under the token budget.
 * Structured parts come first (cheap, high signal); slices fill the rest.
 */
function assemble(
  parts: Array<string | null>,
  slices: Slice[],
  tokenCap: number,
): ScanContextBundle | null {
  const charCap = Math.max(1, tokenCap) * CHARS_PER_TOKEN
  const blocks: string[] = []
  const files: string[] = []
  let used = 0

  for (const p of parts) {
    if (!p) continue
    if (used + p.length > charCap && blocks.length > 0) break
    blocks.push(p)
    used += p.length
  }

  // Dedupe slices by file+start, then add under the remaining budget.
  const seen = new Set<string>()
  for (const s of slices) {
    const k = `${s.file}:${s.startLine}`
    if (seen.has(k)) continue
    seen.add(k)
    const block = sliceBlock(s)
    if (used + block.length > charCap && blocks.length > 0) break
    blocks.push(block)
    if (!files.includes(s.file)) files.push(s.file)
    used += block.length
  }

  if (blocks.length === 0) return null
  const text = blocks.join("\n\n")
  const contextHash = createHash("sha256").update(text).digest("hex").slice(0, 24)
  return {
    text,
    files,
    tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
    contextHash,
  }
}

function pathNodeSlices(
  projectPath: string,
  nodes: EvidencePathNode[] | undefined,
): Slice[] {
  if (!Array.isArray(nodes)) return []
  const slices: Slice[] = []
  for (const n of nodes) {
    if (!n.file || typeof n.line !== "number") continue
    const all = readAllLines(projectPath, n.file)
    if (all) slices.push(windowSlice(n.file, all, n.line))
  }
  return slices
}

/** Build a bundle for a finding cluster. */
export function buildClusterContextBundle(
  projectPath: string,
  cluster: Cluster,
  tokenCap: number,
  report?: Record<string, unknown>,
): ScanContextBundle | null {
  const rep = cluster.representative
  const all = readAllLines(projectPath, rep.file)

  // Containing function/class block (richer than a fixed window).
  let blockS: Slice | null = null
  if (all) {
    const block = findContainingBlock(all, rep.line)
    if (block) blockS = blockSlice(rep.file, all, block)
  }

  const header =
    `FINDING CLUSTER: rule=${rep.rule_id} severity=${cluster.maxSeverity} ` +
    `sink=${cluster.sinkKind} file=${rep.file}:${rep.line}` +
    (blockS?.label ? ` in ${blockS.label}` : "")

  const slices: Slice[] = []
  if (blockS) slices.push(blockS)
  // Always include the focused window (carries redaction guarantees and
  // any nearby secret-redaction placeholders the tests assert on).
  if (all) slices.push(windowSlice(rep.file, all, rep.line))
  slices.push(...pathNodeSlices(projectPath, rep.evidence_path))

  const parts: Array<string | null> = [
    header,
    renderPath(rep.evidence_path),
    renderGuards(blockS),
    renderRelatedContext(report, rep.file),
  ]
  return assemble(parts, slices, tokenCap)
}

/** Build a bundle for a risky surface (gap audit). */
export function buildSurfaceContextBundle(
  projectPath: string,
  surface: RiskSurface,
  tokenCap: number,
  report?: Record<string, unknown>,
): ScanContextBundle | null {
  const all = readAllLines(projectPath, surface.file)
  if (!all) return null

  let blockS: Slice | null = null
  const block = findContainingBlock(all, surface.line)
  if (block) blockS = blockSlice(surface.file, all, block)

  const header =
    `RISK SURFACE: kind=${surface.kind} label=${redactSecrets(surface.label)} ` +
    `file=${surface.file}:${surface.line}` +
    (blockS?.label ? ` in ${blockS.label}` : "")

  const slices: Slice[] = []
  if (blockS) slices.push(blockS)
  slices.push(windowSlice(surface.file, all, surface.line))

  const parts: Array<string | null> = [
    header,
    renderGuards(blockS),
    renderRelatedContext(report, surface.file),
  ]
  return assemble(parts, slices, tokenCap)
}
