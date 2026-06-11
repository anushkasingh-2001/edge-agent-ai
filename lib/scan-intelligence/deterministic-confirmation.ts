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
import { findContainingBlock, type CodeBlock } from "./code-structure"
import {
  AUTH_GUARD_PATTERNS,
  AUTH_MUTATION_PATTERNS,
  COMMAND_SINK_PATTERNS,
  GUARD_PATTERNS,
  PARAM_GUARD_PATTERNS,
  PROMPT_SINK_PATTERNS,
  PROMPT_TEXT_PATTERNS,
  SINK_PATTERNS,
  SOURCE_PATTERNS,
  SQL_EXEC_PATTERNS,
  SUPPLY_DOWNLOAD_PATTERNS,
  SUPPLY_RISKY_PATTERNS,
  anyMatch,
  looksLikeBuiltQuery,
  matchingLines,
} from "./patterns"
import type {
  ConfirmationResult,
  EvidencePathNode,
  GapAuditCandidate,
  ScanFinding,
} from "./types"

/** Rule families that get a targeted deterministic confirmation path. */
type ConfirmFamily =
  | "command_injection"
  | "sql_injection"
  | "prompt_injection"
  | "auth"
  | "vague_prompt"
  | "supply_chain"
  | "generic"

/** Map a candidate's rule_family/sink_kind to a confirmation family. */
export function confirmationFamily(c: GapAuditCandidate): ConfirmFamily {
  const t = `${c.rule_family} ${c.sink_kind} ${c.source_kind}`.toLowerCase()
  // Command/exec FIRST. `\bexec\b` deliberately does NOT match "execute"
  // (no word boundary inside the word), so "cursor.execute" stays out of
  // this branch while "execute command" / os.system / subprocess route here.
  if (/command|os\.system|subprocess|\bshell\b|\bexec\b|\beval\b|dangerous[-_ ]?code/.test(t))
    return "command_injection"
  // SQL/Cypher requires a REAL database signal — never bare "execute". A
  // genuine query candidate carries sql/cypher/db/query/cursor/session.run/
  // .query or an `execute(` call (with the paren, i.e. an execution site).
  if (/\bsql\b|cypher|\bdb\b|database|\bquery\b|\bcursor\b|session\.run|\.query|execute\s*\(/.test(t))
    return "sql_injection"
  if (/prompt[-_ ]?inject/.test(t)) return "prompt_injection"
  if (/vague|prompt[-_ ]?contract|underspecified/.test(t)) return "vague_prompt"
  if (/auth|approval|permission|access[-_ ]?control/.test(t)) return "auth"
  if (/dependency|supply|model[-_ ]?download|deserial|pickle/.test(t)) return "supply_chain"
  return "generic"
}

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

  // 4. Build the inspection scope: a +/- window AND the containing block.
  //    Family-specific confirmation prefers the block (same function) when
  //    available; otherwise it uses the nearby window.
  const start = Math.max(0, candidate.line - 1 - window)
  const end = Math.min(lines.length, candidate.line + window)
  const region = lines.slice(start, end).join("\n")
  const block = findContainingBlock(lines, candidate.line)
  const blockLines = block ? lines.slice(block.startLine - 1, block.endLine) : []
  const blockText = block ? blockLines.join("\n") : ""
  const scope = block ? blockText : region

  const ctx: FamilyCtx = {
    candidate,
    existingFindings: args.existingFindings,
    file: candidate.file,
    region,
    lines,
    block,
    blockLines,
    blockText,
    scope,
  }

  // 5. Rule-family-specific confirmation. Each family proves its OWN shape;
  //    if proof is incomplete it returns needs_rule_support / human_review
  //    (never `confirmed`). Unknown families fall back to generic
  //    source->sink confirmation (the original behaviour).
  switch (confirmationFamily(candidate)) {
    case "command_injection":
      return confirmCommandInjection(ctx)
    case "sql_injection":
      return confirmSqlInjection(ctx)
    case "prompt_injection":
      return confirmPromptInjection(ctx)
    case "auth":
      return confirmAuth(ctx)
    case "vague_prompt":
      return confirmVaguePrompt(ctx)
    case "supply_chain":
      return confirmSupplyChain(ctx)
    default:
      return confirmGeneric(ctx)
  }
}

