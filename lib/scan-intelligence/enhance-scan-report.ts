/**
 * Scan-time intelligence orchestrator.
 *
 * Runs AFTER the deterministic Python scanner. Implements the final scan
 * flow (spec section E):
 *   1. (scanner already ran — we receive its raw report)
 *   2. keep ALL deterministic findings (default status "confirmed")
 *   3. cluster findings by root cause
 *   4. build risk-surface inventory
 *   5. select clusters/surfaces per mode
 *   6. run the LLM verifier on selected clusters
 *   7. run the LLM gap audit on selected surfaces
 *   8. deterministically confirm/reject every LLM-suggested candidate
 *   9. attach status badges + intelligence_summary
 *
 * Safety guarantees:
 *   - The deterministic scanner is the source of truth. Verifier verdicts
 *     only add metadata; they never delete a finding or change a
 *     scanner-owned field.
 *   - A likely_false_positive is downranked, never deleted.
 *   - A gap-audit candidate becomes a finding ONLY when
 *     `confirmCandidate` proves it deterministically.
 *   - If AI is unavailable (no key, error, budget), the scan still
 *     returns every deterministic finding, with
 *     `intelligence_summary.ai_skipped_reason` set.
 */
import { policyFor } from "./mode-policy"
import { clusterFindings } from "./cluster-findings"
import { buildRiskSurfaceInventory } from "./risk-surface-inventory"
import { selectClustersForMode, selectSurfacesForMode } from "./select-clusters"
import {
  buildClusterContextBundle,
  buildSurfaceContextBundle,
} from "./build-scan-context-bundle"
import { verifyCluster } from "./llm-verifier"
import { auditSurface } from "./gap-auditor"
import { confirmCandidate } from "./deterministic-confirmation"
import { getCached, setCached } from "./cache"
import {
  resolveScanModel,
  resolveScanProvider,
  type ResolvedScanProvider,
} from "../server-llm-providers"
import { scanModeLabel } from "./normalize-mode"
import type {
  Cluster,
  GapAuditCandidate,
  IntelligenceMetadata,
  IntelligenceSummary,
  ScanFinding,
  ScanMode,
  VerifierResult,
} from "./types"

export interface EnhanceOptions {
  projectPath: string
  mode: ScanMode
}

function statusFromVerifier(r: VerifierResult): IntelligenceMetadata["status"] {
  switch (r.suggested_status) {
    case "llm_verified":
      return "llm_verified"
    case "likely_false_positive":
      return "likely_false_positive"
    case "needs_human_review":
      return "needs_human_review"
  }
}

function verifierMetadata(
  r: VerifierResult,
  model: string,
  contextHash: string,
  cached: boolean,
): IntelligenceMetadata {
  const status = statusFromVerifier(r)
  return {
    status,
    verifier_verdict: r.verdict,
    verifier_confidence: r.confidence,
    verifier_reason: r.reason,
    // Suggestion only — we record it but NEVER mutate the scanner severity.
    suggested_severity_adjustment: r.suggested_severity_adjustment,
    false_positive_reason:
      status === "likely_false_positive" ? r.reason : undefined,
    model_used: model,
    context_hash: contextHash,
    cached,
  }
}

/** Conservative severity for a deterministically-confirmed gap finding. */
function gapSeverity(c: GapAuditCandidate): ScanFinding["severity"] {
  const s = `${c.rule_family} ${c.sink_kind}`.toLowerCase()
  if (/exec|command|os\.system|subprocess|inject|cypher|sql|eval/.test(s)) return "high"
  if (/model[-_ ]?download|supply|deserial|pickle/.test(s)) return "high"
  return "medium"
}

function candidateToFinding(
  c: GapAuditCandidate,
  reason: string,
  model: string,
  contextHash: string,
  cached: boolean,
): ScanFinding {
  return {
    id: `gap-${contextHash}-${c.line}`,
    rule_id: `gap-audit/${c.rule_family || "unknown"}`,
    severity: gapSeverity(c),
    category: c.rule_family || "gap-audit",
    title: c.candidate_title || "Gap-audit confirmed issue",
    file: c.file,
    line: c.line,
    agent: "unknown",
    reason: c.why_missed || "Suggested by gap audit and deterministically confirmed.",
    suggestedFix: "",
    evidence: c.evidence || "",
    code: "",
    confidence: c.confidence,
    status: "gap_audit_confirmed",
    gap_audit_reason: reason,
    model_used: model,
    context_hash: contextHash,
    cached,
  }
}

