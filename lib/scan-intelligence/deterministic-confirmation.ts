/**
 * Deterministic confirmation of LLM gap-audit candidates.
 *
 * This is the gate that enforces the core product rule: an LLM candidate
 * can NEVER become a finding on the LLM's say-so. It only becomes a
 * `gap_audit_confirmed` finding when deterministic checks prove it:
 *
 *   - the file exists inside the repo (path traversal rejected),
 *   - the cited line/snippet exists,
 *   - a source-shaped pattern exists,
 *   - a sink-shaped pattern exists,
 *   - no guard/sanitizer obviously neutralises it,
 *   - it is not a duplicate of an existing finding.
 *
 * Anything that doesn't pass stays as metadata (needs_rule_support /
 * needs_human_review) — never a confirmed finding.
 *
 * No LLM, no network. Pure file + pattern checks, reusing the same
 * source/sink vocabulary the deterministic scanner uses.
 */
import fs from "node:fs"
import path from "node:path"
import { findContainingBlock } from "./code-structure"
import {
  GUARD_PATTERNS,
  SINK_PATTERNS,
  SOURCE_PATTERNS,
  anyMatch,
  matchingLines,
} from "./patterns"
import type {
  ConfirmationResult,
  EvidencePathNode,
  GapAuditCandidate,
  ScanFinding,
} from "./types"

function isUnsafeRelPath(rel: string): boolean {
  if (!rel) return true
  if (path.isAbsolute(rel)) return true
  const parts = rel.split(/[\\/]/)
  if (parts.includes("..")) return true
  return false
}

function safeResolve(projectPath: string, rel: string): string | null {
  if (isUnsafeRelPath(rel)) return null
  const abs = path.resolve(projectPath, rel)
  const root = path.resolve(projectPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

/**
 * Is there a deterministic source→sink *path* (graph evidence) from an
 * existing finding that corroborates this candidate? We treat an existing
 * finding's `evidence_path` as graph truth: if any node lands in the
 * candidate's file within `[blockStart, blockEnd]`, the scanner's own IR
 * already proved a flow through that region.
 */
function evidencePathCorroborates(
  existingFindings: ScanFinding[],
  file: string,
  blockStart: number,
  blockEnd: number,
): boolean {
  for (const f of existingFindings) {
    const nodes: EvidencePathNode[] | undefined = f.evidence_path
    if (!Array.isArray(nodes)) continue
    for (const n of nodes) {
      if (n.file !== file || typeof n.line !== "number") continue
      if (n.line >= blockStart && n.line <= blockEnd) return true
    }
  }
  return false
}

export interface ConfirmArgs {
  candidate: GapAuditCandidate
  projectPath: string
  existingFindings: ScanFinding[]
  /** +/- lines around the cited line to inspect for source/sink/guard. */
  window?: number
}

export function confirmCandidate(args: ConfirmArgs): ConfirmationResult {
  const { candidate, projectPath } = args
  const window = args.window ?? 25

  // 1. Path traversal / file existence.
  const abs = safeResolve(projectPath, candidate.file)
  if (!abs) {
    return { status: "rejected_no_path", reason: "path traversal or unsafe path rejected" }
  }
  let lines: string[]
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) {
      return { status: "rejected_no_path", reason: "candidate file is not a file" }
    }
    lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/)
  } catch {
    return { status: "rejected_no_path", reason: "candidate file does not exist in repo" }
  }

  // 2. Cited line exists.
  if (!Number.isFinite(candidate.line) || candidate.line < 1 || candidate.line > lines.length) {
    return { status: "needs_human_review", reason: "cited line is out of range" }
  }

  // 3. Duplicate of an existing finding? (same file + nearby line)
  const dup = args.existingFindings.some(
    (f) => f.file === candidate.file && Math.abs(f.line - candidate.line) <= 3,
  )
  if (dup) {
    return { status: "needs_rule_support", reason: "duplicate of an existing finding" }
  }

  // 4. Inspect the window around the cited line for source/sink/guard.
  //    (Nearby-regex presence check — the deterministic floor.)
  const start = Math.max(0, candidate.line - 1 - window)
  const end = Math.min(lines.length, candidate.line + window)
  const region = lines.slice(start, end).join("\n")

  const hasSink = anyMatch(SINK_PATTERNS, region)
  if (!hasSink) {
    return { status: "rejected_no_sink", reason: "no dangerous sink pattern near cited line" }
  }
  const hasSource = anyMatch(SOURCE_PATTERNS, region)
  if (!hasSource) {
    // A sink with no discernible source is plausible but unproven — keep
    // as a metadata candidate, never a confirmed finding.
    return {
      status: "needs_rule_support",
      reason: "sink present but no source pattern proven near cited line",
    }
  }
  const hasGuard = anyMatch(GUARD_PATTERNS, region)
  if (hasGuard) {
    return {
      status: "rejected_guard_present",
      reason: "a guard/sanitizer is present on the path",
    }
  }

  // 5. Upgrade the proof when stronger evidence is available. The
  //    candidate already cleared the nearby-regex floor; now try to
  //    explain *how* it was confirmed (best evidence first):
  //
  //      a. graph / evidence-path corroboration from a scanner finding,
  //      b. intra-function ordered flow (source line <= sink line inside
  //         the containing function/class),
  //      c. nearby-regex fallback (original behaviour).
  const block = findContainingBlock(lines, candidate.line)

  if (block) {
    // Guards anywhere inside the containing function neutralise the flow,
    // even if they sit outside the +/- window.
    const blockLines = lines.slice(block.startLine - 1, block.endLine)
    if (anyMatch(GUARD_PATTERNS, blockLines.join("\n"))) {
      return {
        status: "rejected_guard_present",
        reason: `guard/sanitizer present in ${block.kind} ${block.name}`,
      }
    }

    if (
      evidencePathCorroborates(
        args.existingFindings,
        candidate.file,
        block.startLine,
        block.endLine,
      )
    ) {
      return {
        status: "confirmed",
        reason: `confirmed via scanner evidence-path through ${block.kind} ${block.name}`,
      }
    }

    const sources = matchingLines(SOURCE_PATTERNS, blockLines, block.startLine)
    const sinks = matchingLines(SINK_PATTERNS, blockLines, block.startLine)
    const flow = sources.some((s) => sinks.some((k) => s.line <= k.line))
    if (flow) {
      return {
        status: "confirmed",
        reason: `confirmed via intra-function source->sink flow in ${block.kind} ${block.name}`,
      }
    }
  }

  // 5c. Proven by nearby regex: source + sink in window, no guard.
  return { status: "confirmed", reason: "source and sink proven near cited line, no guard" }
}
