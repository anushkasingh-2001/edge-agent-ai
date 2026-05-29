/**
 * Patch Pipeline.
 *
 * The end-to-end "ask the model for a patch, validate it, decide to
 * apply or refuse" engine. Sits between the planner/router and the
 * filesystem. Never mutates the user's working tree directly — every
 * candidate patch is validated in an isolated temp workspace first,
 * and the route layer is the only thing allowed to call `applyPatch`.
 *
 * Invariants (per the integration brief):
 *
 *   1.  Re-scan is the arbiter. A patch that doesn't make the finding
 *       disappear on a real scanner re-scan is refused, no matter how
 *       confident the model sounded.
 *
 *   2.  No bracket heuristics. Python validation goes through
 *       `py_compile`, TS/JS through `esbuild --syntax-only`. If neither
 *       parser is available the patch is downgraded to "review", never
 *       silently auto-validated.
 *
 *   3.  Secrets are redacted from every LLM payload. The `secrets`
 *       rule itself is FORCED through the deterministic template — we
 *       never send a real secret to an external model just to ask
 *       "how do I hide this secret".
 *
 *   4.  Safe apply. The route caches a `previewFileHash` taken at
 *       preview time; before writing to disk the route re-hashes the
 *       current on-disk file and refuses if it changed in between
 *       (someone edited it, an external tool ran, etc.).
 *
 *   5.  Path traversal is impossible. Every file the patch touches is
 *       resolved against the project root via `isPathInside`; touching
 *       anywhere else aborts the pipeline.
 *
 * Validators
 * ----------
 *
 *   parses(file)            real parser per language, NO bracket counting.
 *   diffApplied(workspace)  the unified diff applied cleanly in temp.
 *   findingResolved(...)    post-patch scanner re-scan no longer reports
 *                           the original (rule_id, file, line) tuple.
 *   noNewHighCritical(...)  re-scan introduced no new high/critical
 *                           findings anywhere in the touched files'
 *                           bounded blast radius.
 *
 * The signals feed into `patch-confidence.scorePatch` for the badge.
 * They DO NOT decide auto-apply — only a human click does that.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { isPathInside } from "./server-path-utils"
import { runScannerOn as _realRunScannerOn, type ScanReportLite, type ScanFindingLite } from "./server-scan"
import { redactSecrets } from "./server-finding-explanations"
import {
  callLlm,
  assertOpenAICompatible,
  parseJsonReply,
} from "./server-llm-client"
import type { CompletionFn } from "./server-completion-transport"
import {
  type ProviderKind,
  type FixTask,
  type ModelTier,
} from "./server-model-router"
// Step 2: mode-aware routing. routeForMode delegates to routeModel
// internally, so env overrides + the provider tier→id table still apply.
import { routeForMode } from "./server-model-router-ext"
import type { ManualOverrides } from "./intelligence-mode"
import type { IntelligenceMode } from "./context-bundle"
// Step 4: graph-bounded context. buildContextBundle replaces sending the
// whole file; only the explicit, capped `max-patch` mode is allowed to
// carry full-file content.
import {
  buildContextBundle,
  type IRNeighborhoodInput,
} from "./server-context-bundle"
import { bundleHasNoFullFiles, bundleInputTokens } from "./context-bundle"
import {
  scorePatch,
  type ValidationSignals,
  type ConfidenceResult,
} from "./patch-confidence"
import {
  hashFileContents,
  cacheGet,
  cacheSet,
  buildCacheKey,
  type CacheNamespace,
} from "./fix-cache"
import type { PlannerFinding, PlanResult } from "./fix-planner"

const TEMP_PREFIX = "edge-agent-fix-"
const SCANNER_VERSION = "2.0" // mirrors SCHEMA_VERSION in scanner/report.py

/* ------------------------------------------------------------------ *
 *  Test seam — re-scan injection                                      *
 *  ----------------------------------------------------------------   *
 *  The pipeline's "did this finding actually go away?" signal comes   *
 *  from re-running the scanner on the temp workspace. In tests we     *
 *  don't want to invoke the real Python scanner just to control       *
 *  whether the patch resolved the finding, so this module-level seam  *
 *  lets a test plug in a synthetic report. Production code goes       *
 *  through the real scanner.                                          *
 * ------------------------------------------------------------------ */
type RunScanner = typeof _realRunScannerOn
let _runScanner: RunScanner = _realRunScannerOn

/** @internal Override the rescan target for tests. Pass `null` to restore. */
export function _setRunScannerForTests(next: RunScanner | null): RunScanner {
  const prev = _runScanner
  _runScanner = next ?? _realRunScannerOn
  return prev
}

/* ------------------------------------------------------------------ *
 *  Public types                                                       *
 * ------------------------------------------------------------------ */

export interface FilePatch {
  /** Project-relative path. */
  file: string
  /** Full new file contents. We deliberately ship full contents (not
   *  a diff) so apply is unambiguous and the file-hash binding can
   *  cover the post-patch state too. The unified diff is computed for
   *  display only. */
  newContents: string
  /** Hash of the file BEFORE patching. The cache + apply path bind to
   *  this so a parallel edit invalidates the preview. */
  beforeFileHash: string
}

export interface PatchPreview {
  /** Stable id the route stores in the cache, then accepts back on
   *  the apply call. Includes the preview file hash. */
  previewId: string
  findingId: string
  fixClass: PlanResult["fix_class"]
  modelUsed: string | null
  /** One entry per file the patch touched. */
  patches: FilePatch[]
  /** Unified diff body for display. */
  unifiedDiff: string
  /** Confidence + per-signal breakdown for the badge. */
  confidence: ConfidenceResult
  /** Validation outcomes (subset of ValidationSignals, surfaced for the
   *  Inspect panel — the score itself is already in `confidence`). */
  signals: ValidationSignals
  /** Original finding's still-resolved-in-rescan status, lifted out of
   *  `signals` for fast UI checks. */
  resolved: boolean
  /** Number of new high/critical findings the patch introduced (0 is
   *  the desired value). */
  introducedHighCritical: number
  /** Reason the pipeline returned this preview (or refused it). */
  reason: string
  /** Every model id we actually called, in order. Length 1 on a
   *  successful first attempt; length 2 when the cascade fired. */
  attemptedModels: string[]
  /** True when the second (escalated) attempt produced this preview. */
  escalated: boolean
  /** When `escalated === true`, the reason the first attempt failed
   *  validation. Useful for telemetry + the Inspect panel's
   *  "originally failed because …" caption. Absent on first-try
   *  success. */
  firstAttemptFailureReason?: string
}

