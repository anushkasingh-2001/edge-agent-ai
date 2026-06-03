/**
 * Build a small, redacted, size-capped context bundle for one cluster or
 * surface. This is the ONLY code that reads source for the LLM, and it
 * is deliberately conservative:
 *
 *   - Never sends the whole repo, node_modules, .git, .env files, or
 *     huge generated files.
 *   - Reads only a line window around the finding (+/- 20 lines) plus
 *     the evidence-path nodes' own windows.
 *   - Redacts secrets via the canonical `redactSecrets` before any text
 *     enters the bundle.
 *   - Caps total size to the mode's token budget (chars/4 heuristic).
 *   - Rejects path traversal — files must resolve inside the project.
 *
 * Returns `null` when nothing safe could be read.
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { redactSecrets } from "../server-finding-explanations"
import type { Cluster, EvidencePathNode, RiskSurface } from "./types"

const WINDOW = 20 // lines before/after the focus line
const CHARS_PER_TOKEN = 4
const MAX_FILE_BYTES = 512 * 1024 // skip huge/generated files
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

function readWindow(
  projectPath: string,
  rel: string,
  focusLine: number,
): Slice | null {
  const abs = safeResolve(projectPath, rel)
  if (!abs) return null
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    const all = fs.readFileSync(abs, "utf-8").split(/\r?\n/)
    const focus = Number.isFinite(focusLine) && focusLine > 0 ? focusLine : 1
    const start = Math.max(1, focus - WINDOW)
    const end = Math.min(all.length, focus + WINDOW)
    const lines = all.slice(start - 1, end).map((l) => redactSecrets(l))
    return { file: rel, startLine: start, lines }
  } catch {
    return null
  }
}

function renderSlices(slices: Slice[], tokenCap: number): ScanContextBundle | null {
  if (slices.length === 0) return null
  const charCap = Math.max(1, tokenCap) * CHARS_PER_TOKEN
  const blocks: string[] = []
  const files: string[] = []
  let used = 0
  for (const s of slices) {
    const header = `--- ${s.file}:${s.startLine} ---`
    const body = s.lines
      .map((l, idx) => `${s.startLine + idx} | ${l}`)
      .join("\n")
    const block = `${header}\n${body}`
    if (used + block.length > charCap && blocks.length > 0) break
    blocks.push(block)
    if (!files.includes(s.file)) files.push(s.file)
    used += block.length
  }
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
    const slice = readWindow(projectPath, n.file, n.line)
    if (slice) slices.push(slice)
  }
  return slices
}

/** Build a bundle for a finding cluster. */
export function buildClusterContextBundle(
  projectPath: string,
  cluster: Cluster,
  tokenCap: number,
): ScanContextBundle | null {
  const rep = cluster.representative
  const slices: Slice[] = []
  const primary = readWindow(projectPath, rep.file, rep.line)
  if (primary) slices.push(primary)
  // Source -> sink path windows (guards/sanitizers live here too).
  slices.push(...pathNodeSlices(projectPath, rep.evidence_path))
  // Dedupe identical slices by file+start.
  const seen = new Set<string>()
  const deduped = slices.filter((s) => {
    const k = `${s.file}:${s.startLine}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return renderSlices(deduped, tokenCap)
}

/** Build a bundle for a risky surface (gap audit). */
export function buildSurfaceContextBundle(
  projectPath: string,
  surface: RiskSurface,
  tokenCap: number,
): ScanContextBundle | null {
  const slice = readWindow(projectPath, surface.file, surface.line)
  if (!slice) return null
  return renderSlices([slice], tokenCap)
}