// ---------------------------------------------------------------------------
// Family-specific confirmation. All operate on the prepared FamilyCtx; none
// call an LLM or touch the network.
// ---------------------------------------------------------------------------

interface FamilyCtx {
  candidate: GapAuditCandidate
  existingFindings: ScanFinding[]
  file: string
  region: string
  lines: string[]
  block: CodeBlock | null
  blockLines: string[]
  blockText: string
  /** block body when available, else the nearby window. */
  scope: string
}

const REJECT_NO_SINK = (what: string): ConfirmationResult => ({
  status: "rejected_no_sink",
  reason: `no ${what} near cited line`,
})
const GUARD_PRESENT = (what: string): ConfirmationResult => ({
  status: "rejected_guard_present",
  reason: what,
})
const NEEDS_RULE = (reason: string): ConfirmationResult => ({
  status: "needs_rule_support",
  reason,
})

/** Command injection: untrusted source -> command sink in the same
 *  function/block (or via evidence path), with no guard/allowlist. */
function confirmCommandInjection(ctx: FamilyCtx): ConfirmationResult {
  const { scope, block, blockLines, candidate, existingFindings } = ctx
  if (!anyMatch(COMMAND_SINK_PATTERNS, scope)) return REJECT_NO_SINK("command/exec sink")
  if (anyMatch(GUARD_PATTERNS, scope)) {
    return GUARD_PRESENT("a guard/allowlist/validation is present on the command path")
  }
  if (!anyMatch(SOURCE_PATTERNS, scope)) {
    return NEEDS_RULE("command sink present but no untrusted source proven")
  }
  if (block) {
    if (
      evidencePathCorroborates(existingFindings, candidate.file, block.startLine, block.endLine)
    ) {
      return { status: "confirmed", reason: `confirmed command injection via scanner evidence-path in ${block.kind} ${block.name}` }
    }
    const sources = matchingLines(SOURCE_PATTERNS, blockLines, block.startLine)
    const sinks = matchingLines(COMMAND_SINK_PATTERNS, blockLines, block.startLine)
    const flow = sources.some((s) => sinks.some((k) => s.line <= k.line))
    if (flow) {
      return { status: "confirmed", reason: `confirmed command injection: source->command sink in ${block.kind} ${block.name}` }
    }
    return NEEDS_RULE("source and command sink in function but no ordered flow proven")
  }
  // No block boundary — fall back to nearby-window co-occurrence.
  return { status: "confirmed", reason: "confirmed command injection: source and command sink near cited line, no guard" }
}

/** SQL/Cypher injection: query CONSTRUCTION from an untrusted source that is
 *  then EXECUTED, with no parameterization/binding. */
function confirmSqlInjection(ctx: FamilyCtx): ConfirmationResult {
  const { scope } = ctx
  if (!anyMatch(SQL_EXEC_PATTERNS, scope)) return REJECT_NO_SINK("query execution sink")
  if (anyMatch(PARAM_GUARD_PATTERNS, scope)) {
    return GUARD_PRESENT("query is parameterized / uses bound placeholders")
  }
  if (!looksLikeBuiltQuery(scope)) {
    return NEEDS_RULE("query executed but no interpolated query construction proven")
  }
  if (!anyMatch(SOURCE_PATTERNS, scope)) {
    return NEEDS_RULE("interpolated query but no untrusted source proven")
  }
  return { status: "confirmed", reason: "confirmed SQL/Cypher injection: untrusted input built into an executed query, no parameterization" }
}

/** Prompt injection: untrusted content reaching an instruction-bearing
 *  prompt or tool argument, with no delimiting/quoting/policy guard. */