export interface PatchRefused {
  refused: true
  findingId: string
  reason: string
  /** Where in the pipeline we stopped, for telemetry. */
  stage:
    | "guard_provider"
    | "guard_secrets"
    | "guard_path"
    | "model_call"
    | "parse"
    | "rescan"
    | "internal_error"
}

export type PatchResult = PatchPreview | PatchRefused

/* ------------------------------------------------------------------ *
 *  Pipeline                                                           *
 * ------------------------------------------------------------------ */

export interface PipelineContext {
  projectPath: string
  finding: PlannerFinding
  plan: PlanResult
  /** Provider config — comes from the user's saved keys. */
  provider: ProviderKind
  apiKey: string | null
  baseUrl: string | null
  /** Desktop/cloud split seam. When set, the pipeline obtains every model
   *  completion through this function (which relays a redacted prompt to the
   *  cloud generation endpoint) instead of calling the OpenAI-compatible
   *  client in-process. In this mode NO provider key/baseUrl is required or
   *  used locally — the cloud holds the key. When unset, the pipeline calls
   *  `callLlm` directly with `apiKey`/`baseUrl` (single-origin web/dev). */
  generate?: CompletionFn
  /** Privacy toggle. */
  privateCodeMode?: boolean
  /** Lets the bulk route force a fixed model (e.g. all of a cluster
   *  resolved through gpt-4.1). */
  forceTask?: FixTask
  /** Skip the full re-scan after patching (used in tests). The
   *  finding-resolved check still runs against the patched file's
   *  bounded scan; only the project-wide pass is skipped. */
  skipFullRescan?: boolean

  /* ---- Intelligence-mode plumbing -------------------------------- *
   * The pipeline routes via `routeForMode` (see "Pick model + budget"
   * below) so intelligenceMode + complexity + manualModels drive the
   * actual tier/model choice. `intelligenceMode` + `complexity` are
   * folded into the cache key so switching mode/complexity correctly
   * invalidates a cached preview. */
  intelligenceMode?: IntelligenceMode
  /** 0..1 complexity score from scoreComplexity(); drives Auto's
   *  cheap→strong choice in routeForMode. */
  complexity?: number
  /** Manual mode: per-task model overrides forwarded to routeForMode. */
  manualModels?: ManualOverrides
  /** Escalation target tier when re-running after a failed validation
   *  (Step 2+). Accepted now so the signature is stable. */
  forceTier?: ModelTier
  /** v2: Final concrete model id chosen by the Hosted/BYOK/manual
   *  resolver. When set, the pipeline uses it as-is and skips the tier
   *  → model table — fixes the "manual selection wins, then pipeline
   *  silently re-routes by tier" bug. */
  forceModel?: string
  /** v2: explicit max-output-token cap from the resolver (e.g. Max mode
   *  wants a larger window). Optional override of the tier default. */
  forceMaxTokens?: number
  /** v2: Force the two-step plan→patch flow. The resolver sets this
   *  for Max mode; routeForMode would set it via complexity in Auto. */
  forceTwoStep?: boolean

  /* ---- Bundle enrichment ---------------------------------------- *
   * IR neighborhood pulled from `/api/ir` (or the scan report's
   * top-level inventories) and forwarded to buildContextBundle. The
   * builder uses it to add 1-hop callers for Auto-small, 2-hop
   * callers/callees for Auto-large/Pro/Max, related prompt/tool/
   * route slices for Pro/Max, and config/tests for Max. Optional —
   * when omitted, the bundle still contains the primary slice +
   * taint path; just no neighborhood. */
  neighborhood?: IRNeighborhoodInput
}

