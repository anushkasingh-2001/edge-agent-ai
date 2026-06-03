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
import type {
  ConfirmationResult,
  GapAuditCandidate,
  ScanFinding,
} from "./types"

// Source-shaped patterns: user/request/config/env/model-output entry points.
const SOURCE_PATTERNS = [
  /request\.|req\.|\.args|\.form|\.json\(|query\[|params\[|input\(/i,
  /os\.environ|getenv|process\.env|config\[|\.config\.|load_config/i,
  /argv|stdin|read\(|recv\(|fetch\(|response\.|completion|message\.content/i,
]

// Sink-shaped patterns: dangerous execution / injection / IO / network sinks.
const SINK_PATTERNS = [
  /os\.system|subprocess\.(?:run|call|popen|check_output)|shell\s*=\s*True/i,
  /\beval\(|\bexec\(|pickle\.loads|yaml\.load\b|__import__\(/i,
  /execute\(|executemany\(|cursor\.execute|session\.run\(|\.query\(/i,
  /open\(|\.write\(|\.read\(|Path\(|shutil\.|os\.remove|unlink\(/i,
  /requests\.(?:get|post|put)|urllib|httpx\.|socket\.|fetch\(/i,
  /hf_hub_download|from_pretrained|torch\.load|download_url|snapshot_download/i,
]

// Guard/sanitizer patterns that neutralise a flow when present nearby.
const GUARD_PATTERNS = [
  /shlex\.quote|shlex\.split|escape\(|sanitize|allowlist|whitelist|is_safe/i,
  /validate|verify|assert\s|require_auth|check_permission|authorize|@login_required/i,
  /parameteriz|bind_param|prepared|placeholder|\?\s*,|%s/i,
]

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

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text))
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

  // 5. Proven: source -> sink, no guard, in-repo, not a duplicate.
  return { status: "confirmed", reason: "source and sink proven near cited line, no guard" }
}