function confirmPromptInjection(ctx: FamilyCtx): ConfirmationResult {
  const { scope } = ctx
  if (!anyMatch(PROMPT_SINK_PATTERNS, scope)) return REJECT_NO_SINK("instruction-bearing prompt sink")
  if (!anyMatch(SOURCE_PATTERNS, scope)) {
    return NEEDS_RULE("prompt sink present but no untrusted source proven")
  }
  if (anyMatch(GUARD_PATTERNS, scope)) {
    return GUARD_PRESENT("a delimiting/sanitizing guard is present on the prompt path")
  }
  return { status: "confirmed", reason: "confirmed prompt injection: untrusted content reaches an instruction-bearing prompt, no delimiting" }
}

/** Auth: a mutating/sensitive route or tool with NO auth/authorization
 *  guard on its path. Uses the nearby WINDOW (not just the function body) so
 *  decorators such as `@login_required` that sit above the `def` are seen. */
function confirmAuth(ctx: FamilyCtx): ConfirmationResult {
  const text = `${ctx.region}\n${ctx.blockText}`
  if (!anyMatch(AUTH_MUTATION_PATTERNS, text)) {
    return NEEDS_RULE("no mutating/sensitive route or tool proven near cited line")
  }
  if (anyMatch(AUTH_GUARD_PATTERNS, text)) {
    return GUARD_PRESENT("an authentication/authorization guard is present")
  }
  return { status: "confirmed", reason: "confirmed auth gap: mutating/sensitive surface with no auth guard" }
}

/** Vague prompt: a real prompt must be extracted AND the candidate must cite
 *  deterministic missing-contract evidence. */
function confirmVaguePrompt(ctx: FamilyCtx): ConfirmationResult {
  const { scope, candidate } = ctx
  if (!anyMatch(PROMPT_TEXT_PATTERNS, scope)) {
    return NEEDS_RULE("no prompt text extracted near cited line")
  }
  const ev = `${candidate.evidence} ${candidate.why_missed}`.toLowerCase()
  const hasMissingContract =
    /missing|underspecified|vague|no\s+(role|task|output|tool|approval|fallback|constraint|persona)/.test(
      ev,
    )
  if (!hasMissingContract) {
    return { status: "needs_human_review", reason: "prompt found but missing-contract evidence not deterministic" }
  }
  return { status: "confirmed", reason: "confirmed vague prompt: prompt extracted with deterministic missing-contract evidence" }
}

/** Dependency / model supply-chain: manifest/model-download evidence PLUS a
 *  known-risky pattern or unsafe source. */
function confirmSupplyChain(ctx: FamilyCtx): ConfirmationResult {
  const { scope } = ctx
  if (!anyMatch(SUPPLY_DOWNLOAD_PATTERNS, scope)) {
    return NEEDS_RULE("no manifest/model-download evidence near cited line")
  }
  if (!anyMatch(SUPPLY_RISKY_PATTERNS, scope)) {
    return NEEDS_RULE("download present but no risky/unsafe source pattern proven")
  }
  return { status: "confirmed", reason: "confirmed supply-chain risk: model/dependency download from an unsafe/risky source" }
}

/** Generic fallback (original behaviour): any source -> any dangerous sink,
 *  no guard, upgraded by evidence-path / intra-function flow when possible. */
function confirmGeneric(ctx: FamilyCtx): ConfirmationResult {
  const { region, block, blockLines, candidate, existingFindings } = ctx

  if (!anyMatch(SINK_PATTERNS, region)) {
    return { status: "rejected_no_sink", reason: "no dangerous sink pattern near cited line" }
  }
  if (!anyMatch(SOURCE_PATTERNS, region)) {
    return {
      status: "needs_rule_support",
      reason: "sink present but no source pattern proven near cited line",
    }
  }
  if (anyMatch(GUARD_PATTERNS, region)) {
    return { status: "rejected_guard_present", reason: "a guard/sanitizer is present on the path" }
  }

  if (block) {
    if (anyMatch(GUARD_PATTERNS, ctx.blockText)) {
      return {
        status: "rejected_guard_present",
        reason: `guard/sanitizer present in ${block.kind} ${block.name}`,
      }
    }
    if (
      evidencePathCorroborates(existingFindings, candidate.file, block.startLine, block.endLine)
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

  return { status: "confirmed", reason: "source and sink proven near cited line, no guard" }
}