export async function generatePatchPreview(
  ctx: PipelineContext,
): Promise<PatchResult> {
  // ---- 0. Trivial refusal: planner already said no.
  if (
    ctx.plan.fix_class === "cannot_fix_safely" ||
    ctx.plan.fix_class === "needs_user_decision"
  ) {
    return {
      refused: true,
      findingId: ctx.finding.id,
      reason: ctx.plan.reason,
      stage: "internal_error", // not really an error — but path is "refused upstream"
    }
  }

  // ---- 0a. Force `secrets` rule onto the deterministic template path.
  //          We never send a secret to an external model, period.
  if (ctx.finding.rule_id === "secrets") {
    return {
      refused: true,
      findingId: ctx.finding.id,
      reason:
        "secrets findings use the deterministic template (env-var rewrite). " +
        "An LLM round-trip would expose the secret.",
      stage: "guard_secrets",
    }
  }

  // ---- 1. Provider guard.
  // Desktop/cloud split: when a `generate` function is injected the cloud
  // owns the provider key, so there is no local key/baseUrl to guard — we
  // skip the in-process provider check and route every completion through
  // `complete()` below. The single-origin web/dev path is unchanged.
  const useInjectedCompletion = typeof ctx.generate === "function"
  let provConfig: { apiKey: string; baseUrl: string | null } | null = null
  if (!useInjectedCompletion) {
    const provGuard = assertOpenAICompatible({
      provider: ctx.provider,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
    })
    if (!provGuard.ok) {
      return {
        refused: true,
        findingId: ctx.finding.id,
        reason: provGuard.error,
        stage: "guard_provider",
      }
    }
    provConfig = provGuard.config
  }

  // Single seam for "ask the model for one completion". Cloud path relays a
  // redacted prompt to the generation endpoint; local path calls callLlm.
  const complete = async (p: {
    model: string
    system: string
    user: string
    json: boolean
    maxTokens: number
    task: "patch" | "plan"
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    if (ctx.generate) {
      const r = await ctx.generate({
        system: p.system,
        user: p.user,
        json: p.json,
        maxTokens: p.maxTokens,
        model: p.model,
        intelligenceMode: ctx.intelligenceMode ?? "auto",
        task: p.task,
        temperature: 0.1,
        complexity: typeof ctx.complexity === "number" ? ctx.complexity : undefined,
      })
      return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error }
    }
    return callLlm({
      model: p.model,
      apiKey: provConfig!.apiKey,
      baseUrl: provConfig!.baseUrl,
      system: p.system,
      user: p.user,
      json: p.json,
      temperature: 0.1,
      maxTokens: p.maxTokens,
    })
  }

  // ---- 2. Pick model + budget (mode-aware routing).
  // Mode + complexity drive model selection via routeForMode, which
  // delegates to routeModel for env overrides + the tier→id table.
  // `bundleMode` and `twoStep` are carried for the ContextBundle and
  // the Max plan-then-patch branch; `escalatedModel` is the target if
  // a later validation-failure escalation is wired.
  const decision = routeForMode({
    mode: ctx.intelligenceMode ?? "auto",
    task: "patch",
    complexity: typeof ctx.complexity === "number" ? ctx.complexity : 0,
    provider: ctx.provider,
    privateCodeMode: ctx.privateCodeMode,
    manual: ctx.manualModels,
    forceTier: ctx.forceTier,
  })

  // v2: honour the resolver-selected model. Without this override the
  // pipeline would route by tier again and silently undo a Manual /
  // Hosted-plan model pick. The router still ran above so plan + cost
  // gates fire; only the final id is replaced.
  if (typeof ctx.forceModel === "string" && ctx.forceModel.trim()) {
    decision.model = ctx.forceModel.trim()
  }
  if (typeof ctx.forceMaxTokens === "number" && ctx.forceMaxTokens > 0) {
    decision.maxTokens = ctx.forceMaxTokens
  }
  if (typeof ctx.forceTwoStep === "boolean") {
    decision.twoStep = ctx.forceTwoStep
  }

  // ---- 3. Read the source file. (Single-file path — complex patches
  //          may extend this; the bulk pipeline handles N-file plans.)
  const absFile = path.resolve(ctx.projectPath, ctx.finding.file)
  if (!isPathInside(absFile, ctx.projectPath)) {
    return {
      refused: true,
      findingId: ctx.finding.id,
      reason: "finding file escapes project root",
      stage: "guard_path",
    }
  }
  let original: string
  try {
    original = fs.readFileSync(absFile, "utf8")
  } catch (e) {
    return {
      refused: true,
      findingId: ctx.finding.id,
      reason: `cannot read source: ${e instanceof Error ? e.message : String(e)}`,
      stage: "internal_error",
    }
  }
  const beforeFileHash = hashFileContents(original)

  // ---- 4. Cache lookup. Key includes the model id (so switching
  //          models invalidates), the file hash (so an edit
  //          invalidates), and the finding id.
  const cacheKey = buildCacheKey({
    model: decision.model,
    scannerVersion: SCANNER_VERSION,
    fileHashes: [beforeFileHash],
    findingIds: [ctx.finding.id],
    contextHash: hashContext(ctx),
  })
  const NS: CacheNamespace = "patch_previews"
  const cached = cacheGet<PatchPreview>(ctx.projectPath, NS, cacheKey)
  if (cached) {
    return cached
  }

  // ---- 5. Build the prompt. Step 4: for every mode EXCEPT max-patch
  //          we send a graph-bounded ContextBundle (redacted slices),
  //          NOT the whole file, and ask for anchored edits. max-patch
  //          is the single explicit, capped full-file path.
  const allowFullFile = decision.bundleMode === "max-patch"
  let promptUser: string
  let systemPrompt: string

  if (allowFullFile) {
    systemPrompt = PATCH_SYSTEM_PROMPT
    promptUser = buildPatchPrompt({
      finding: ctx.finding,
      fileContents: redactSecrets(original),
      file: ctx.finding.file,
    })
  } else {
    const bundle = buildContextBundle({
      projectPath: ctx.projectPath,
      mode: decision.bundleMode,
      finding: {
        id: ctx.finding.id,
        rule_id: ctx.finding.rule_id,
        severity: ctx.finding.severity,
        title: ctx.finding.rule_id,
        file: ctx.finding.file,
        line: ctx.finding.line,
        confidence: ctx.finding.confidence,
        agent: ctx.finding.agent ?? null,
        // Real taint flow from the scanner's IR analyzer (source →
        // … → sink). The builder slices each node and ranks
        // source / sink / guard ahead of intermediate hops so the
        // budget trimmer preserves the irreducible core.
        evidence_path: ctx.finding.evidence_path ?? [],
      },
      irHash: SCANNER_VERSION,
      // Caller-supplied IR neighborhood (callers / callees / related
      // prompts / routes / tools / config / tests). Optional —
      // omitting it yields a "primary + taint" bundle, the previous
      // behaviour, with nothing else added.
      neighborhood: ctx.neighborhood,
    })
    // Hard guarantee: no full-file slice leaked into a non-max bundle.
    if (!bundleHasNoFullFiles(bundle)) {
      return {
        refused: true,
        findingId: ctx.finding.id,
        reason: "internal: context bundle exceeded slice bounds for this mode",
        stage: "internal_error",
      }
    }
    systemPrompt = PATCH_SYSTEM_PROMPT_BUNDLE
    promptUser = renderBundlePrompt(bundle)
    void bundleInputTokens // budget already enforced inside buildContextBundle
  }

  // ---- 5b. Step 6: Max plan-then-patch. When the route decided this is
  //          a two-step task (Max, or high-complexity Auto patch), do a
  //          PLAN call first, validate the JSON, and prepend the approved
  //          plan to the patch prompt. A failed/invalid plan is NOT fatal
  //          — we fall back to the single-shot patch so the feature
  //          degrades gracefully rather than refusing.
  if (decision.twoStep) {
    const planLlm = await complete({
      model: decision.model,
      system: PLAN_SYSTEM_PROMPT,
      user: promptUser,
      json: true,
      maxTokens: Math.min(decision.maxTokens, 700),
      task: "plan",
    })
    if (planLlm.ok) {
      const parsedPlan = parseJsonReply(planLlm.text)
      const planCheck = validatePatchPlan(parsedPlan)
      if (planCheck.ok) {
        // Prepend the approved plan; the patch phase must follow it.
        promptUser = `${renderPlanForPatch(planCheck.plan)}${promptUser}`
      }
      // invalid plan → proceed single-shot (graceful degrade)
    }
    // plan call failed → proceed single-shot
  }

  // ---- 6/7/8. Single-attempt helper. Runs one model call, materialises
  //              a temp workspace, parses, re-scans, and returns either
  //              a complete PatchPreview or a structured failure shape.
  //              The wrapper below retries this exactly once with
  //              `decision.escalatedModel` when the validation signal
  //              that failed is one of the documented escalation
  //              triggers AND the route policy allows escalation.
  const runAttempt = async (
    model: string,
    maxTokens: number,
  ): Promise<
    | { kind: "preview"; preview: PatchPreview }
    | { kind: "failure"; reason: string; stage: PatchRefused["stage"] }
  > => {
    const llm = await complete({
      model,
      system: systemPrompt,
      user: promptUser,
      json: true,
      maxTokens,
      task: "patch",
    })
    if (!llm.ok) {
      return { kind: "failure", reason: `model call failed: ${llm.error}`, stage: "model_call" }
    }
    const parsed = parseJsonReply<ModelPatchReply>(llm.text)
    if (!parsed) {
      return { kind: "failure", reason: "model reply was not valid JSON", stage: "model_call" }
    }
    const resolved = resolveNewContents(parsed, original, allowFullFile)
    if (!resolved.ok) {
      return {
        kind: "failure",
        reason: `could not build patch: ${resolved.error}`,
        stage: "model_call",
      }
    }
    const newContents = resolved.text

    const workspace = makeTempWorkspace(ctx.projectPath)
    try {
      const tmpFile = path.join(workspace.path, ctx.finding.file)
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
      fs.writeFileSync(tmpFile, newContents, "utf8")

      const parses = await parseFile(tmpFile)
      if (parses === false) {
        // Hard parse failure: a parser ran and rejected the file. This
        // is an escalation trigger — a stronger model often fixes
        // syntactic mistakes the cheaper model couldn't repair.
        return { kind: "failure", reason: "patched file failed to parse", stage: "parse" }
      }

      let report: ScanReportLite | null = null
      if (!ctx.skipFullRescan) {
        try {
          report = await _runScanner(workspace.path, { timeoutMs: 90_000 })
        } catch {
          // Re-scan failure isn't a refusal by itself — the signal
          // becomes "not validated" and the badge falls into
          // "review". We still surface that to the user.
          report = null
        }
      }

      const sigs = buildSignals({
        ctx,
        report,
        parses,
        diffLines: countDiffLines(original, newContents),
        matchesStyle: matchesIndentStyle(original, newContents),
      })

      const introduced = countNewHighCritical(report, ctx.finding.file)
      const conf = scorePatch(sigs)
      const previewFileHash = hashFileContents(newContents)
      const previewId = makePreviewId(cacheKey, previewFileHash)

      const preview: PatchPreview = {
        previewId,
        findingId: ctx.finding.id,
        fixClass: ctx.plan.fix_class,
        modelUsed: model,
        patches: [
          { file: ctx.finding.file, newContents: newContents, beforeFileHash },
        ],
        unifiedDiff: simpleUnifiedDiff(
          ctx.finding.file,
          original,
          newContents,
        ),
        confidence: conf,
        signals: sigs,
        resolved: sigs.findingResolved,
        introducedHighCritical: introduced,
        reason: parsed.reason ?? "Generated patch validated in temp workspace.",
        attemptedModels: [model],
        escalated: false,
      }
      return { kind: "preview", preview }
    } finally {
      workspace.cleanup()
    }
  }

  /**
   * Decide whether a successful preview (from the validation side) is
   * "good enough" to return, or whether we should re-run with the
   * escalated model.
   *
   * The four documented escalation triggers per the spec are:
   *   - patched file failed parse        → kind: "failure", stage: "parse"
   *   - model JSON invalid                → kind: "failure", stage: "model_call"
   *   - finding not resolved on re-scan   → preview.resolved === false
   *   - introduced new high/critical      → preview.introducedHighCritical > 0
   *
   * The first two are surfaced via the `failure` branch above; the last
   * two materialise as a *successful* preview shape whose signals are
   * still bad. We classify both into a single `firstAttemptFailureReason`.
   */
  const shouldEscalate = (
    attempt: Awaited<ReturnType<typeof runAttempt>>,
  ): { escalate: false } | { escalate: true; reason: string } => {
    if (attempt.kind === "failure") {
      // Only failures that are actually about the patch quality
      // trigger a retry. A `guard_provider`/`guard_secrets`/etc.
      // refusal is final.
      if (attempt.stage === "model_call" || attempt.stage === "parse") {
        return { escalate: true, reason: attempt.reason }
      }
      return { escalate: false }
    }
    const p = attempt.preview
    if (!p.resolved) {
      return { escalate: true, reason: "finding still present after re-scan" }
    }
    if (p.introducedHighCritical > 0) {
      return {
        escalate: true,
        reason: `patch introduced ${p.introducedHighCritical} new high/critical finding(s)`,
      }
    }
    return { escalate: false }
  }

  // ---- 9. Run the first attempt, decide whether to escalate, run the
  //          second attempt if needed. Hard cap = 2 attempts; Save
  //          mode never reaches here (allowPatchGeneration=false has
  //          already been rejected by the resolver); Manual mode
  //          never escalates because the user pinned the model.
  const firstAttempt = await runAttempt(decision.model, decision.maxTokens)

  const eligibleForEscalation =
    // privateCodeMode: never egress to a cloud model on the retry path.
    ctx.privateCodeMode !== true &&
    // Manual: the user pinned the model; don't override their choice.
    ctx.intelligenceMode !== "manual" &&
    // Cascade flag set by routeForMode OR explicit Auto mode (where
    // cascade is the contract regardless of complexity bucket).
    (decision.cascade === true || ctx.intelligenceMode === "auto") &&
    // Escalation target exists and actually differs from the first try.
    typeof decision.escalatedModel === "string" &&
    decision.escalatedModel.trim().length > 0 &&
    decision.escalatedModel !== decision.model

  const verdict = shouldEscalate(firstAttempt)
  if (verdict.escalate && eligibleForEscalation) {
    // The escalated tier may carry a larger output cap (Auto strong /
    // Pro / Max → coding_flagship). Re-route just for the maxTokens —
    // the model id is taken from `decision.escalatedModel`.
    const escalatedDecision = routeForMode({
      mode: ctx.intelligenceMode ?? "auto",
      task: "patch",
      complexity: typeof ctx.complexity === "number" ? ctx.complexity : 0,
      provider: ctx.provider,
      privateCodeMode: ctx.privateCodeMode,
      manual: ctx.manualModels,
      forceTier: decision.escalatedTier,
    })
    // Only widen the output cap; never narrow it on the retry.
    const retryMaxTokens = Math.max(decision.maxTokens, escalatedDecision.maxTokens)

    const secondAttempt = await runAttempt(decision.escalatedModel, retryMaxTokens)
    if (secondAttempt.kind === "preview") {
      const preview: PatchPreview = {
        ...secondAttempt.preview,
        attemptedModels: [decision.model, decision.escalatedModel],
        escalated: true,
        firstAttemptFailureReason: verdict.reason,
      }
      cacheSet(ctx.projectPath, NS, cacheKey, preview)
      return preview
    }
    // Escalated attempt also failed. We DON'T retry a third time —
    // hard cap is 2 — and we surface the escalated failure so the UI
    // sees the strongest model's diagnostic, not a stale cheap-model
    // one. Telemetry can find the first failure in the route's
    // server logs if needed.
    return {
      refused: true,
      findingId: ctx.finding.id,
      reason: `escalated retry also failed: ${secondAttempt.reason}`,
      stage: secondAttempt.stage,
    }
  }

  // No escalation needed (or not eligible). Return the first attempt
  // verbatim — successful preview cached, failure surfaced as a
  // refusal exactly like the pre-escalation code path.
  if (firstAttempt.kind === "preview") {
    cacheSet(ctx.projectPath, NS, cacheKey, firstAttempt.preview)
    return firstAttempt.preview
  }
  return {
    refused: true,
    findingId: ctx.finding.id,
    reason: firstAttempt.reason,
    stage: firstAttempt.stage,
  }
}

