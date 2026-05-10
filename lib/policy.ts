/**
 * Edge Agent AI policy engine.
 *
 * The policy file lives at `<projectPath>/.edgeagent/policy.yaml` and tells
 * Edge Agent how to gate commits, pushes, and (later) PRs based on:
 *   - the security posture of the latest scan
 *   - per-agent quality metrics (accuracy, runtime, tool-selection pass rate)
 *
 * This module is intentionally pure — no filesystem or network — so it can
 * be reused by:
 *   - the API route at /api/policy/evaluate (server side)
 *   - the in-IDE Commit / Push dialogs (client side, after we already
 *     received a parsed Policy from the server)
 *   - future eval / CI runners
 *
 * The YAML is parsed leniently: unknown keys are ignored, missing
 * sub-objects are backfilled from `DEFAULT_POLICY`, and parse problems
 * never throw — they're surfaced as a list of warnings the UI can show
 * so users can fix the file at their own pace.
 */

import YAML from "yaml"
import { z } from "zod"
import type { ScanReport } from "@/lib/scan-report"

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type PolicyMode = "warn" | "block" | "auto_merge"

export interface AgentAccuracyRule {
  /** Fail if the target accuracy is below this absolute floor (0..1). */
  min_absolute?: number
  /**
   * Fail if `targetAccuracy - baseAccuracy` is less than this. Use 0 to
   * mean "never let accuracy drop". Requires `baseMetrics` to evaluate.
   */
  require_delta_gte?: number
}

export interface AgentRuntimeRule {
  /** Fail if average runtime per case (ms) exceeds this absolute ceiling. */
  max_absolute?: number
  /**
   * Fail if `targetRuntime - baseRuntime` is greater than this. Use 0 to
   * mean "never let runtime regress". Requires `baseMetrics` to evaluate.
   */
  require_delta_lte?: number
}

export interface AgentToolSelectionRule {
  /** Fail if tool-selection pass rate (0..1) is below this floor. */
  min_pass_rate?: number
}

export interface AgentPolicy {
  accuracy?: AgentAccuracyRule
  runtime_ms?: AgentRuntimeRule
  tool_selection?: AgentToolSelectionRule
}

export interface SecurityPolicy {
  block_if_critical?: boolean
  block_if_high_increased?: boolean
  require_risk_score_not_increase?: boolean
  /** Optional absolute ceiling on the headline 0..100 risk score. */
  max_risk_score?: number
}

export interface AutoMergePolicy {
  enabled?: boolean
  trusted_branches_only?: boolean
  require_clean_worktree?: boolean
  /**
   * Belt-and-braces guard: even in `mode: auto_merge`, never let the
   * auto-merge button fire when the *current* branch is the base
   * branch (you'd be auto-merging the base into itself, which is a
   * no-op at best and a footgun at worst).
   */
  require_branch_not_main?: boolean
  /**
   * Independent of the broader policy decision — auto-merge will
   * additionally require `decision === "pass"` (i.e. no warns) when
   * this is true. Defaults to true so users opting into auto-merge
   * don't accidentally inherit warn-as-pass semantics.
   */
  require_policy_pass?: boolean
}

/**
 * Pull-request gating rules. These translate the policy decision
 * (pass / warn / block) into a concrete UI behaviour for the
 * "Create PR" flow.
 *
 * The flow is intentionally conservative:
 *   block → never push, never create PR
 *   warn  → create_draft_if_warn=true allows a *draft* PR
 *           (the dialog will explicitly confirm the user wants this)
 *   pass  → create the PR
 */
export interface PullRequestPolicy {
  /** Master switch — when false, "Create PR" never auto-creates. */
  create_if_policy_passes?: boolean
  /** Allow opening a draft PR when the gate returned `warn`. */
  create_draft_if_warn?: boolean
  /** When true, a `block` decision prevents PR creation entirely. */
  block_if_policy_blocks?: boolean
  /** Default base branch suggested in the Create PR dialog. */
  base_branch?: string
}

export interface Policy {
  mode: PolicyMode
  security: SecurityPolicy
  agents: Record<string, AgentPolicy>
  auto_merge: AutoMergePolicy
  pull_request: PullRequestPolicy
}

/** Per-agent metrics handed in by the (future) eval runner. */
export interface AgentMetrics {
  accuracy?: number
  runtime_ms?: number
  tool_selection_pass_rate?: number
}

export type EvalMetrics = Record<string, AgentMetrics>

