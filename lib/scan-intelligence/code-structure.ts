/**
 * Best-effort extraction of the function/class block that contains a
 * given line. Used to give the LLM the *containing function body* (not
 * just a fixed line window) and to scope deterministic intra-function
 * flow confirmation.
 *
 * Two heuristics, tried in order:
 *   - Python-style: nearest preceding `def`/`class NAME:` line; the block
 *     extends while indentation stays deeper than the signature.
 *   - Brace-style (JS/TS/Go/Java/C-like): nearest preceding signature
 *     (`function NAME`, `class NAME`, `const NAME = (...) =>`, or
 *     `NAME(...) {`); the block ends at the matching closing brace.
 *
 * Returns null when no containing block can be found. Always bounded so a
 * pathological file can't blow up the bundle.
 */
const MAX_BLOCK_LINES = 160

export interface CodeBlock {
  name: string
  kind: "function" | "class" | "method" | "block"
  /** 1-based inclusive line range. */
  startLine: number
  endLine: number
  signature: string
}

const PY_SIG = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/
const BRACE_SIG =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(function)\s+([A-Za-z_$][\w$]*)|(class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/

function leadingWs(s: string): number {
  const m = s.match(/^(\s*)/)
  return m ? m[1].replace(/\t/g, "    ").length : 0
}

function pythonBlock(lines: string[], idx: number): CodeBlock | null {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(PY_SIG)
    if (!m) continue
    const sigIndent = m[1].replace(/\t/g, "    ").length
    // The focus line must actually be inside (deeper than) this block.
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === "") continue
      if (leadingWs(line) <= sigIndent) {
        end = j
        break
      }
    }
    // idx must be within [i, end).
    if (idx < i || idx >= end) {
      // The nearest def is a sibling, not an ancestor — keep scanning up.
      continue
    }
    const endLine = Math.min(end, i + MAX_BLOCK_LINES)
    return {
      name: m[3],
      kind: m[2] === "class" ? "class" : "function",
      startLine: i + 1,
      endLine,
      signature: lines[i].trim(),
    }
  }
  return null
}

function braceBlock(lines: string[], idx: number): CodeBlock | null {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(BRACE_SIG)
    if (!m) continue
    const name = m[2] || m[4] || m[5] || m[6] || "anonymous"
    const kind: CodeBlock["kind"] = m[3] ? "class" : m[6] ? "method" : "function"
    // Find the opening brace at/after the signature line.
    let depth = 0
    let started = false
    let endLine = lines.length
    for (let j = i; j < lines.length && j < i + MAX_BLOCK_LINES; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++
          started = true
        } else if (ch === "}") {
          depth--
          if (started && depth === 0) {
            endLine = j + 1
            break
          }
        }
      }
      if (started && depth === 0) break
    }
    if (!started) continue
    if (idx < i || idx >= endLine) continue
    return { name, kind, startLine: i + 1, endLine, signature: lines[i].trim() }
  }
  return null
}

/** Find the function/class block containing `focusLine` (1-based). */
export function findContainingBlock(
  lines: string[],
  focusLine: number,
): CodeBlock | null {
  if (lines.length === 0) return null
  const idx = Math.max(0, Math.min(lines.length - 1, focusLine - 1))
  // Prefer the language that yields the tightest enclosing block.
  const py = pythonBlock(lines, idx)
  const brace = braceBlock(lines, idx)
  if (py && brace) {
    // Smaller span === tighter (more relevant) enclosing block.
    return py.endLine - py.startLine <= brace.endLine - brace.startLine ? py : brace
  }
  return py ?? brace
}
