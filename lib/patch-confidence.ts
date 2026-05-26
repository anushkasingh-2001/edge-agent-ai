/**
 * Patch Confidence.
 *
 * Turns the objective validation signals into a single score + a UI
 * band. The re-scan remains the binary ARBITER (finding gone or not);
 * this layer exists purely for user trust — it tells the user how much
 * to scrutinize before clicking Apply.
 *
 * HARD RULE: every input here is an objective, machine-checked signal.
 * The LLM never rates its own patch. If we ever add an "LLM
 * self-confidence" field, it must NOT feed this score.
 *
 * Signal semantics
 * ----------------
 *   findingResolved          : the post-patch scanner re-scan no longer
 *                              reports the original finding for the
 *                              file's (rule_id, line) tuple.
 *   parses                   : the patched file passes the real parser
 *                              (Python `py_compile` / TS esbuild parse —
 *                              NOT a bracket-balance heuristic).
 *   diffApplied              : the unified diff applied cleanly to the
 *                              temp workspace's pre-patch content.
 *   touchedAllowedFilesOnly  : every file the patch touched was in the
 *                              caller's allow-list (single-file for
 *                              llm_simple_patch; the planned files
 *                              for llm_complex_patch).
 *   noNewHighCritical        : the post-patch re-scan introduced no
 *                              new high/critical-severity findings.
 *   testsPassed / buildPassed: ran in the temp workspace, or `null`
 *                              when not run (no test target / disabled).
 *   diffLines / matchesStyle : smaller, in-style diffs are safer.
 */

export interface ValidationSignals {
  /** Re-scan after applying the patch: did the original finding
   *  disappear? */
  findingResolved: boolean
  /** Patched file still parses (real parser, not bracket counting). */
  parses: boolean
  /** Did the unified diff apply cleanly to the temp workspace? */
  diffApplied: boolean
  /** Patch touched only files we allowed it to. */
  touchedAllowedFilesOnly: boolean
  /** Re-scan introduced NO new high/critical findings. */
  noNewHighCritical: boolean
  /** Tests ran and passed. null = not run (no test target / skipped). */
  testsPassed: boolean | null
  /** Build/typecheck passed. null = not run. */
  buildPassed: boolean | null
  /** Lines changed by the diff (smaller = safer). */
  diffLines: number
  /** Heuristic: patch matches surrounding indentation/quote style. */
  matchesStyle: boolean
}

export type ConfidenceBand = "strong" | "review" | "weak"

export interface ConfidenceResult {
  /** 0–100. */
  score: number
  band: ConfidenceBand
  /** Per-signal breakdown for the badge tooltip. */
  badges: { label: string; pass: boolean | null }[]
  /** One-line guidance shown next to the Apply button. */
  guidance: string
}

/**
 * Weighted scoring. The two non-negotiables (resolved + parses) act as
 * GATES: if either fails, the patch can never be "strong", regardless
 * of other signals.
 */
export function scorePatch(s: ValidationSignals): ConfidenceResult {
  const badges: ConfidenceResult["badges"] = [
    { label: "Finding resolved (re-scan)", pass: s.findingResolved },
    { label: "Code parses", pass: s.parses },
    { label: "Diff applied cleanly", pass: s.diffApplied },
    { label: "Only allowed files touched", pass: s.touchedAllowedFilesOnly },
    { label: "No new high/critical", pass: s.noNewHighCritical },
    { label: "Tests passed", pass: s.testsPassed },
    { label: "Build/typecheck passed", pass: s.buildPassed },
    { label: `Small diff (${s.diffLines} lines)`, pass: s.diffLines <= 15 },
    { label: "Matches project style", pass: s.matchesStyle },
  ]

  // Hard gates.
  const gatedFail =
    !s.findingResolved ||
    !s.parses ||
    !s.diffApplied ||
    !s.touchedAllowedFilesOnly

  // Weighted contributions (only count signals that actually ran).
  let score = 0
  score += s.findingResolved ? 35 : 0
  score += s.parses ? 20 : 0
  score += s.diffApplied ? 5 : 0
  score += s.touchedAllowedFilesOnly ? 5 : 0
  score += s.noNewHighCritical ? 10 : 0
  score += s.testsPassed === true ? 10 : 0
  score += s.buildPassed === true ? 5 : 0
  score += s.diffLines <= 15 ? 5 : s.diffLines <= 40 ? 2 : 0
  score += s.matchesStyle ? 5 : 0

  // If tests/build weren't run, cap the ceiling so we never show
  // "strong" for an unverified-by-tests patch on a repo that HAS tests.
  // (Caller passes null when there's genuinely no test target.)
  const unverified = s.testsPassed === null && s.buildPassed === null

  let band: ConfidenceBand
  let guidance: string
  if (gatedFail) {
    band = "weak"
    guidance = !s.findingResolved
      ? "Re-scan still reports the finding — this patch does not fix it. Review manually."
      : "Patch failed a basic safety check. Review carefully before applying."
    score = Math.min(score, 40)
  } else if (score >= 80 && !unverified) {
    band = "strong"
    guidance = "Validated end-to-end. Safe to apply."
  } else if (score >= 65) {
    band = "review"
    guidance = unverified
      ? "Validated by parse + re-scan, but no tests were run. Glance over the diff before applying."
      : "Mostly validated. Review the diff before applying."
  } else {
    band = "weak"
    guidance = "Partially validated. Needs a manual check before applying."
  }

  return { score: Math.round(score), band, badges, guidance }
}