export type Decision = "pass" | "warn" | "block" | "auto_merge_allowed"

export interface PolicyEvalContext {
  branch?: string
  /** Branch globs that auto-merge is allowed on (e.g. ["main", "release/*"]). */
  trustedBranches?: string[]
  workingTreeStatus?: "clean" | "uncommitted" | null
}

export interface EvaluatePolicyInput {
  baseReport?: ScanReport | null
  targetReport: ScanReport
  baseMetrics?: EvalMetrics | null
  targetMetrics?: EvalMetrics | null
  policy: Policy
  context?: PolicyEvalContext
}

export interface PolicyEvaluation {
  decision: Decision
  /** Human-readable reasons, ordered by severity (blockers first). */
  reasons: string[]
  /**
   * Stable machine ids, e.g. `security.block_if_critical` or
   * `agents.SalesAgent.accuracy.min_absolute`. Useful for UIs that want
   * to render per-rule indicators.
   */
  failedConditions: string[]
  passedConditions: string[]
  /**
   * Conditions that didn't apply — e.g. delta rules without a base scan,
   * or per-agent metric rules with no metrics provided. These are NOT
   * failures; we just record them so the UI can explain "why nothing
   * happened" without users guessing.
   */
  inapplicableConditions: string[]
  deltas: {
    risk: number | null
    critical: number | null
    high: number | null
    medium: number | null
    low: number | null
    perAgent: Record<string, AgentMetricsDelta>
  }
  /**
   * Echo of the resolved mode — useful for badges in the UI without
   * having to keep the policy object around.
   */
  mode: PolicyMode
}

export interface AgentMetricsDelta {
  accuracy: number | null
  runtime_ms: number | null
  tool_selection_pass_rate: number | null
}

/* -------------------------------------------------------------------------- */
/* Default policy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Defaults used when the project has no `.edgeagent/policy.yaml`.
 *
 * Design intent: **enforce by default**. The previous defaults were
 * `mode: "warn"` with both delta rules off, which meant the gate could
 * only fire on absolute critical findings — a real regression like
 * "+13 risk, +3 high" produced `decision: "pass"` and let the commit /
 * push / PR through silently. Anyone without a policy file wasn't
 * actually being gated.
 *
 * The new defaults block on:
 *   - any critical finding (absolute)
 *   - a high-severity count that grew vs the last accepted scan (delta)
 *   - a headline risk score that grew vs the last accepted scan (delta)
 *
 * Delta rules need a baseline; `lib/server-policy.ts:readLastScan`
 * supplies one whenever the project has had at least one previously
 * gated commit/push/PR. First-ever commits naturally have nothing to
 * regress from, so only the absolute critical rule applies — same UX
 * as the old defaults for first-run users, but real enforcement
 * thereafter.
 *
 * Teams that explicitly want observation-only mode can drop
 * `mode: warn` into their `.edgeagent/policy.yaml`; the existing
 * lenient parser merges over these defaults.
 */
export const DEFAULT_POLICY: Policy = {
  mode: "block",
  security: {
    block_if_critical: true,
    block_if_high_increased: true,
    require_risk_score_not_increase: true,
  },
  agents: {},
  auto_merge: {
    enabled: false,
    trusted_branches_only: true,
    require_clean_worktree: true,
    require_branch_not_main: true,
    require_policy_pass: true,
  },
  pull_request: {
    create_if_policy_passes: true,
    create_draft_if_warn: true,
    block_if_policy_blocks: true,
    base_branch: "main",
  },
}

/* -------------------------------------------------------------------------- */
/* YAML parser (lenient, never throws)                                        */
/* -------------------------------------------------------------------------- */

const ModeSchema = z.enum(["warn", "block", "auto_merge"])

const SecuritySchema = z
  .object({
    block_if_critical: z.boolean().optional(),
    block_if_high_increased: z.boolean().optional(),
    require_risk_score_not_increase: z.boolean().optional(),
    max_risk_score: z.number().optional(),
  })
  .partial()
  .passthrough()

const AccuracySchema = z
  .object({
    min_absolute: z.number().optional(),
    require_delta_gte: z.number().optional(),
  })
  .passthrough()

const RuntimeSchema = z
  .object({
    max_absolute: z.number().optional(),
    require_delta_lte: z.number().optional(),
  })
  .passthrough()

const ToolSelectionSchema = z
  .object({
    min_pass_rate: z.number().optional(),
  })
  .passthrough()

