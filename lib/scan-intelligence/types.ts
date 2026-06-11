/**
 * Scan-time intelligence — shared types.
 *
 * This subsystem runs AFTER the deterministic Python scanner and never
 * mutates scanner-owned truth. The deterministic scanner is the source
 * of truth; the LLM can only:
 *   - verify existing findings (add review metadata)
 *   - downrank likely false positives (never delete)
 *   - suggest missed candidates (which only become findings once a
 *     deterministic check proves them)
 *
 * LLM output may ONLY populate the metadata-only fields in
 * `IntelligenceMetadata`. It must never change rule_id, severity,
 * category, file, line, evidence, fingerprint, or source/sink path.
 */

/** User-facing scan-time modes. Legacy ids (save/auto/pro/max/manual)
 *  are mapped to these via `normalizeScanMode`. */
export type ScanMode = "lite" | "balanced" | "deep" | "exhaustive"

/** Status badge attached to a finding after scan-time intelligence. */
export type FindingStatus =
  | "confirmed" // deterministic scanner proof (default for every scanner finding)
  | "llm_verified" // deterministic + LLM agreed it is real
  | "likely_false_positive" // LLM downranked; kept, never deleted
  | "gap_audit_confirmed" // LLM-suggested + deterministically proven new finding
  | "needs_rule_support" // candidate looks real but no deterministic rule proves it
  | "needs_human_review" // LLM uncertain; surfaced for a human

/** Verifier verdict (LLM). */
export type VerifierVerdict = "real" | "likely_false_positive" | "uncertain"

/** Metadata-only fields the LLM is allowed to add to a finding. These
 *  are the ONLY finding fields scan-time intelligence may write. */
export interface IntelligenceMetadata {
  status?: FindingStatus
  verifier_verdict?: VerifierVerdict
  verifier_confidence?: number
  verifier_reason?: string
  false_positive_reason?: string
  suggested_severity_adjustment?: "none" | "lower" | "raise"
  gap_audit_reason?: string
  model_used?: string
  context_hash?: string
  cached?: boolean
}

/** The scanner-owned fields the LLM must NEVER change. Used by tests and
 *  by the orchestrator's merge step which copies metadata only. */
export const SCANNER_OWNED_FIELDS = [
  "rule_id",
  "severity",
  "category",
  "file",
  "line",
  "evidence",
  "fingerprint",
  "evidence_path",
] as const

/** A single source→sink path node as emitted by the scanner IR. */
export interface EvidencePathNode {
  kind: string
  label: string
  file?: string | null
  line?: number | null
}

/** Loose finding shape read from the RAW Python report (pre-Zod-parse,
 *  so `fingerprint` is still present). Only the fields scan-time
 *  intelligence reads are typed; the rest pass through untouched. */
export interface ScanFinding {
  id: string
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
  evidence: string
  code?: string
  confidence?: number
  fingerprint?: string | null
  evidence_path?: EvidencePathNode[]
  // Allow metadata + any unknown scanner fields to ride along.
  [key: string]: unknown
}

/** A cluster of findings grouped by root cause. */
export interface Cluster {
  id: string
  /** Representative finding (highest severity / most evidence). */
  representative: ScanFinding
  findings: ScanFinding[]
  ruleId: string
  file: string
  sinkKind: string
  maxSeverity: "critical" | "high" | "medium" | "low"
  /** True when the evidence path crosses more than one file. */
  crossFile: boolean
}

/** A risky surface inventoried from the report (used by gap audit). */
export interface RiskSurface {
  kind: RiskSurfaceKind
  label: string
  file: string
  line: number
}

export type RiskSurfaceKind =
  | "llm_call"
  | "prompt_template"
  | "tool_definition"
  | "mcp_handler"
  | "subprocess_wrapper"
  | "db_query"
  | "auth_route"
  | "api_route"
  | "model_download"
  | "config_env_file"

/** Strict verifier output (matches section M of the spec). */
export interface VerifierResult {
  verdict: VerifierVerdict
  confidence: number
  reason: string
  evidence_used: string[]
  guards_found: string[]
  missing_evidence: string[]
  suggested_status: "llm_verified" | "likely_false_positive" | "needs_human_review"
  suggested_severity_adjustment: "none" | "lower" | "raise"
  scanner_truth_unchanged: true
}

/** A single gap-audit candidate (matches section N of the spec). LLM
 *  only SUGGESTS; it can never confirm. */
export interface GapAuditCandidate {
  candidate_title: string
  rule_family: string
  source_kind: string
  sink_kind: string
  file: string
  line: number
  evidence: string
  why_missed: string
  confidence: number
  needs_deterministic_confirmation: true
}

/** Result of deterministically confirming (or rejecting) a candidate. */
export type ConfirmationStatus =
  | "confirmed"
  | "rejected_no_path"
  | "rejected_guard_present"
  | "rejected_no_sink"
  | "rejected_no_source"
  | "needs_rule_support"
  | "needs_human_review"

export interface ConfirmationResult {
  status: ConfirmationStatus
  reason: string
}

/** Summary stamped onto the report under `intelligence_summary`. */
export interface IntelligenceSummary {
  mode: ScanMode
  ai_calls_used: number
  verifier_enabled: boolean
  gap_audit_enabled: boolean
  /** Set when AI was skipped entirely (no provider/key, quota, error).
   *  When present, all findings remain exactly as the scanner produced
   *  them (status defaults to "confirmed"). */
  ai_skipped_reason?: string
  clusters_reviewed: number
  downranked_false_positives: number
  confirmed_gaps: number
  // ---- Phase 5 per-mode metrics ----
  /** Total clusters discovered from deterministic findings. */
  candidate_clusters: number
  /** Clusters routed to the verifier for this mode. */
  selected_clusters: number
  /** Verifier verdict counts (cluster-level). */
  verified_real: number
  likely_false_positive: number
  needs_human_review: number
  /** Gap-audit candidate accounting. */
  gap_candidates: number
  gap_confirmed: number
  gap_rejected: number
  /** True if the AI-call budget was hit and some work was skipped. */
  budget_exhausted: boolean
  /** Human-readable one-liner for the UI scan-summary banner. */
  headline: string
}
