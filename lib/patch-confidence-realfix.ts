/**
 * Patch-confidence extension: real-fix detection on the TypeScript side.
 *
 * Mirrors `scanner/.../remediation/validators.py::is_real_fix` so the UI
 * and the Python scanner agree on what counts as a "real fix" vs a
 * "suggestion". This is the gate the patch route uses to ensure a
 * TODO/comment/whitespace/no-op diff can NEVER be applied as a fix.
 *
 * Input here is a unified diff string (what the pipeline already
 * produces for display), so we operate on `+`/`-` hunk lines. The
 * AST-equivalence check from the Python side can't run in TS without a
 * parser, so we conservatively treat whitespace-normalized-equal added/
 * removed content as inert, which catches the common reformat case.
 *
 * The original `scorePatch` / `ValidationSignals` in
 * `lib/patch-confidence.ts` is preserved; this file is meant to be
 * MERGED into it (or imported alongside). The apply path imports
 * `isRealFixDiff`.
 */

const COMMENT_PREFIXES = ["#", "//", "/*", "*", "*/"]
const TODO_RX = /^[#/*\s]*(TODO|FIXME|XXX|HACK|NOTE|REVIEW)\b/i
const EDGE_MARKER_RX = /(edge[-_ ]?agent|edgeagent)/i
const DOCSTRING_DELIMS = ['"""', "'''"]

export type RealFixReason =
  | "ok"
  | "no-net-change"
  | "whitespace-only"
  | "todo-or-comment-only"
  | "docstring-only"
  | "edge-marker-only"

export interface RealFixResult {
  isRealFix: boolean
  reason: RealFixReason
}

function isInertLine(line: string): boolean {
  const s = line.trim()
  if (!s) return true
  if (COMMENT_PREFIXES.some((p) => s.startsWith(p))) return true
  if (TODO_RX.test(s)) return true
  if (DOCSTRING_DELIMS.includes(s)) return true
  if (s.startsWith("#") && EDGE_MARKER_RX.test(s)) return true
  return false
}

function stripWs(t: string): string {
  return t.replace(/\s+/g, "")
}

/**
 * Decide whether a unified diff represents a real fix. `file` is used
 * only to skip the diff header lines for that path.
 */
export function isRealFixDiff(unifiedDiff: string, _file: string): RealFixResult {
  const lines = unifiedDiff.split("\n")
  const added: string[] = []
  const removed: string[] = []
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@")) continue
    if (l.startsWith("+")) added.push(l.slice(1))
    else if (l.startsWith("-")) removed.push(l.slice(1))
  }

  if (added.length === 0 && removed.length === 0) {
    return { isRealFix: false, reason: "no-net-change" }
  }

  const addedSubstantive = added.filter((l) => !isInertLine(l))
  const removedSubstantive = removed.filter((l) => !isInertLine(l))

  if (addedSubstantive.length === 0 && removedSubstantive.length === 0) {
    const all = [...added, ...removed]
    if (all.length > 0 && all.every((l) => EDGE_MARKER_RX.test(l))) {
      return { isRealFix: false, reason: "edge-marker-only" }
    }
    if (all.length > 0 && all.every((l) => DOCSTRING_DELIMS.some((d) => l.trim().startsWith(d)))) {
      return { isRealFix: false, reason: "docstring-only" }
    }
    return { isRealFix: false, reason: "todo-or-comment-only" }
  }

  // Whitespace-only: substantive content identical after ws-normalization.
  if (
    stripWs(addedSubstantive.join("")) === stripWs(removedSubstantive.join("")) &&
    addedSubstantive.length > 0
  ) {
    return { isRealFix: false, reason: "whitespace-only" }
  }

  return { isRealFix: true, reason: "ok" }
}

/**
 * Guard-added heuristic (TS mirror of validators.guard_added). Supports
 * the patch-confidence badge "guard added". Returns true if the diff's
 * added lines contain a token known to neutralize the rule.
 */
const RULE_GUARD_TOKENS: Record<string, string[]> = {
  "cypher-injection-from-llm-or-user": ["$", "parameters=", "params=", "session.run("],
  "config-controlled-file-read": [".resolve()", "is_relative_to", "realpath", "allowlist"],
  "default-db-credentials": ["os.environ", "os.getenv", "getenv(", "process.env"],
  "env-proxy-mutation": ["allowlist", "validate", "assert "],
  "llm-codegen-to-exec": ["RestrictedPython", "asteval", "ast.parse", "allowlist"],
  "prompt-injection-placeholder": ["escape", "sanitize", "quote", "allowlist"],
  "user-input-dangerous-code": ["shlex.quote", "parameterized", "bindparam", "sanitize"],
  "auth-checks": ["require_auth", "get_current_user", "authorize", "permission"],
  "human-approval": ["confirm_before_execute", "requires_approval", "approval_required"],
  secrets: ["os.environ", "os.getenv", "process.env"],
  "dependency-risks": ["==", "~="],
}

export function guardAddedInDiff(unifiedDiff: string, ruleId: string): boolean {
  const tokens = RULE_GUARD_TOKENS[ruleId]
  if (!tokens) return false
  const added = unifiedDiff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n")
    .toLowerCase()
  return tokens.some((t) => added.includes(t.toLowerCase()))
}