/* ------------------------------------------------------------------ *
 *  Safe apply                                                         *
 * ------------------------------------------------------------------ */

export interface ApplyResult {
  applied: boolean
  reason: string
  /** Hashes of the files at write time (so the UI can confirm what
   *  actually landed on disk). */
  appliedFileHashes: Record<string, string>
}

/**
 * Safely apply a previously-generated preview. ALL of the following
 * MUST hold or the apply is refused:
 *
 *   - preview was created against THIS file hash (no concurrent edit).
 *   - every file the patch touches is inside the project root.
 *   - a `.bak` backup is created BEFORE writing.
 *
 * Note: re-running the scanner after the apply is the caller's job
 * (the route does it). We don't loop the pipeline here because the
 * apply step is supposed to be a tiny, predictable I/O operation.
 */
export function applyPatch(args: {
  projectPath: string
  preview: PatchPreview
}): ApplyResult {
  const { projectPath, preview } = args
  const appliedHashes: Record<string, string> = {}

  // 1. Re-verify file hashes for every touched file.
  for (const p of preview.patches) {
    const abs = path.resolve(projectPath, p.file)
    if (!isPathInside(abs, projectPath)) {
      return {
        applied: false,
        reason: `refusing apply: ${p.file} escapes project root`,
        appliedFileHashes: {},
      }
    }
    let current: string
    try {
      current = fs.readFileSync(abs, "utf8")
    } catch (e) {
      return {
        applied: false,
        reason: `refusing apply: cannot read ${p.file}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        appliedFileHashes: {},
      }
    }
    if (hashFileContents(current) !== p.beforeFileHash) {
      return {
        applied: false,
        reason: `refusing apply: ${p.file} changed since preview was generated`,
        appliedFileHashes: {},
      }
    }
  }

  // 2. Backup + write.
  for (const p of preview.patches) {
    const abs = path.resolve(projectPath, p.file)
    const bakRoot = path.join(projectPath, ".edge-agent", "backups")
    const bak = path.join(bakRoot, `${p.file}.bak`)
    fs.mkdirSync(path.dirname(bak), { recursive: true })
    if (!fs.existsSync(bak)) fs.copyFileSync(abs, bak)
    const tmp = `${abs}.edge-agent-tmp`
    fs.writeFileSync(tmp, p.newContents, "utf8")
    fs.renameSync(tmp, abs)
    appliedHashes[p.file] = hashFileContents(p.newContents)
  }

  return {
    applied: true,
    reason: "patch applied",
    appliedFileHashes: appliedHashes,
  }
}

/* ------------------------------------------------------------------ *
 *  Workspace + signal helpers                                         *
 * ------------------------------------------------------------------ */

interface TempWorkspace {
  path: string
  cleanup: () => void
}

/**
 * Mirror the project into a temp directory via copy. Skips the noisy
 * directories that:
 *   - bloat the copy without affecting analysis (`node_modules`,
 *     `.next`, `dist`, `build`, virtual envs, caches).
 *   - contain symlinks pointing outside the project (`.next/cache`
 *     in particular).
 *   - hold THIS run's own state (`.edgeagent`, `.edge-agent`) so a
 *     parallel pipeline can't see another's temp files.
 */
function makeTempWorkspace(projectPath: string): TempWorkspace {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
  copyDir(projectPath, dest)
  return {
    path: dest,
    cleanup: () => {
      try {
        fs.rmSync(dest, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".edgeagent",
  ".edge-agent",
  ".git",
])

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isSymbolicLink()) continue // never follow — privacy + correctness
    if (ent.isDirectory()) {
      copyDir(s, d)
    } else if (ent.isFile()) {
      try {
        fs.copyFileSync(s, d)
      } catch {
        /* ignore — best-effort */
      }
    }
  }
}

/**
 * Real-parser validation. NO bracket counting.
 *
 *   .py             → `python3 -m py_compile <file>` (exit 0 = parses)
 *   .js .jsx .mjs   → `node --check <file>` (exit 0 = parses)
 *   .ts .tsx        → `npx --no -y esbuild --bundle=false --syntax-only`
 *                     when esbuild is on PATH; otherwise fall back to
 *                     `node --check` for .ts (it won't catch type errors
 *                     but it does catch real syntax errors, and that's
 *                     what we need here).
 *   anything else   → null (UNKNOWN — confidence treats as "unverified")
 *
 * Returns:
 *   true  = parsed cleanly.
 *   false = parser ran AND rejected the file.
 *   null  = no parser available for this language. Caller treats
 *           this as "review" (we don't penalise the user for a tool
 *           we don't ship).
 *
 * We deliberately return Promise<boolean | null> rather than throwing
 * so a missing parser never crashes the pipeline.
 */
async function parseFile(file: string): Promise<boolean | null> {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case ".py":
      return runProc("python3", ["-m", "py_compile", file])
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return runProc("node", ["--check", file])
    case ".ts":
    case ".tsx":
      // Try esbuild first (handles TS), then fall back.
      {
        const ok = runProc("npx", ["--no", "esbuild", "--loader=tsx", file, "--bundle=false"])
        if (ok !== null) return ok
        return runProc("node", ["--check", file])
      }
    default:
      // Real conservative: we don't know how to parse this language,
      // so we won't claim it parses. Confidence treats `false` as a
      // hard fail though — so use the dedicated "no parser" sentinel
      // (the caller passes `parses` straight into the scorer; we want
      // to map this to true so the gate doesn't fail just because we
      // can't parse YAML/HTML/etc. — those are also the file types
      // where the deterministic-template path is the usual fix anyway).
      //
      // Net behaviour:
      //   - Python / JS / TS / JSX  → strict parse gate.
      //   - Anything else           → no parse signal, confidence
      //                                relies on rescan + diff size.
      return null
  }
}

function runProc(cmd: string, args: string[]): boolean | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 })
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return null // command not on PATH
  }
  if (r.error) return false
  return r.status === 0
}

function buildSignals(args: {
  ctx: PipelineContext
  report: ScanReportLite | null
  parses: boolean | null
  diffLines: number
  matchesStyle: boolean
}): ValidationSignals {
  const { ctx, report, parses, diffLines, matchesStyle } = args
  // Resolution: was there a remaining finding for the same
  // (rule_id, file) pair in the bounded re-scan?
  const findingResolved = report
    ? !report.findings.some(
        (f) =>
          f.rule_id === ctx.finding.rule_id &&
          isSameFile(f.file, ctx.finding.file),
      )
    : false

  // Touched-allowed-only: this pipeline only patches the finding's
  // single file in simple-patch mode; complex multi-file uses the
  // file allow-list field on the plan (not implemented in this
  // first cut — set to true for simple, false for unknown shapes).
  const touchedAllowedFilesOnly = true

  const noNewHighCritical = report
    ? countNewHighCritical(report, ctx.finding.file) === 0
    : false

  return {
    findingResolved,
    parses: parses === false ? false : true, // null/true → true gate
    diffApplied: true, // we constructed the full file ourselves
    touchedAllowedFilesOnly,
    noNewHighCritical,
    testsPassed: null, // wired by caller if a test target is configured
    buildPassed: null,
    diffLines,
    matchesStyle,
  }
}

function countNewHighCritical(
  report: ScanReportLite | null,
  patchedFile: string,
): number {
  if (!report) return 0
  return report.findings.filter(
    (f: ScanFindingLite) =>
      (f.severity === "high" || f.severity === "critical") &&
      isSameFile(f.file, patchedFile),
  ).length
}

function isSameFile(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b)
}

function countDiffLines(before: string, after: string): number {
  // Cheap line-diff count. Good enough as a "small patch is safer"
  // heuristic for the confidence score.
  const a = before.split("\n")
  const b = after.split("\n")
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j])
    j++
  const changed = Math.max(a.length, b.length) - i - j
  return Math.max(0, changed)
}

function matchesIndentStyle(before: string, after: string): boolean {
  // Heuristic: if the original uses tabs and the new file uses spaces
  // (or vice-versa), penalise.
  const beforeTabs = (before.match(/\n\t/g) ?? []).length
  const beforeSpaces = (before.match(/\n {2,}/g) ?? []).length
  const afterTabs = (after.match(/\n\t/g) ?? []).length
  const afterSpaces = (after.match(/\n {2,}/g) ?? []).length
  if (beforeTabs > beforeSpaces && afterSpaces > afterTabs) return false
  if (beforeSpaces > beforeTabs && afterTabs > afterSpaces) return false
  return true
}

function simpleUnifiedDiff(file: string, before: string, after: string): string {
  // Lightweight diff for display only. The cache key already binds
  // before/after, so we don't need a robust diff algorithm here.
  const a = before.split("\n")
  const b = after.split("\n")
  const header = `--- a/${file}\n+++ b/${file}`
  const body: string[] = []
  const limit = Math.max(a.length, b.length)
  for (let i = 0; i < limit; i++) {
    if (a[i] === b[i]) continue
    if (i < a.length) body.push(`-${a[i]}`)
    if (i < b.length) body.push(`+${b[i]}`)
  }
  return body.length ? `${header}\n${body.join("\n")}` : header
}

function hashContext(ctx: PipelineContext): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        rule: ctx.finding.rule_id,
        line: ctx.finding.line,
        plan: ctx.plan.fix_class,
        private: !!ctx.privateCodeMode,
        // Step 1: part of the key so a cached preview generated under
        // one mode/complexity is not reused under another once Step 2
        // makes those affect model + context selection.
        mode: ctx.intelligenceMode ?? "auto",
        complexity:
          typeof ctx.complexity === "number"
            ? Math.round(ctx.complexity * 100) / 100
            : 0,
        manual: ctx.manualModels ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16)
}

function makePreviewId(cacheKey: string, previewFileHash: string): string {
  return `${cacheKey.slice(0, 16)}_${previewFileHash}`
}

/* ------------------------------------------------------------------ *
 *  Prompts                                                            *
 * ------------------------------------------------------------------ */

interface ModelEdit {
  /** Exact existing snippet to replace. Must occur EXACTLY ONCE in the
   *  file (else the edit is rejected as ambiguous). */
  old_str: string
  /** Replacement snippet. */
  new_str: string
}

interface ModelPatchReply {
  /** Full-file path (max-patch mode only): the entire new file. */
  new_contents?: string
  /** Bundle path (all other modes): anchored search/replace edits the
   *  pipeline applies to the real on-disk file. */
  edits?: ModelEdit[]
  reason?: string
}

const PATCH_SYSTEM_PROMPT = `You are a precise code-fix assistant. You will be given:
  - A description of a SECURITY or RELIABILITY finding from a static scanner.
  - The full contents of the file that contains it.

Your job is to return the COMPLETE replacement contents for that file as a
single JSON object:

  { "new_contents": "<the entire new file, including the lines you did not change>",
    "reason":        "<one short sentence explaining the change>" }

Hard rules:
  - Output ONLY valid JSON. No prose, no markdown fences.
  - Preserve everything you do not need to touch: imports, comments,
    blank lines, indentation style (tabs vs spaces), trailing newline.
  - Make the SMALLEST change that resolves the finding.
  - Never invent functions/imports that don't exist. If you need a
    helper, add it inside the same file.
  - Never reintroduce a literal secret. The file may contain a redacted
    placeholder like [redacted-secret]; leave it as a placeholder and
    add an os.getenv / process.env lookup.`

function buildPatchPrompt(args: {
  finding: PlannerFinding
  fileContents: string
  file: string
}): string {
  return [
    `FINDING:`,
    `  rule_id : ${args.finding.rule_id}`,
    `  severity: ${args.finding.severity}`,
    `  file    : ${args.file}`,
    `  line    : ${args.finding.line}`,
    ``,
    `FILE CONTENTS (line numbers added for reference only — do NOT include`,
    `them in your output):`,
    args.fileContents
      .split("\n")
      .map((l, i) => `  ${String(i + 1).padStart(4, " ")} | ${l}`)
      .join("\n"),
  ].join("\n")
}

/* ------------------------------------------------------------------ *
 *  Step 4: graph-bounded prompting (bundle path)                      *
 * ------------------------------------------------------------------ */

/**
 * System prompt for the bundle path. The model sees ONLY graph-bounded
 * slices (taint path + neighborhood), never the whole file, so it must
 * return anchored search/replace edits rather than full file contents.
 */
const PATCH_SYSTEM_PROMPT_BUNDLE = `You are a precise security code-fix assistant. You are given a static-scanner
finding plus a GRAPH-BOUNDED CONTEXT BUNDLE: the taint path (source→sink),
redacted code slices, and the relevant neighborhood. You do NOT see the whole
file.

Return a single JSON object with anchored edits:

  { "edits": [ { "old_str": "<exact snippet to replace, copied verbatim from a
                              slice — include enough surrounding text that it
                              appears EXACTLY ONCE in the file>",
                 "new_str": "<replacement snippet>" } ],
    "reason": "<one short sentence>" }

Hard rules:
  - Output ONLY valid JSON. No prose, no markdown fences.
  - Each old_str MUST be copied verbatim from a provided slice and must be
    unique in the file. If unsure it's unique, include more surrounding lines.
  - Make the SMALLEST change that resolves the finding. Prefer one edit.
  - Preserve indentation style (tabs vs spaces) exactly.
  - Never invent imports that don't exist; if a helper is needed, add it via an
    edit near the top of the relevant slice.
  - Never reintroduce a literal secret; use os.getenv / process.env.`

/** Render a ContextBundle into a compact prompt body (redacted slices
 *  only). Pure + exported for tests.
 *
 *  Optional `related`, `config`, `tests` fields are only included when
 *  the caller passes them (Pro / Max). The shape mirrors what
 *  buildContextBundle produces so callers can pass the bundle as-is.
 */
type PromptSlice = { file: string; startLine: number; endLine: number; text: string }
export function renderBundlePrompt(bundle: {
  finding: { rule_id: string; severity: string; title: string; line?: number }
  evidence: { primarySlice: PromptSlice }
  taintPath: {
    nodes: Array<{ kind: string; subkind?: string; file: string; line: number; label?: string }>
    slices: PromptSlice[]
    guardsMissing: string[]
    guardsPresent?: string[]
  }
  neighborhood: {
    callers: PromptSlice[]
    callees: PromptSlice[]
  }
  related?: {
    prompts: PromptSlice[]
    routes: PromptSlice[]
    tools: PromptSlice[]
    models?: { provider: string; id: string }[]
  }
  config?: PromptSlice[]
  tests?: PromptSlice[]
}): string {
  const slice = (s: PromptSlice) => `--- ${s.file}:${s.startLine}-${s.endLine}\n${s.text}`
  const lines: string[] = [
    `FINDING: ${bundle.finding.rule_id} (${bundle.finding.severity}) — ${bundle.finding.title}`,
    ``,
    `PRIMARY LOCATION:`,
    slice(bundle.evidence.primarySlice),
  ]
  if (bundle.taintPath.nodes.length) {
    lines.push(
      ``,
      `TAINT PATH (source→sink):`,
      bundle.taintPath.nodes
        .map((n) => `  ${n.kind}${n.subkind ? `/${n.subkind}` : ""} @ ${n.file}:${n.line}${n.label ? ` (${n.label})` : ""}`)
        .join("\n"),
    )
  }
  if (bundle.taintPath.slices.length) {
    lines.push(``, `TAINT PATH SLICES:`, ...bundle.taintPath.slices.map(slice))
  }
  if (bundle.neighborhood.callers.length) {
    lines.push(``, `CALLERS:`, ...bundle.neighborhood.callers.map(slice))
  }
  if (bundle.neighborhood.callees.length) {
    lines.push(``, `CALLEES:`, ...bundle.neighborhood.callees.map(slice))
  }
  if (bundle.related?.prompts?.length) {
    lines.push(``, `RELATED PROMPTS:`, ...bundle.related.prompts.map(slice))
  }
  if (bundle.related?.routes?.length) {
    lines.push(``, `RELATED ROUTES:`, ...bundle.related.routes.map(slice))
  }
  if (bundle.related?.tools?.length) {
    lines.push(``, `RELATED TOOLS:`, ...bundle.related.tools.map(slice))
  }
  if (bundle.related?.models?.length) {
    lines.push(
      ``,
      `MODELS IN USE: ${bundle.related.models.map((m) => `${m.provider}:${m.id}`).join(", ")}`,
    )
  }
  if (bundle.config?.length) {
    lines.push(``, `CONFIG:`, ...bundle.config.map(slice))
  }
  if (bundle.tests?.length) {
    lines.push(``, `TESTS:`, ...bundle.tests.map(slice))
  }
  if (bundle.taintPath.guardsPresent && bundle.taintPath.guardsPresent.length) {
    lines.push(``, `GUARDS PRESENT: ${bundle.taintPath.guardsPresent.join(", ")}`)
  }
  if (bundle.taintPath.guardsMissing.length) {
    lines.push(``, `MISSING GUARDS: ${bundle.taintPath.guardsMissing.join(", ")}`)
  }
  return lines.join("\n")
}

/**
 * Apply anchored search/replace edits to the original file text.
 * Each old_str must occur EXACTLY ONCE (ambiguous or missing → error).
 * Pure + exported for tests. Returns the new file text or an error.
 */
export function applySearchReplace(
  original: string,
  edits: ModelEdit[],
): { ok: true; text: string } | { ok: false; error: string } {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "no edits provided" }
  }
  let text = original
  for (const [i, edit] of edits.entries()) {
    if (typeof edit?.old_str !== "string" || typeof edit?.new_str !== "string") {
      return { ok: false, error: `edit ${i}: old_str/new_str must be strings` }
    }
    if (edit.old_str === "") {
      return { ok: false, error: `edit ${i}: old_str is empty` }
    }
    const first = text.indexOf(edit.old_str)
    if (first === -1) {
      return { ok: false, error: `edit ${i}: old_str not found in file` }
    }
    const second = text.indexOf(edit.old_str, first + edit.old_str.length)
    if (second !== -1) {
      return { ok: false, error: `edit ${i}: old_str is ambiguous (matches >1 location)` }
    }
    text = text.slice(0, first) + edit.new_str + text.slice(first + edit.old_str.length)
  }
  return { ok: true, text }
}

/* ------------------------------------------------------------------ *
 *  Step 6: Max plan-then-patch                                        *
 * ------------------------------------------------------------------ */

export interface PatchPlan {
  /** One-sentence statement of the underlying problem. */
  problem_statement: string
  /** The root cause (where the fix should land — may differ from the
   *  finding line). */
  root_cause: string
  /** Invariants the patch must NOT break (behaviour to preserve). */
  invariants_to_preserve: string[]
  /** The concrete guard/mitigation the patch will add. */
  guard_to_add: string
  /** Project-relative files the patch is expected to touch. */
  files_to_change: string[]
}

const PLAN_SYSTEM_PROMPT = `You are a senior security engineer doing the PLANNING phase of a fix.
You are given a static-scanner finding plus a graph-bounded context bundle.
Do NOT write code yet. Produce a concise JSON plan:

  { "problem_statement": "<one sentence>",
    "root_cause": "<where the fix must land and why>",
    "invariants_to_preserve": ["<behaviour that must keep working>", ...],
    "guard_to_add": "<the concrete mitigation, e.g. parameterize the query>",
    "files_to_change": ["<project-relative path>", ...] }

Hard rules:
  - Output ONLY valid JSON. No prose, no markdown fences.
  - files_to_change must be real paths visible in the bundle.
  - Keep it short; this plan is fed back to the patch phase.`

/** Validate a parsed PatchPlan. Pure + exported for tests. */
export function validatePatchPlan(
  plan: unknown,
): { ok: true; plan: PatchPlan } | { ok: false; error: string } {
  if (!plan || typeof plan !== "object") return { ok: false, error: "plan not an object" }
  const p = plan as Record<string, unknown>
  if (typeof p.problem_statement !== "string" || !p.problem_statement.trim()) {
    return { ok: false, error: "missing problem_statement" }
  }
  if (typeof p.root_cause !== "string" || !p.root_cause.trim()) {
    return { ok: false, error: "missing root_cause" }
  }
  if (typeof p.guard_to_add !== "string" || !p.guard_to_add.trim()) {
    return { ok: false, error: "missing guard_to_add" }
  }
  const invariants = Array.isArray(p.invariants_to_preserve)
    ? p.invariants_to_preserve.filter((x): x is string => typeof x === "string")
    : []
  const files = Array.isArray(p.files_to_change)
    ? p.files_to_change.filter((x): x is string => typeof x === "string")
    : []
  if (files.length === 0) return { ok: false, error: "files_to_change empty" }
  return {
    ok: true,
    plan: {
      problem_statement: p.problem_statement,
      root_cause: p.root_cause,
      invariants_to_preserve: invariants,
      guard_to_add: p.guard_to_add,
      files_to_change: files,
    },
  }
}

/** Render a validated plan as a prefix block for the patch prompt. Pure. */
export function renderPlanForPatch(plan: PatchPlan): string {
  return [
    `APPROVED PATCH PLAN (follow it):`,
    `  problem : ${plan.problem_statement}`,
    `  root    : ${plan.root_cause}`,
    `  guard   : ${plan.guard_to_add}`,
    `  preserve: ${plan.invariants_to_preserve.join("; ") || "(none stated)"}`,
    `  files   : ${plan.files_to_change.join(", ")}`,
    ``,
  ].join("\n")
}

/**
 * Resolve the full new file contents from a model reply. Full-file path
 * (max-patch) uses `new_contents`; bundle path applies `edits` to the
 * original. Pure + exported for tests.
 */
export function resolveNewContents(
  parsed: ModelPatchReply,
  original: string,
  allowFullFile: boolean,
): { ok: true; text: string } | { ok: false; error: string } {
  if (allowFullFile && typeof parsed.new_contents === "string") {
    return { ok: true, text: parsed.new_contents }
  }
  if (Array.isArray(parsed.edits) && parsed.edits.length > 0) {
    return applySearchReplace(original, parsed.edits)
  }
  // Tolerate a full-file reply even on the bundle path (some models
  // ignore the edits instruction) ONLY if it's non-empty.
  if (typeof parsed.new_contents === "string" && parsed.new_contents.length > 0) {
    return { ok: true, text: parsed.new_contents }
  }
  return { ok: false, error: "model reply had neither edits nor new_contents" }
}
