/**
 * Per-mode scan-time intelligence policy.
 *
 * Defines, for each mode, whether the verifier / gap audit / second-pass
 * judge run, the per-phase model tier, the AI-call budget, and the
 * context token cap. No model IDs are hardcoded permanently — concrete
 * models come from env-overridable defaults in `server-llm-providers.ts`
 * (section G of the spec).
 *
 * Budgets (spec H):
 *   lite       0 AI calls
 *   balanced   <= 8
 *   deep       <= 30
 *   exhaustive <= 80 (configurable)
 */
import type { ScanMode } from "./types"

/** Logical model tier. Resolved to a concrete model id per provider. */
export type ScanTier = "cheap" | "mid" | "strong" | "judge"

export interface ScanModePolicy {
  mode: ScanMode
  verifierEnabled: boolean
  gapAuditEnabled: boolean
  /** Second-pass judge for critical/uncertain clusters. */
  secondPassJudgeEnabled: boolean
  /** Base tier the verifier starts at. */
  verifierTier: ScanTier
  /** Tier the verifier escalates to for high/critical uncertain clusters. */
  verifierEscalateTier: ScanTier
  /** Tier used for gap-audit calls. */
  gapAuditTier: ScanTier
  /** Tier used for the second-pass judge (critical/uncertain only). */
  judgeTier: ScanTier
  /** Hard cap on AI calls per scan. */
  maxAiCalls: number
  /** Max risky surfaces to gap-audit. */
  maxGapAuditSurfaces: number
  /** Context bundle token cap (upper bound). */
  contextTokenCap: number
  /** Max in-flight verifier LLM calls (bounded parallelism). */
  verifierConcurrency: number
  /** Max in-flight gap-audit LLM calls (bounded parallelism). */
  gapAuditConcurrency: number
}

const ENV_MAX_EXHAUSTIVE = "EDGE_AGENT_SCAN_EXHAUSTIVE_MAX_CALLS"

function exhaustiveBudget(): number {
  const raw = process.env[ENV_MAX_EXHAUSTIVE]
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 80
}

export function policyFor(mode: ScanMode): ScanModePolicy {
  switch (mode) {
    case "lite":
      return {
        mode,
        verifierEnabled: false,
        gapAuditEnabled: false,
        secondPassJudgeEnabled: false,
        verifierTier: "cheap",
        verifierEscalateTier: "mid",
        gapAuditTier: "cheap",
        judgeTier: "judge",
        maxAiCalls: 0,
        maxGapAuditSurfaces: 0,
        contextTokenCap: 0,
        verifierConcurrency: 1,
        gapAuditConcurrency: 1,
      }
    case "balanced":
      return {
        mode,
        verifierEnabled: true,
        gapAuditEnabled: true,
        secondPassJudgeEnabled: false,
        // Cheap verifier first; escalate to mid only for high/critical
        // uncertain clusters.
        verifierTier: "cheap",
        verifierEscalateTier: "mid",
        gapAuditTier: "cheap",
        judgeTier: "judge",
        maxAiCalls: 8,
        maxGapAuditSurfaces: 3,
        contextTokenCap: 8_000,
        verifierConcurrency: 2,
        gapAuditConcurrency: 2,
      }
    case "deep":
      return {
        mode,
        verifierEnabled: true,
        gapAuditEnabled: true,
        // Judge runs only when a critical/high cluster stays uncertain.
        secondPassJudgeEnabled: true,
        verifierTier: "strong",
        verifierEscalateTier: "strong",
        gapAuditTier: "strong",
        judgeTier: "judge",
        maxAiCalls: 30,
        maxGapAuditSurfaces: 12,
        contextTokenCap: 24_000,
        verifierConcurrency: 4,
        gapAuditConcurrency: 4,
      }
    case "exhaustive":
      return {
        mode,
        verifierEnabled: true,
        gapAuditEnabled: true,
        secondPassJudgeEnabled: true,
        // Broad verifier on the strong model; the strongest judge is
        // reserved for critical/uncertain cases only (NOT every finding).
        verifierTier: "strong",
        verifierEscalateTier: "strong",
        gapAuditTier: "strong",
        judgeTier: "judge",
        maxAiCalls: exhaustiveBudget(),
        maxGapAuditSurfaces: 32,
        contextTokenCap: 64_000,
        verifierConcurrency: 6,
        gapAuditConcurrency: 6,
      }
  }
}