function buildHeadline(s: {
  mode: ScanMode
  clusters: number
  downranked: number
  confirmedGaps: number
  skipped?: string
}): string {
  const label = scanModeLabel(s.mode)
  if (s.skipped) {
    return `${label} scan: AI review skipped (${s.skipped}); deterministic findings only.`
  }
  if (s.mode === "lite") {
    return `${label} scan: deterministic findings only, no AI used.`
  }
  const parts: string[] = [`reviewed ${s.clusters} cluster${s.clusters === 1 ? "" : "s"}`]
  parts.push(
    `downranked ${s.downranked} likely false positive${s.downranked === 1 ? "" : "s"}`,
  )
  parts.push(
    `confirmed ${s.confirmedGaps} missed issue${s.confirmedGaps === 1 ? "" : "s"}`,
  )
  return `${label} ${parts.join(", ")}.`
}

export async function enhanceScanReport(
  report: Record<string, unknown>,
  opts: EnhanceOptions,
): Promise<Record<string, unknown>> {
  const { projectPath, mode } = opts
  const policy = policyFor(mode)

  const rawFindings = Array.isArray(report.findings)
    ? (report.findings as unknown as ScanFinding[])
    : []
  // Clone each finding; every deterministic finding is "confirmed" by
  // default (the scanner proved it). LLM metadata is layered on top.
  const enriched: ScanFinding[] = rawFindings.map((f) => ({
    ...f,
    status: (f.status as IntelligenceMetadata["status"]) ?? "confirmed",
  }))

  const finalize = (summary: IntelligenceSummary): Record<string, unknown> => {
    report.findings = enriched
    report.intelligence_summary = summary
    return report
  }

  // ---- Lite: zero AI calls. ----
  if (!policy.verifierEnabled && !policy.gapAuditEnabled) {
    return finalize({
      mode,
      ai_calls_used: 0,
      verifier_enabled: false,
      gap_audit_enabled: false,
      clusters_reviewed: 0,
      downranked_false_positives: 0,
      confirmed_gaps: 0,
      headline: buildHeadline({ mode, clusters: 0, downranked: 0, confirmedGaps: 0 }),
    })
  }

  // ---- Provider availability (graceful skip). ----
  // Deep/Exhaustive prefer Anthropic's strong/judge tiers when an
  // ANTHROPIC_API_KEY is configured; Lite/Balanced stay cheap-first
  // (OpenAI preferred). Both fall back to whichever key exists.
  const preferredProvider = mode === "deep" || mode === "exhaustive" ? "anthropic" : "openai"
  let provider: ResolvedScanProvider | null
  try {
    provider = resolveScanProvider(preferredProvider)
  } catch {
    provider = null
  }
  if (!provider) {
    return finalize({
      mode,
      ai_calls_used: 0,
      verifier_enabled: policy.verifierEnabled,
      gap_audit_enabled: policy.gapAuditEnabled,
      ai_skipped_reason: "no_provider_configured",
      clusters_reviewed: 0,
      downranked_false_positives: 0,
      confirmed_gaps: 0,
      headline: buildHeadline({
        mode,
        clusters: 0,
        downranked: 0,
        confirmedGaps: 0,
        skipped: "no provider key",
      }),
    })
  }

  let aiCalls = 0
  let clustersReviewed = 0
  let downranked = 0
  let confirmedGaps = 0
  let skippedReason: string | undefined

  const byId = new Map(enriched.map((f) => [f.id, f]))

  try {
    // ---- Verifier on selected clusters. ----
    if (policy.verifierEnabled) {
      const clusters = clusterFindings(enriched)
      const selected = selectClustersForMode(clusters, mode)
      for (const cluster of selected) {
        if (aiCalls >= policy.maxAiCalls) break
        const bundle = buildClusterContextBundle(
          projectPath,
          cluster,
          policy.contextTokenCap,
          report,
        )
        if (!bundle) continue

        const baseModel = resolveScanModel(provider.provider, policy.verifierTier)
        let usedModel = baseModel
        let cachedHit = true
        let result = getCached<VerifierResult>({
          phase: "verify",
          contextHash: bundle.contextHash,
          model: baseModel,
          mode,
        })
        if (!result) {
          if (aiCalls >= policy.maxAiCalls) break
          const out = await verifyCluster({
            cluster,
            bundle,
            provider: provider.provider,
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: baseModel,
          })
          aiCalls++
          cachedHit = false
          if (out.ok) {
            result = out.result
            setCached(
              { phase: "verify", contextHash: bundle.contextHash, model: baseModel, mode },
              result,
            )
          }
        }
        if (!result) continue
        clustersReviewed++

        // Escalate high/critical uncertain clusters to a stronger model
        // (Balanced: cheap->mid; Deep/Exhaustive: ->judge).
        const escalateTier = policy.secondPassJudgeEnabled
          ? policy.judgeTier
          : policy.verifierEscalateTier
        const escalateModel = resolveScanModel(provider.provider, escalateTier)
        const highRisk =
          cluster.maxSeverity === "critical" || cluster.maxSeverity === "high"
        if (
          result.verdict === "uncertain" &&
          highRisk &&
          escalateModel !== baseModel &&
          aiCalls < policy.maxAiCalls
        ) {
          const out2 = await verifyCluster({
            cluster,
            bundle,
            provider: provider.provider,
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: escalateModel,
          })
          aiCalls++
          if (out2.ok) {
            result = out2.result
            usedModel = escalateModel
            cachedHit = false
          }
        }

        const meta = verifierMetadata(result, usedModel, bundle.contextHash, cachedHit)
        for (const f of cluster.findings) {
          const target = byId.get(f.id)
          if (target) Object.assign(target, meta)
        }
        if (meta.status === "likely_false_positive") {
          downranked += cluster.findings.length
        }
      }
    }

    // ---- Gap audit on selected risky surfaces. ----
    if (policy.gapAuditEnabled && aiCalls < policy.maxAiCalls) {
      const surfaces = buildRiskSurfaceInventory(report)
      const selectedSurfaces = selectSurfacesForMode(
        surfaces,
        mode,
        policy.maxGapAuditSurfaces,
      )
      const gapModel = resolveScanModel(provider.provider, policy.gapAuditTier)
      for (const surface of selectedSurfaces) {
        if (aiCalls >= policy.maxAiCalls) break
        const bundle = buildSurfaceContextBundle(
          projectPath,
          surface,
          policy.contextTokenCap,
          report,
        )
        if (!bundle) continue

        let cachedHit = true
        let candidates = getCached<GapAuditCandidate[]>({
          phase: "gap_audit",
          contextHash: bundle.contextHash,
          model: gapModel,
          mode,
        })
        if (!candidates) {
          const out = await auditSurface({
            surface,
            bundle,
            provider: provider.provider,
            apiKey: provider.apiKey,
            baseUrl: provider.baseUrl,
            model: gapModel,
          })
          aiCalls++
          cachedHit = false
          if (out.ok) {
            candidates = out.candidates
            setCached(
              { phase: "gap_audit", contextHash: bundle.contextHash, model: gapModel, mode },
              candidates,
            )
          }
        }
        if (!candidates) continue

        for (const cand of candidates) {
          // DETERMINISTIC GATE: only proven candidates become findings.
          const conf = confirmCandidate({
            candidate: cand,
            projectPath,
            existingFindings: enriched,
          })
          if (conf.status === "confirmed") {
            const newFinding = candidateToFinding(
              cand,
              conf.reason,
              gapModel,
              bundle.contextHash,
              cachedHit,
            )
            enriched.push(newFinding)
            byId.set(newFinding.id, newFinding)
            confirmedGaps++
          }
          // Unconfirmed candidates are intentionally NOT added as findings
          // — they remain LLM suggestions with no deterministic proof.
        }
      }
    }
  } catch (err) {
    // Any failure mid-flight degrades to deterministic findings; whatever
    // we managed to enrich so far is kept.
    skippedReason = err instanceof Error ? `error:${err.message.slice(0, 80)}` : "error"
  }

  return finalize({
    mode,
    ai_calls_used: aiCalls,
    verifier_enabled: policy.verifierEnabled,
    gap_audit_enabled: policy.gapAuditEnabled,
    ai_skipped_reason: skippedReason,
    clusters_reviewed: clustersReviewed,
    downranked_false_positives: downranked,
    confirmed_gaps: confirmedGaps,
    headline: buildHeadline({
      mode,
      clusters: clustersReviewed,
      downranked,
      confirmedGaps,
      skipped: skippedReason,
    }),
  })
}

// Re-export the unused-cluster type so consumers can import everything
// from the orchestrator if they prefer.
export type { Cluster }
