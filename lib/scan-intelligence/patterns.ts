/**
 * Shared deterministic source / sink / guard pattern vocabulary.
 *
 * Used by BOTH the context-bundle builder (to render a structured
 * source->sink + guards section for the LLM) and the deterministic
 * confirmation gate (to prove a candidate). Keeping one copy means the
 * "what the LLM saw" and "what we confirm against" stay in lockstep.
 *
 * These mirror the dangerous-sink / taint vocabulary the Python scanner
 * already uses; they REINFORCE the deterministic rules, never replace
 * them.
 */

/** Source-shaped patterns: user/request/config/env/model-output entry. */
export const SOURCE_PATTERNS: ReadonlyArray<RegExp> = [
  /request\.|req\.|\.args|\.form\b|\.json\(|query\[|params\[|\binput\(/i,
  /os\.environ|getenv|process\.env|config\[|\.config\.|load_config/i,
  /argv|stdin|\.read\(|recv\(|\bfetch\(|response\.|completion|message\.content/i,
]

/** Sink-shaped patterns: dangerous execution / injection / IO / network. */
export const SINK_PATTERNS: ReadonlyArray<RegExp> = [
  /os\.system|subprocess\.(?:run|call|popen|check_output)|shell\s*=\s*True/i,
  /\beval\(|\bexec\(|pickle\.loads|yaml\.load\b|__import__\(/i,
  /execute\(|executemany\(|cursor\.execute|session\.run\(|\.query\(/i,
  /\bopen\(|\.write\(|Path\(|shutil\.|os\.remove|unlink\(/i,
  /requests\.(?:get|post|put)|urllib|httpx\.|socket\.|fetch\(/i,
  /hf_hub_download|from_pretrained|torch\.load|download_url|snapshot_download/i,
]

/** Guard/sanitizer patterns that neutralise a flow when present. */
export const GUARD_PATTERNS: ReadonlyArray<RegExp> = [
  /shlex\.quote|shlex\.split|escape\(|sanitize|allowlist|whitelist|is_safe/i,
  /\bvalidate|\bverify|\bassert\b|require_auth|check_permission|authorize|@login_required/i,
  /parameteriz|bind_param|prepared|placeholder|\?\s*,|%s/i,
]

// ---------------------------------------------------------------------------
// Rule-family-specific vocabulary (used by deterministic-confirmation.ts to
// prove a gap-audit candidate for ITS family, not just any source->sink).
// ---------------------------------------------------------------------------

/** Command/exec sinks only (subset of SINK_PATTERNS). */
export const COMMAND_SINK_PATTERNS: ReadonlyArray<RegExp> = [
  /os\.system|os\.popen|subprocess\.(?:run|call|popen|check_output|check_call)|shell\s*=\s*True/i,
  /\beval\(|\bexec\(|pickle\.loads|__import__\(|commands\.getoutput/i,
]

/** Query EXECUTION sinks. */
export const SQL_EXEC_PATTERNS: ReadonlyArray<RegExp> = [
  /execute\(|executemany\(|cursor\.execute|session\.run\(|\.query\(|\.raw\(|text\(/i,
]

/** SQL/Cypher keyword presence (query CONSTRUCTION signal). */
export const SQL_KEYWORD_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:select|insert\s+into|update\s+\w+\s+set|delete\s+from|merge|drop\s+table)\b/i,
  /\bmatch\s*\(|\bcreate\s*\(|\bdetach\s+delete\b/i, // Cypher
]

/** String interpolation markers that turn a query into an injection risk. */
export const INTERPOLATION_PATTERNS: ReadonlyArray<RegExp> = [
  /f["'`]/i, // f-strings
  /\.format\(/i,
  /%\s*[(\w]/, // %-formatting
  /\+\s*\w/, // concatenation with a variable
  /\$\{/, // template literal
]

/** Parameterization / binding guards that neutralise SQL injection. */
export const PARAM_GUARD_PATTERNS: ReadonlyArray<RegExp> = [
  /%s|\?\s*[,)]|:\w+\b|bind_param|bindparam|prepared|placeholder|parameteriz/i,
]

/** Instruction-bearing prompt sinks. */
export const PROMPT_SINK_PATTERNS: ReadonlyArray<RegExp> = [
  /prompt|system_message|developer_message|instruction|messages\s*[=.]|PromptTemplate|ChatPromptTemplate/i,
]

/** Mutating / sensitive route or tool declarations. */
export const AUTH_MUTATION_PATTERNS: ReadonlyArray<RegExp> = [
  /@(?:app|router|api|bp|blueprint)\.(?:post|put|delete|patch)\b/i,
  /methods\s*=\s*\[[^\]]*(?:POST|PUT|DELETE|PATCH)/i,
  /\.(?:save|delete|update|create|insert|remove|drop)\(/i,
  /\bdef\s+(?:create|update|delete|remove|post|put|patch)_/i,
]

/** Authentication / authorization guards. */
export const AUTH_GUARD_PATTERNS: ReadonlyArray<RegExp> = [
  /login_required|requires?_auth|current_user|verify_token|check_permission|authorize|@requires\b|get_current_user|is_authenticated|Depends\([^)]*auth/i,
]

/** Prompt extraction signal (the prompt actually exists in code). */
export const PROMPT_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /prompt|system|developer|instruction|PromptTemplate|messages/i,
]

/** Dependency / model-download evidence. */
export const SUPPLY_DOWNLOAD_PATTERNS: ReadonlyArray<RegExp> = [
  /hf_hub_download|from_pretrained|torch\.load|snapshot_download|load_model|joblib\.load|pickle\.load/i,
  /requirements\.txt|pyproject\.toml|package\.json|pip\s+install|setup\.py/i,
]

/** Risky supply-chain patterns (unsafe source / deserialization). */
export const SUPPLY_RISKY_PATTERNS: ReadonlyArray<RegExp> = [
  /http:\/\/|git\+|\.tar\.gz|\.pkl\b|\.pickle\b/i,
  /torch\.load|pickle\.load|trust_remote_code\s*=\s*True|verify\s*=\s*False/i,
]

export function anyMatch(patterns: ReadonlyArray<RegExp>, text: string): boolean {
  return patterns.some((re) => re.test(text))
}

/** True when BOTH a SQL keyword and an interpolation marker appear — i.e. a
 *  query is being BUILT from interpolated content. */
export function looksLikeBuiltQuery(text: string): boolean {
  return anyMatch(SQL_KEYWORD_PATTERNS, text) && anyMatch(INTERPOLATION_PATTERNS, text)
}

/** Return 1-based line numbers within `lines` (offset by `startLine`)
 *  whose text matches ANY of `patterns`. */
export function matchingLines(
  patterns: ReadonlyArray<RegExp>,
  lines: string[],
  startLine: number,
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (anyMatch(patterns, lines[i])) {
      out.push({ line: startLine + i, text: lines[i].trim() })
    }
  }
  return out
}
