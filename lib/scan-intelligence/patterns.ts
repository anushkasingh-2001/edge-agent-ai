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

export function anyMatch(patterns: ReadonlyArray<RegExp>, text: string): boolean {
  return patterns.some((re) => re.test(text))
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
