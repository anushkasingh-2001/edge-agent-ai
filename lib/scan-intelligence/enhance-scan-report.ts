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
import {
  selectClustersForMode,
  selectSurfacesForMode,
  normalizeRelPath,
} from "./select-clusters"
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
  RiskSurface,
  ScanFinding,
  ScanMode,
  VerifierResult,
} from "./types"

export interface EnhanceOptions {
  projectPath: string
  mode: ScanMode
}

/**
 * Best-effort set of project-relative paths the scan considers "changed"
 * (branch diff / working tree), used by priority scoring to push new or
 * modified code to the front of the verification queue.
 *
 * The report's `working_tree` carries COUNTS in most fields, but a few
 * fields carry actual PATHS. We harvest only path-bearing fields and stay
 * defensive about shape:
 *   - `stash_files: string[]`                     (paths a stash touched)
 *   - `untracked_attributed_other_branches[].path`
 *   - any future `modified_files` / `untracked_files` / `changed_files`
 *     string arrays (read opportunistically if present)
 *
 * When no exact paths are available we return `undefined` so the caller
 * passes no changedFiles context (rather than an empty set that would look
 * like "nothing changed").
 */
export function changedFilesFromReport(
  report: Record<string, unknown>,
  root?: string,
): Set<string> | undefined {
  const wt = report.working_tree
  if (!wt || typeof wt !== "object") return undefined
  const w = wt as Record<string, unknown>
  const out = new Set<string>()
  // Prefer the explicit root, fall back to the report's scan_root.
  const base = root ?? (typeof report.scan_root === "string" ? report.scan_root : undefined)

  const addStr = (v: unknown) => {
    // Normalise to a canonical relative path; skip anything that can't be
    // safely relativised (never guess).
    const norm = normalizeRelPath(v, base)
    if (norm) out.add(norm)
  }
  // String-array path fields (current + plausible future names).
  for (const key of ["stash_files", "modified_files", "untracked_files", "changed_files", "files"]) {
    const arr = w[key]
    if (Array.isArray(arr)) for (const v of arr) addStr(v)
  }
  // Object-array fields where each entry has a `.path`.
  const attributed = w.untracked_attributed_other_branches
  if (Array.isArray(attributed)) {
    for (const e of attributed) {
      if (e && typeof e === "object") addStr((e as Record<string, unknown>).path)
    }
  }

  return out.size > 0 ? out : undefined
}

/** Phase 5 metric fields, all zeroed — spread into summaries for the
 *  zero-AI return paths (lite, no-provider). */
const ZERO_METRICS = {
  candidate_clusters: 0,
  selected_clusters: 0,
  verified_real: 0,
  likely_false_positive: 0,
  needs_human_review: 0,
  gap_candidates: 0,
  gap_confirmed: 0,
  gap_rejected: 0,
  budget_exhausted: false,
} as const

/** Collected verifier output for one cluster (no shared state mutated). */
interface VerifyOutcomeData {
  result: VerifierResult
  usedModel: string
  contextHash: string
  cachedHit: boolean
  findingIds: string[]
}
type VerifyOutcome = VerifyOutcomeData | null

/** Collected gap-audit output for one surface. */
interface GapOutcomeData {
  candidates: GapAuditCandidate[]
  contextHash: string
  cachedHit: boolean
}
type GapOutcome = GapOutcomeData | null