const AgentPolicySchema = z
  .object({
    accuracy: AccuracySchema.optional(),
    runtime_ms: RuntimeSchema.optional(),
    tool_selection: ToolSelectionSchema.optional(),
  })
  .passthrough()

const AutoMergeSchema = z
  .object({
    enabled: z.boolean().optional(),
    trusted_branches_only: z.boolean().optional(),
    require_clean_worktree: z.boolean().optional(),
    require_branch_not_main: z.boolean().optional(),
    require_policy_pass: z.boolean().optional(),
  })
  .passthrough()

const PullRequestSchema = z
  .object({
    create_if_policy_passes: z.boolean().optional(),
    create_draft_if_warn: z.boolean().optional(),
    block_if_policy_blocks: z.boolean().optional(),
    base_branch: z.string().optional(),
  })
  .passthrough()

const PolicySchema = z
  .object({
    mode: ModeSchema.optional(),
    security: SecuritySchema.optional(),
    agents: z.record(z.string(), AgentPolicySchema).optional(),
    auto_merge: AutoMergeSchema.optional(),
    pull_request: PullRequestSchema.optional(),
  })
  .passthrough()

export interface ParsePolicyResult {
  policy: Policy
  errors: string[]
  /** True if the YAML at least produced an object we could merge. */
  parsed: boolean
}

export function parsePolicyYaml(yamlText: string): ParsePolicyResult {
  const errors: string[] = []
  let raw: unknown
  try {
    raw = YAML.parse(yamlText)
  } catch (e) {
    errors.push(
      `policy.yaml is not valid YAML: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
    return { policy: DEFAULT_POLICY, errors, parsed: false }
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("policy.yaml must be a mapping at the top level")
    return { policy: DEFAULT_POLICY, errors, parsed: false }
  }
  const validation = PolicySchema.safeParse(raw)
  if (!validation.success) {
    for (const issue of validation.error.issues) {
      errors.push(
        `policy.yaml: ${issue.path.join(".") || "<root>"} — ${issue.message}`
      )
    }
    return { policy: DEFAULT_POLICY, errors, parsed: true }
  }
  const v = validation.data
  const policy: Policy = {
    mode: v.mode ?? DEFAULT_POLICY.mode,
    security: {
      ...DEFAULT_POLICY.security,
      ...(v.security ?? {}),
    },
    agents: { ...(v.agents ?? {}) },
    auto_merge: {
      ...DEFAULT_POLICY.auto_merge,
      ...(v.auto_merge ?? {}),
    },
    pull_request: {
      ...DEFAULT_POLICY.pull_request,
      ...(v.pull_request ?? {}),
    },
  }
  return { policy, errors, parsed: true }
}

/* -------------------------------------------------------------------------- */
/* Evaluator                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Order: pass < warn < block < auto_merge_allowed.
 * `auto_merge_allowed` is only ever set if everything else passed AND
 * the auto-merge gates were satisfied — it's effectively "pass +".
 */
type Severity = "pass" | "warn" | "block"

function escalate(current: Severity, next: Severity): Severity {
  const rank: Record<Severity, number> = { pass: 0, warn: 1, block: 2 }
  return rank[next] > rank[current] ? next : current
}

/**
 * Translate a "this rule failed" event into a severity, respecting the
 * policy mode. `mode: "warn"` demotes any block to a warn so teams can
 * roll out a policy in observation mode before enforcing.
 */
function severityFor(mode: PolicyMode, ruleEnabled: boolean): Severity {
  if (!ruleEnabled) return "warn"
  if (mode === "warn") return "warn"
  return "block"
}

function isBranchTrusted(
  branch: string | undefined,
  patterns: string[] | undefined
): boolean {
  if (!branch) return false
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pat) => matchGlob(branch, pat))
}

/** Tiny `*` glob matcher, scoped to branch names. No `?`, no `**`. */
function matchGlob(value: string, pattern: string): boolean {
  if (pattern === value) return true
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$"
  )
  return re.test(value)
}

const METRICS_MISSING_SENTENCE =
  "Accuracy/runtime metrics are unavailable because eval runner has not been run."

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyEvaluation {
  const { baseReport, targetReport, baseMetrics, targetMetrics, policy, context } =
    input
  const reasons: string[] = []
  const failedConditions: string[] = []
  const passedConditions: string[] = []
  const inapplicableConditions: string[] = []
  let severity: Severity = "pass"

  /* ---------------- Security ---------------- */

  const sec = policy.security
  const tSum = targetReport.summary
  const bSum = baseReport?.summary ?? null

  // block_if_critical
  if (sec.block_if_critical) {
    if (tSum.critical > 0) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.block_if_critical")
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: target scan has ${
          tSum.critical
        } critical finding${tSum.critical === 1 ? "" : "s"}.`
      )
    } else {
      passedConditions.push("security.block_if_critical")
    }
  }

  // block_if_high_increased (delta — needs base)
  if (sec.block_if_high_increased) {
    if (!bSum) {
      inapplicableConditions.push("security.block_if_high_increased")
    } else if (tSum.high > bSum.high) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.block_if_high_increased")
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: high findings increased ${
          bSum.high
        } → ${tSum.high} (+${tSum.high - bSum.high}).`
      )
    } else {
      passedConditions.push("security.block_if_high_increased")
    }
  }

  // require_risk_score_not_increase (delta — needs base)
  if (sec.require_risk_score_not_increase) {
    if (!baseReport) {
      inapplicableConditions.push("security.require_risk_score_not_increase")
    } else if (targetReport.risk_score > baseReport.risk_score) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.require_risk_score_not_increase")
      reasons.push(
        `${
          sev === "block" ? "Blocked" : "Warning"
        }: risk score increased ${baseReport.risk_score} → ${
          targetReport.risk_score
        } (+${targetReport.risk_score - baseReport.risk_score}).`
      )
    } else {
      passedConditions.push("security.require_risk_score_not_increase")
    }
  }

  // max_risk_score (absolute, single-side)
  if (typeof sec.max_risk_score === "number") {
    if (targetReport.risk_score > sec.max_risk_score) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.max_risk_score")
      reasons.push(
        `${
          sev === "block" ? "Blocked" : "Warning"
        }: risk score ${targetReport.risk_score} exceeds policy ceiling ${
          sec.max_risk_score
        }.`
      )
    } else {
      passedConditions.push("security.max_risk_score")
    }
  }

  /* ---------------- Per-agent metrics ---------------- */

  const perAgentDeltas: Record<string, AgentMetricsDelta> = {}
  let metricsMissingMentioned = false

  const noteMetricsMissing = (cond: string) => {
    inapplicableConditions.push(cond)
    if (!metricsMissingMentioned) {
      metricsMissingMentioned = true
      severity = escalate(severity, "warn")
      reasons.push(METRICS_MISSING_SENTENCE)
    }
  }

  for (const [agent, rules] of Object.entries(policy.agents ?? {})) {
    const tm = targetMetrics?.[agent] ?? null
    const bm = baseMetrics?.[agent] ?? null
    const delta: AgentMetricsDelta = {
      accuracy:
        tm?.accuracy != null && bm?.accuracy != null
          ? round(tm.accuracy - bm.accuracy, 4)
          : null,
      runtime_ms:
        tm?.runtime_ms != null && bm?.runtime_ms != null
          ? Math.round(tm.runtime_ms - bm.runtime_ms)
          : null,
      tool_selection_pass_rate:
        tm?.tool_selection_pass_rate != null &&
        bm?.tool_selection_pass_rate != null
          ? round(tm.tool_selection_pass_rate - bm.tool_selection_pass_rate, 4)
          : null,
    }
    perAgentDeltas[agent] = delta

    /* accuracy.min_absolute */
    if (rules.accuracy?.min_absolute != null) {
      const cond = `agents.${agent}.accuracy.min_absolute`
      if (tm?.accuracy == null) {
        noteMetricsMissing(cond)
      } else if (tm.accuracy < rules.accuracy.min_absolute) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push(cond)
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: ${agent} accuracy ${pct(
            tm.accuracy
          )} below floor ${pct(rules.accuracy.min_absolute)}.`
        )
      } else {
        passedConditions.push(cond)
      }
    }

    /* accuracy.require_delta_gte */
    if (rules.accuracy?.require_delta_gte != null) {
      const cond = `agents.${agent}.accuracy.require_delta_gte`
      if (tm?.accuracy == null || bm?.accuracy == null) {
        noteMetricsMissing(cond)
      } else {
        const d = tm.accuracy - bm.accuracy
        if (d < rules.accuracy.require_delta_gte) {
          const sev = severityFor(policy.mode, true)
          severity = escalate(severity, sev)
          failedConditions.push(cond)
          reasons.push(
            `${
              sev === "block" ? "Blocked" : "Warning"
            }: ${agent} accuracy delta ${signed(round(d * 100, 2))}pp below required ${signed(
              round(rules.accuracy.require_delta_gte * 100, 2)
            )}pp.`
          )
        } else {
          passedConditions.push(cond)
        }
      }
    }

    /* runtime_ms.max_absolute */
    if (rules.runtime_ms?.max_absolute != null) {
      const cond = `agents.${agent}.runtime_ms.max_absolute`
      if (tm?.runtime_ms == null) {
        noteMetricsMissing(cond)
      } else if (tm.runtime_ms > rules.runtime_ms.max_absolute) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push(cond)
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: ${agent} runtime ${
            tm.runtime_ms
          }ms above ceiling ${rules.runtime_ms.max_absolute}ms.`
        )
      } else {
        passedConditions.push(cond)
      }
    }

    /* runtime_ms.require_delta_lte */
    if (rules.runtime_ms?.require_delta_lte != null) {
      const cond = `agents.${agent}.runtime_ms.require_delta_lte`
      if (tm?.runtime_ms == null || bm?.runtime_ms == null) {
        noteMetricsMissing(cond)
      } else {
        const d = tm.runtime_ms - bm.runtime_ms
        if (d > rules.runtime_ms.require_delta_lte) {
          const sev = severityFor(policy.mode, true)
          severity = escalate(severity, sev)
          failedConditions.push(cond)
          reasons.push(
            `${sev === "block" ? "Blocked" : "Warning"}: ${agent} runtime delta ${signed(
              Math.round(d)
            )}ms above allowed ${signed(rules.runtime_ms.require_delta_lte)}ms.`
          )
        } else {
          passedConditions.push(cond)
        }
      }
    }

    /* tool_selection.min_pass_rate */
    if (rules.tool_selection?.min_pass_rate != null) {
      const cond = `agents.${agent}.tool_selection.min_pass_rate`
      if (tm?.tool_selection_pass_rate == null) {
        noteMetricsMissing(cond)
      } else if (
        tm.tool_selection_pass_rate < rules.tool_selection.min_pass_rate
      ) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push(cond)
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: ${agent} tool-selection pass rate ${pct(
            tm.tool_selection_pass_rate
          )} below floor ${pct(rules.tool_selection.min_pass_rate)}.`
        )
      } else {
        passedConditions.push(cond)
      }
    }
  }

  /* ---------------- Auto-merge gating ----------------
   *
   * Auto-merge only escalates a `pass` to `auto_merge_allowed`. The
   * earlier severity logic already ensures that, e.g., a critical
   * finding in mode:auto_merge will return `block`, never
   * `auto_merge_allowed`. We additionally honour:
   *   - require_clean_worktree    — caller must supply workingTreeStatus
   *   - trusted_branches_only     — caller supplies a glob list
   *   - require_branch_not_main   — guard against merging into yourself
   *   - require_policy_pass       — already true here (we gate on `pass`),
   *                                 but kept for symmetry / future use
   *
   * "Couldn't tell" cases (no branch passed in, no working tree status)
   * are treated as gate failures so we never accidentally auto-merge
   * without the data we need to check.
   */

  let decision: Decision = severity
  if (
    severity === "pass" &&
    policy.mode === "auto_merge" &&
    policy.auto_merge?.enabled
  ) {
    const gates: string[] = []
    if (policy.auto_merge.require_clean_worktree) {
      if (!context || context.workingTreeStatus !== "clean") {
        gates.push("working tree is not clean")
      }
    }
    if (policy.auto_merge.trusted_branches_only) {
      if (!isBranchTrusted(context?.branch, context?.trustedBranches)) {
        gates.push(
          context?.branch
            ? `branch '${context.branch}' is not in the trusted list`
            : "no branch supplied"
        )
      }
    }
    if (policy.auto_merge.require_branch_not_main !== false) {
      const b = (context?.branch ?? "").toLowerCase()
      if (b === "main" || b === "master") {
        gates.push(`branch '${context?.branch}' is the base/default branch`)
      }
    }
    if (gates.length === 0) {
      decision = "auto_merge_allowed"
      passedConditions.push("auto_merge.eligible")
      reasons.unshift(
        "Auto-merge eligible: all security and metric checks passed and auto-merge gates are satisfied."
      )
    } else {
      // Stay at pass; don't fail — just explain why auto-merge didn't fire.
      passedConditions.push("auto_merge.requested")
      reasons.push(
        `Auto-merge requested but disabled because ${gates.join(" and ")}.`
      )
    }
  }

  return {
    decision,
    reasons,
    failedConditions,
    passedConditions,
    inapplicableConditions,
    deltas: {
      risk: baseReport ? targetReport.risk_score - baseReport.risk_score : null,
      critical: bSum ? tSum.critical - bSum.critical : null,
      high: bSum ? tSum.high - bSum.high : null,
      medium: bSum ? tSum.medium - bSum.medium : null,
      low: bSum ? tSum.low - bSum.low : null,
      perAgent: perAgentDeltas,
    },
    mode: policy.mode,
  }
}