/**
 * Run `worker` over `items` with at most `limit` in flight at once,
 * returning results in INPUT order (index-aligned). A worker is expected
 * to handle its own errors and return a sentinel (null) on failure; this
 * pool never rejects on a single item so one bad LLM call can't fail the
 * scan.
 *
 * Concurrency is bounded by spawning `limit` runners that pull from a
 * shared cursor. `cursor++` is synchronous (no await between read and
 * increment), so no two runners ever grab the same index.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runnerCount = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: runnerCount }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) break
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
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
  // Clone each finding and START CLEAN: every scan begins from scanner-owned
  // truth only. Any scan-time intelligence metadata that may have ridden in
  // on the raw finding (e.g. a report re-fed from a previous enriched scan)
  // is explicitly stripped so stale LLM labels never leak into a fresh scan
  // (notably Lite, which makes zero AI calls). The deterministic scanner
  // proved each finding, so status resets to "confirmed"; the verifier phase
  // layers any LLM statuses back on for Balanced/Deep/Exhaustive.
  const enriched: ScanFinding[] = rawFindings.map((f) => {
    const {
      status: _status,
      verifier_verdict: _vv,
      verifier_confidence: _vc,
      verifier_reason: _vr,
      false_positive_reason: _fpr,
      suggested_severity_adjustment: _ssa,
      gap_audit_reason: _gar,
      model_used: _mu,
      context_hash: _ch,
      cached: _cached,
      ...scannerOwned
    } = f as ScanFinding & IntelligenceMetadata
    return { ...scannerOwned, status: "confirmed" as const }
  })

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
      ...ZERO_METRICS,
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
      ...ZERO_METRICS,
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

  // ---- Phase 5 metrics ----
  let candidateClusters = 0
  let selectedClusters = 0
  let verifiedReal = 0
  let likelyFalsePositive = 0
  let needsHumanReview = 0
  let gapCandidates = 0
  let gapRejected = 0
  let budgetExhausted = false

  const byId = new Map(enriched.map((f) => [f.id, f]))

  // Branch-diff / working-tree signal for priority scoring (undefined when
  // the report carries no exact changed paths). Paths are normalised against
  // the project root so absolute/././backslash forms compare correctly.
  const changedFiles = changedFilesFromReport(report, projectPath)

  // Race-free budget reservation. JS is single-threaded, so the check +
  // increment below is atomic relative to other in-flight promises (there
  // is no `await` between them). This is what lets us run calls in parallel
  // while still enforcing `maxAiCalls` EXACTLY.
  const reserveCall = (): boolean => {
    if (aiCalls >= policy.maxAiCalls) {
      budgetExhausted = true
      return false
    }
    aiCalls++
    return true
  }

  try {
    // ================= Verifier (bounded parallel) =================
    if (policy.verifierEnabled) {
      const clusters = clusterFindings(enriched)
      const selected = selectClustersForMode(clusters, mode, { changedFiles })
      candidateClusters = clusters.length
      selectedClusters = selected.length
      const baseModel = resolveScanModel(provider.provider, policy.verifierTier)
      const escalateTier = policy.secondPassJudgeEnabled
        ? policy.judgeTier
        : policy.verifierEscalateTier
      const escalateModel = resolveScanModel(provider.provider, escalateTier)

      // Each worker reserves budget synchronously before awaiting a call,
      // so concurrent workers never exceed maxAiCalls. NO shared finding is
      // mutated here — we only collect outcomes and merge afterwards.
      const verifyOne = async (cluster: Cluster): Promise<VerifyOutcome> => {
        try {
          const bundle = buildClusterContextBundle(
            projectPath,
            cluster,
            policy.contextTokenCap,
            report,
          )
          if (!bundle) return null

          let usedModel = baseModel
          let cachedHit = true
          let result = getCached<VerifierResult>({
            phase: "verify",
            contextHash: bundle.contextHash,
            model: baseModel,
            mode,
          })
          if (!result) {
            if (!reserveCall()) return null
            cachedHit = false
            const out = await verifyCluster({
              cluster,
              bundle,
              provider: provider!.provider,
              apiKey: provider!.apiKey,
              baseUrl: provider!.baseUrl,
              model: baseModel,
            })
            if (out.ok) {
              result = out.result
              setCached(
                { phase: "verify", contextHash: bundle.contextHash, model: baseModel, mode },
                result,
              )
            }
          }
          if (!result) return null

          // Escalate high/critical uncertain clusters to a stronger model
          // (Balanced: cheap->mid; Deep/Exhaustive: ->judge). Judge is used
          // ONLY here — never blanket-applied to every finding.
          const highRisk =
            cluster.maxSeverity === "critical" || cluster.maxSeverity === "high"
          if (
            result.verdict === "uncertain" &&
            highRisk &&
            escalateModel !== baseModel
          ) {
            const escKey = {
              phase: "verify" as const,
              contextHash: bundle.contextHash,
              model: escalateModel,
              mode,
            }
            // Reuse a cached escalated result if one exists — no new AI call,
            // no budget spent.
            const cachedEsc = getCached<VerifierResult>(escKey)
            if (cachedEsc) {
              result = cachedEsc
              usedModel = escalateModel
              cachedHit = true
            } else if (reserveCall()) {
              const out2 = await verifyCluster({
                cluster,
                bundle,
                provider: provider!.provider,
                apiKey: provider!.apiKey,
                baseUrl: provider!.baseUrl,
                model: escalateModel,
              })
              if (out2.ok) {
                result = out2.result
                usedModel = escalateModel
                cachedHit = false
                // Cache the escalated result so a later scan with the same
                // context/model/mode reuses it without spending a call.
                setCached(escKey, result)
              }
            }
          }

          return { result, usedModel, contextHash: bundle.contextHash, cachedHit, findingIds: cluster.findings.map((f) => f.id) }
        } catch {
          // A single cluster failure must not fail the scan.
          return null
        }
      }

      const outcomes = await runWithConcurrency(
        selected,
        policy.verifierConcurrency,
        verifyOne,
      )

      // Merge metadata in DETERMINISTIC order (selected-cluster order). This
      // is the only place findings are mutated, and it runs single-pass
      // after all calls resolve — no cross-promise races.
      for (const outcome of outcomes) {
        if (!outcome) continue
        clustersReviewed++
        const meta = verifierMetadata(
          outcome.result,
          outcome.usedModel,
          outcome.contextHash,
          outcome.cachedHit,
        )
        for (const id of outcome.findingIds) {
          const target = byId.get(id)
          if (target) Object.assign(target, meta)
        }
        if (meta.status === "likely_false_positive") {
          likelyFalsePositive++
          downranked += outcome.findingIds.length
        } else if (meta.status === "llm_verified") {
          verifiedReal++
        } else if (meta.status === "needs_human_review") {
          needsHumanReview++
        }
      }
    }

    // ================= Gap audit (bounded parallel) =================
    if (policy.gapAuditEnabled) {
      const surfaces = buildRiskSurfaceInventory(report)
      const selectedSurfaces = selectSurfacesForMode(
        surfaces,
        mode,
        policy.maxGapAuditSurfaces,
      )
      const gapModel = resolveScanModel(provider.provider, policy.gapAuditTier)

      const auditOne = async (surface: RiskSurface): Promise<GapOutcome> => {
        try {
          const bundle = buildSurfaceContextBundle(
            projectPath,
            surface,
            policy.contextTokenCap,
            report,
          )
          if (!bundle) return null

          let cachedHit = true
          let candidates = getCached<GapAuditCandidate[]>({
            phase: "gap_audit",
            contextHash: bundle.contextHash,
            model: gapModel,
            mode,
          })
          if (!candidates) {
            if (!reserveCall()) return null
            cachedHit = false
            const out = await auditSurface({
              surface,
              bundle,
              provider: provider!.provider,
              apiKey: provider!.apiKey,
              baseUrl: provider!.baseUrl,
              model: gapModel,
            })
            if (out.ok) {
              candidates = out.candidates
              setCached(
                { phase: "gap_audit", contextHash: bundle.contextHash, model: gapModel, mode },
                candidates,
              )
            }
          }
          if (!candidates) return null
          return { candidates, contextHash: bundle.contextHash, cachedHit }
        } catch {
          return null
        }
      }

      const gapOutcomes = await runWithConcurrency(
        selectedSurfaces,
        policy.gapAuditConcurrency,
        auditOne,
      )

      // DETERMINISTIC GATE, run sequentially in surface/candidate order so
      // dedup against already-confirmed gaps is stable and reproducible.
      for (const outcome of gapOutcomes) {
        if (!outcome) continue
        for (const cand of outcome.candidates) {
          gapCandidates++
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
              outcome.contextHash,
              outcome.cachedHit,
            )
            enriched.push(newFinding)
            byId.set(newFinding.id, newFinding)
            confirmedGaps++
          } else {
            // Unconfirmed candidates are intentionally NOT added as findings
            // — they remain LLM suggestions with no deterministic proof.
            gapRejected++
          }
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
    candidate_clusters: candidateClusters,
    selected_clusters: selectedClusters,
    verified_real: verifiedReal,
    likely_false_positive: likelyFalsePositive,
    needs_human_review: needsHumanReview,
    gap_candidates: gapCandidates,
    gap_confirmed: confirmedGaps,
    gap_rejected: gapRejected,
    budget_exhausted: budgetExhausted,
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