/* -------------------------------------------------------------------------- */
/* Tiny formatting helpers                                                    */
/* -------------------------------------------------------------------------- */

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function round(n: number, digits: number): number {
  const m = Math.pow(10, digits)
  return Math.round(n * m) / m
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/* -------------------------------------------------------------------------- */
/* UI helpers (re-exported for the policy status card)                        */
/* -------------------------------------------------------------------------- */

export function decisionLabel(d: Decision): string {
  switch (d) {
    case "pass":
      return "Policy: pass"
    case "warn":
      return "Policy: warn"
    case "block":
      return "Policy: block"
    case "auto_merge_allowed":
      return "Auto-merge eligible"
  }
}

export function decisionBadgeClass(d: Decision): string {
  switch (d) {
    case "pass":
      return "border-green-500/40 text-green-400 bg-green-500/10"
    case "warn":
      return "border-yellow-500/40 text-yellow-400 bg-yellow-500/10"
    case "block":
      return "border-red-500/40 text-red-400 bg-red-500/10"
    case "auto_merge_allowed":
      return "border-blue-500/40 text-blue-400 bg-blue-500/10"
  }
}

/* -------------------------------------------------------------------------- */
/* PR gate decision                                                           */
/* -------------------------------------------------------------------------- */

export type PrAction =
  /** Block hard. Don't push, don't create PR. */
  | { kind: "block"; reason: string }
  /**
   * Warn but allow PR creation as draft only. Caller (UI) must confirm
   * with the user. The dialog turns this into a `--draft` flag.
   */
  | { kind: "draft"; reason: string }
  /** Create the PR normally. */
  | { kind: "create"; reason: string }
  /** Create the PR and additionally enable GitHub auto-merge. */
  | { kind: "auto_merge"; reason: string }

/**
 * Translate a policy decision into a concrete PR action, honouring
 * `policy.pull_request.*` and `policy.auto_merge.*`. Pure — no I/O.
 *
 * `userWantsAutoMerge` is the dialog's auto-merge toggle; we only honour
 * it when the policy itself permits auto-merge (mode + enabled +
 * decision === "auto_merge_allowed"), so a user can't tick the box to
 * bypass the gate.
 */
export function resolvePrAction(
  policy: Policy,
  decision: Decision,
  opts: { userWantsAutoMerge?: boolean } = {}
): PrAction {
  const pr = policy.pull_request ?? {}
  const blockOnBlock = pr.block_if_policy_blocks !== false
  const allowDraftOnWarn = pr.create_draft_if_warn !== false
  const allowOnPass = pr.create_if_policy_passes !== false

  if (decision === "block" && blockOnBlock) {
    return {
      kind: "block",
      reason: "Policy decision is `block`; pull request will not be created.",
    }
  }
  if (decision === "warn") {
    if (allowDraftOnWarn) {
      return {
        kind: "draft",
        reason:
          "Policy decision is `warn`; draft PR allowed (user confirmation required).",
      }
    }
    return {
      kind: "block",
      reason:
        "Policy decision is `warn` and `create_draft_if_warn` is disabled.",
    }
  }
  if (decision === "auto_merge_allowed") {
    if (
      opts.userWantsAutoMerge &&
      policy.auto_merge?.enabled &&
      policy.mode === "auto_merge"
    ) {
      return {
        kind: "auto_merge",
        reason:
          "Policy decision is `auto_merge_allowed` and the user opted into auto-merge.",
      }
    }
    return {
      kind: "create",
      reason: allowOnPass
        ? "Policy decision is `auto_merge_allowed`; opening PR without auto-merge."
        : "Policy decision is `auto_merge_allowed` (PR creation always allowed when policy passes).",
    }
  }
  // pass
  if (!allowOnPass) {
    return {
      kind: "block",
      reason:
        "Policy decision is `pass` but `create_if_policy_passes` is disabled.",
    }
  }
  return {
    kind: "create",
    reason: "Policy decision is `pass`; PR will be created.",
  }
}
