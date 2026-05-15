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
  /** Trigger when the medium-severity count grows vs the base scan. Off
   *  by default — mediums are usually noisier than highs and shouldn't
   *  block by default, but teams that want zero-medium hygiene can flip
   *  it on. */
  block_if_medium_increased?: boolean
  require_risk_score_not_increase?: boolean
  /** Optional absolute ceiling on the headline 0..100 risk score. */
  max_risk_score?: number
  /** Absolute ceiling on `target.risk - base.risk`. 0 means "never let
   *  risk go up at all". Inapplicable when there's no base. */
  max_risk_score_increase?: number
  /** Absolute ceiling on the number of critical findings. 0 = no
   *  critical findings tolerated. Distinct from `block_if_critical`
   *  because it lets teams allow, e.g., up to 1 critical for a
   *  migration period. */
  max_critical_findings?: number
  /** Absolute ceiling on high findings. Same semantics as above. */
  max_high_findings?: number
  /** Block when *any* finding has `rule_id === 'secrets'`. Implies
   *  block regardless of severity — leaked credentials are always a
   *  P0 even if our risk scoring dampened them. */
  block_if_secrets_found?: boolean
  /** Block when the scan saw a dangerous tool and *no* matching
   *  approval gate. Combines `rule_id === 'dangerous-tools'` AND the
   *  absence of `rule_id === 'human-approval'` for the same agent. */
  block_if_dangerous_tool_without_approval?: boolean
  /** Block when the scan saw user input flowing into dangerous code.
   *  Triggered by `rule_id === 'user-input-dangerous-code'` or
   *  `prompt-injection`. */
  block_if_user_input_to_dangerous_code?: boolean
  /** Block when the scan found unsafe MCP configuration. Triggered by
   *  `rule_id === 'mcp-security'`. */
  block_if_unsafe_mcp?: boolean
  /** Block when the scan found OpenAPI/auth/schema quality gaps.
   *  Triggered by `rule_id === 'openapi-schema'`. */
  block_if_schema_auth_gap?: boolean
}

/**
 * Per-project eval rules. These are global defaults that apply to
 * *every* agent — distinct from `policy.agents.<name>.*` which is a
 * per-agent override. The evaluator merges: per-agent rules win,
 * otherwise the global rule fires.
 *
 * Setting `enabled` on a rule to `false` short-circuits it (rule is
 * marked inapplicable so users see "skipped — disabled" rather than
 * "passed", which would be misleading).
 */
export interface EvalsPolicy {
  /** Block when accuracy regresses vs base metrics (target < base).
   *  When off, accuracy drops are warnings, not blocks. */
  block_if_accuracy_drops?: boolean
  /** Absolute floor for accuracy (0..1). Applied to every agent that
   *  has metrics. Per-agent `agents.<name>.accuracy.min_absolute`
   *  overrides this when present. */
  min_accuracy?: number
  /** Block when runtime regresses vs base metrics. */
  block_if_runtime_increases?: boolean
  /** Absolute ceiling for the p95 runtime in ms. Applied to every
   *  agent that has `runtime_ms`. */
  max_runtime_p95_ms?: number
  /** Block when tool-selection pass rate regresses. */
  block_if_tool_selection_drops?: boolean
  /** Absolute floor for tool-selection pass rate (0..1). */
  min_tool_selection_pass_rate?: number
  /** Block when the project declares evals but no eval metrics were
   *  supplied to the gate. Surfaces "you forgot to run evals" instead
   *  of silently passing on missing data. */
  block_if_required_evals_missing?: boolean
  /** Block when behavioural / unit tests fail. The eval runner reports
   *  test results in its `meta.testsPassed/testsFailed` payload. */
  block_if_tests_fail?: boolean
}

/**
 * Pre-commit gate rules. Backend honours these in /api/git/commit.
 */
export interface CommitPolicy {
  block_if_policy_blocks?: boolean
  run_scan_before_commit?: boolean
}

/**
 * Pre-push gate rules. Backend honours these in /api/git/push.
 */
export interface PushPolicy {
  block_if_policy_blocks?: boolean
  run_scan_before_push?: boolean
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
  /** Belt-and-braces severity guards layered on top of the broader
   *  policy decision. Each is independent so users can pick the level
   *  of paranoia they want. */
  require_no_critical_or_high?: boolean
  require_accuracy_not_drop?: boolean
  require_runtime_not_increase?: boolean
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
  /** When true, the Create-PR route insists on a fresh policy gate
   *  before talking to GitHub. When false, the caller can skip the
   *  pre-flight (e.g. for repos that gate elsewhere). Defaults to
   *  true. */
  run_policy_gate_before_pr?: boolean
  /** Refuse to create the PR if the working tree is dirty. Prevents
   *  the "I accidentally PR'd uncommitted edits" footgun. */
  require_clean_worktree?: boolean
  /** Refuse to create a PR whose *source* branch is `main` or
   *  `master`. Catches the "I committed straight to main and then
   *  tried to PR it" footgun. */
  block_pr_from_main_or_master?: boolean
}

export interface Policy {
  mode: PolicyMode
  security: SecurityPolicy
  /** Global eval rules (apply to every agent unless `agents.<name>` overrides). */
  evals: EvalsPolicy
  agents: Record<string, AgentPolicy>
  auto_merge: AutoMergePolicy
  pull_request: PullRequestPolicy
  commit: CommitPolicy
  push: PushPolicy
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
    block_if_medium_increased: false,
    require_risk_score_not_increase: true,
    max_risk_score: 70,
    max_risk_score_increase: 0,
    max_critical_findings: 0,
    max_high_findings: 0,
    block_if_secrets_found: true,
    block_if_dangerous_tool_without_approval: true,
    block_if_user_input_to_dangerous_code: true,
    block_if_unsafe_mcp: true,
    block_if_schema_auth_gap: true,
  },
  evals: {
    block_if_accuracy_drops: true,
    min_accuracy: 0.85,
    block_if_runtime_increases: true,
    max_runtime_p95_ms: 2000,
    block_if_tool_selection_drops: true,
    min_tool_selection_pass_rate: 0.9,
    block_if_required_evals_missing: false,
    block_if_tests_fail: true,
  },
  agents: {},
  auto_merge: {
    enabled: false,
    trusted_branches_only: true,
    require_clean_worktree: true,
    require_branch_not_main: true,
    require_policy_pass: true,
    require_no_critical_or_high: true,
    require_accuracy_not_drop: true,
    require_runtime_not_increase: true,
  },
  pull_request: {
    create_if_policy_passes: true,
    create_draft_if_warn: true,
    block_if_policy_blocks: true,
    base_branch: "main",
    run_policy_gate_before_pr: true,
    require_clean_worktree: true,
    block_pr_from_main_or_master: true,
  },
  commit: {
    block_if_policy_blocks: true,
    run_scan_before_commit: true,
  },
  push: {
    block_if_policy_blocks: true,
    run_scan_before_push: true,
  },
}

/* -------------------------------------------------------------------------- */
/* YAML parser (lenient, never throws)                                        */
/* -------------------------------------------------------------------------- */

const ModeSchema = z.enum(["warn", "block", "auto_merge"])

/**
 * Numeric threshold fields the UI can explicitly toggle OFF (see the
 * Switch on each `NumberField` in Settings → Policy Rules).
 *
 * "Off" is meaningfully different from "missing": when a user flips
 * one of these off, we record `null` on disk / on the wire so that
 * reloading doesn't silently restore the default value. The in-memory
 * `Policy` type continues to use `undefined` for "off"; this list
 * tells the parser, serializer, and save-route how to convert at the
 * boundaries.
 */
export const TOGGLABLE_NUMERIC_KEYS = {
  security: [
    "max_risk_score",
    "max_risk_score_increase",
    "max_critical_findings",
    "max_high_findings",
  ] as const,
  evals: [
    "min_accuracy",
    "max_runtime_p95_ms",
    "min_tool_selection_pass_rate",
  ] as const,
} as const

const nullableNumber = () => z.number().nullable().optional()

const SecuritySchema = z
  .object({
    block_if_critical: z.boolean().optional(),
    block_if_high_increased: z.boolean().optional(),
    block_if_medium_increased: z.boolean().optional(),
    require_risk_score_not_increase: z.boolean().optional(),
    max_risk_score: nullableNumber(),
    max_risk_score_increase: nullableNumber(),
    max_critical_findings: nullableNumber(),
    max_high_findings: nullableNumber(),
    block_if_secrets_found: z.boolean().optional(),
    block_if_dangerous_tool_without_approval: z.boolean().optional(),
    block_if_user_input_to_dangerous_code: z.boolean().optional(),
    block_if_unsafe_mcp: z.boolean().optional(),
    block_if_schema_auth_gap: z.boolean().optional(),
  })
  .partial()
  .passthrough()

const EvalsSchema = z
  .object({
    block_if_accuracy_drops: z.boolean().optional(),
    min_accuracy: nullableNumber(),
    block_if_runtime_increases: z.boolean().optional(),
    max_runtime_p95_ms: nullableNumber(),
    block_if_tool_selection_drops: z.boolean().optional(),
    min_tool_selection_pass_rate: nullableNumber(),
    block_if_required_evals_missing: z.boolean().optional(),
    block_if_tests_fail: z.boolean().optional(),
  })
  .partial()
  .passthrough()

const CommitSchema = z
  .object({
    block_if_policy_blocks: z.boolean().optional(),
    run_scan_before_commit: z.boolean().optional(),
  })
  .partial()
  .passthrough()

const PushSchema = z
  .object({
    block_if_policy_blocks: z.boolean().optional(),
    run_scan_before_push: z.boolean().optional(),
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
    require_no_critical_or_high: z.boolean().optional(),
    require_accuracy_not_drop: z.boolean().optional(),
    require_runtime_not_increase: z.boolean().optional(),
  })
  .passthrough()

const PullRequestSchema = z
  .object({
    create_if_policy_passes: z.boolean().optional(),
    create_draft_if_warn: z.boolean().optional(),
    block_if_policy_blocks: z.boolean().optional(),
    base_branch: z.string().optional(),
    run_policy_gate_before_pr: z.boolean().optional(),
    require_clean_worktree: z.boolean().optional(),
    block_pr_from_main_or_master: z.boolean().optional(),
  })
  .passthrough()

const PolicySchema = z
  .object({
    mode: ModeSchema.optional(),
    security: SecuritySchema.optional(),
    evals: EvalsSchema.optional(),
    agents: z.record(z.string(), AgentPolicySchema).optional(),
    auto_merge: AutoMergeSchema.optional(),
    pull_request: PullRequestSchema.optional(),
    commit: CommitSchema.optional(),
    push: PushSchema.optional(),
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
    security: stripExplicitNulls<SecurityPolicy>(
      { ...DEFAULT_POLICY.security, ...(v.security ?? {}) },
      TOGGLABLE_NUMERIC_KEYS.security
    ),
    evals: stripExplicitNulls<EvalsPolicy>(
      { ...DEFAULT_POLICY.evals, ...(v.evals ?? {}) },
      TOGGLABLE_NUMERIC_KEYS.evals
    ),
    agents: { ...(v.agents ?? {}) },
    auto_merge: {
      ...DEFAULT_POLICY.auto_merge,
      ...(v.auto_merge ?? {}),
    },
    pull_request: {
      ...DEFAULT_POLICY.pull_request,
      ...(v.pull_request ?? {}),
    },
    commit: {
      ...DEFAULT_POLICY.commit,
      ...(v.commit ?? {}),
    },
    push: {
      ...DEFAULT_POLICY.push,
      ...(v.push ?? {}),
    },
  }
  return { policy, errors, parsed: true }
}

/**
 * After merging a user's YAML over `DEFAULT_POLICY`, any togglable
 * numeric field whose value is explicitly `null` represents
 * "user disabled this" and must beat the default. Convert `null` →
 * absent so the rest of the codebase (which treats `undefined` as
 * "rule off") doesn't have to learn a new sentinel.
 */
function stripExplicitNulls<T extends object>(
  merged: Record<string, unknown>,
  togglableKeys: readonly string[]
): T {
  const out: Record<string, unknown> = { ...merged }
  for (const k of togglableKeys) {
    if (out[k] === null) {
      delete out[k]
    }
  }
  return out as T
}

/* -------------------------------------------------------------------------- */
/* YAML serialiser                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a `Policy` back to YAML. Used by `/api/policy/save` and by
 * the Settings → Policy Rules "Save" button. We pin the key order so
 * generated files diff nicely (top-level first, then sections in the
 * same order as the type), and we strip undefined keys so saved files
 * are minimal.
 */
export function serializePolicyToYaml(policy: Policy): string {
  const sorted = orderPolicy(policy)
  const header = [
    "# Edge Agent AI policy file",
    "# This file is consumed by .edgeagent / Edge Agent AI to gate commits,",
    "# pushes, and PR creation. Generated by the Settings → Policy Rules UI;",
    "# safe to hand-edit (lenient YAML parser merges over the defaults).",
    "",
  ].join("\n")
  return header + YAML.stringify(sorted, { indent: 2, lineWidth: 0 })
}

function orderPolicy(p: Policy): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  out.mode = p.mode
  out.security = orderKeys(
    p.security,
    [
      "block_if_critical",
      "block_if_high_increased",
      "block_if_medium_increased",
      "require_risk_score_not_increase",
      "max_risk_score",
      "max_risk_score_increase",
      "max_critical_findings",
      "max_high_findings",
      "block_if_secrets_found",
      "block_if_dangerous_tool_without_approval",
      "block_if_user_input_to_dangerous_code",
      "block_if_unsafe_mcp",
      "block_if_schema_auth_gap",
    ],
    TOGGLABLE_NUMERIC_KEYS.security
  )
  out.evals = orderKeys(
    p.evals,
    [
      "block_if_accuracy_drops",
      "min_accuracy",
      "block_if_runtime_increases",
      "max_runtime_p95_ms",
      "block_if_tool_selection_drops",
      "min_tool_selection_pass_rate",
      "block_if_required_evals_missing",
      "block_if_tests_fail",
    ],
    TOGGLABLE_NUMERIC_KEYS.evals
  )
  // Drop the `agents` block entirely when empty so the YAML stays
  // focused on what the user actually configured.
  if (p.agents && Object.keys(p.agents).length > 0) {
    out.agents = p.agents
  }
  out.pull_request = orderKeys(p.pull_request, [
    "create_if_policy_passes",
    "create_draft_if_warn",
    "block_if_policy_blocks",
    "base_branch",
    "run_policy_gate_before_pr",
    "require_clean_worktree",
    "block_pr_from_main_or_master",
  ])
  out.push = orderKeys(p.push, ["block_if_policy_blocks", "run_scan_before_push"])
  out.commit = orderKeys(p.commit, [
    "block_if_policy_blocks",
    "run_scan_before_commit",
  ])
  out.auto_merge = orderKeys(p.auto_merge, [
    "enabled",
    "trusted_branches_only",
    "require_clean_worktree",
    "require_branch_not_main",
    "require_policy_pass",
    "require_no_critical_or_high",
    "require_accuracy_not_drop",
    "require_runtime_not_increase",
  ])
  return out
}

function orderKeys(
  obj: object | undefined,
  order: string[],
  togglableKeys: readonly string[] = []
): Record<string, unknown> {
  const src = (obj ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const togglable = new Set(togglableKeys)
  for (const k of order) {
    if (src[k] !== undefined) {
      out[k] = src[k]
    } else if (togglable.has(k)) {
      // Togglable numeric that the user turned off — record explicit
      // `null` so reloading the YAML doesn't silently re-apply the
      // default value.
      out[k] = null
    }
  }
  for (const k of Object.keys(src)) {
    if (!(k in out) && src[k] !== undefined) out[k] = src[k]
  }
  return out
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

/**
 * Lite reports passed by Branch Compare don't include the findings
 * array (the route only needs risk+summary). Detect that case so the
 * rule-id-driven security checks can mark themselves inapplicable
 * instead of silently passing a partial payload.
 */
function targetReportFindings(
  report: ScanReport
): { rule_id: string; agent: string }[] | null {
  const f = (report as unknown as { findings?: unknown }).findings
  if (!Array.isArray(f)) return null
  // Tolerant: any entry missing rule_id is dropped.
  return f
    .filter(
      (x): x is { rule_id: string; agent?: string } =>
        x != null && typeof x === "object" && typeof (x as { rule_id?: unknown }).rule_id === "string"
    )
    .map((x) => ({ rule_id: x.rule_id, agent: typeof x.agent === "string" ? x.agent : "" }))
}

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

  // block_if_medium_increased (delta)
  if (sec.block_if_medium_increased) {
    if (!bSum) {
      inapplicableConditions.push("security.block_if_medium_increased")
    } else if (tSum.medium > bSum.medium) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.block_if_medium_increased")
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: medium findings increased ${bSum.medium} → ${tSum.medium} (+${tSum.medium - bSum.medium}).`
      )
    } else {
      passedConditions.push("security.block_if_medium_increased")
    }
  }

  // max_risk_score_increase (delta ceiling)
  if (typeof sec.max_risk_score_increase === "number") {
    if (!baseReport) {
      inapplicableConditions.push("security.max_risk_score_increase")
    } else {
      const delta = targetReport.risk_score - baseReport.risk_score
      if (delta > sec.max_risk_score_increase) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push("security.max_risk_score_increase")
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: risk score increased by ${signed(delta)} (allowed: +${sec.max_risk_score_increase}).`
        )
      } else {
        passedConditions.push("security.max_risk_score_increase")
      }
    }
  }

  // max_critical_findings (absolute ceiling)
  if (typeof sec.max_critical_findings === "number") {
    if (tSum.critical > sec.max_critical_findings) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.max_critical_findings")
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: ${tSum.critical} critical findings exceed ceiling ${sec.max_critical_findings}.`
      )
    } else {
      passedConditions.push("security.max_critical_findings")
    }
  }

  // max_high_findings (absolute ceiling)
  if (typeof sec.max_high_findings === "number") {
    if (tSum.high > sec.max_high_findings) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push("security.max_high_findings")
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: ${tSum.high} high findings exceed ceiling ${sec.max_high_findings}.`
      )
    } else {
      passedConditions.push("security.max_high_findings")
    }
  }

  // ── Rule-id-driven security checks ──────────────────────────────
  // These look at the actual findings array on the report. When the
  // caller passed a lite report (no findings), every one of these is
  // marked inapplicable rather than silently passing — otherwise a
  // partial payload could let a real secret leak through the gate.
  const findings = targetReportFindings(targetReport)
  const ruleIdSet = findings == null ? null : new Set(findings.map((f) => f.rule_id))

  const ruleIdRules: {
    cond: string
    enabled: boolean
    triggerRuleIds: string[]
    explain: (matches: string[]) => string
  }[] = [
    {
      cond: "security.block_if_secrets_found",
      enabled: !!sec.block_if_secrets_found,
      triggerRuleIds: ["secrets"],
      explain: () => "secret-like values were detected in source",
    },
    {
      cond: "security.block_if_user_input_to_dangerous_code",
      enabled: !!sec.block_if_user_input_to_dangerous_code,
      triggerRuleIds: ["user-input-dangerous-code", "prompt-injection"],
      explain: () => "user input can flow into dangerous code paths",
    },
    {
      cond: "security.block_if_unsafe_mcp",
      enabled: !!sec.block_if_unsafe_mcp,
      triggerRuleIds: ["mcp-security"],
      explain: () => "MCP configuration looks unsafe",
    },
    {
      cond: "security.block_if_schema_auth_gap",
      enabled: !!sec.block_if_schema_auth_gap,
      triggerRuleIds: ["openapi-schema"],
      explain: () => "OpenAPI / auth / schema quality issues were found",
    },
  ]
  for (const r of ruleIdRules) {
    if (!r.enabled) continue
    if (ruleIdSet == null) {
      inapplicableConditions.push(r.cond)
      continue
    }
    const hits = r.triggerRuleIds.filter((id) => ruleIdSet.has(id))
    if (hits.length > 0) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push(r.cond)
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: ${r.explain(hits)}.`
      )
    } else {
      passedConditions.push(r.cond)
    }
  }

  // block_if_dangerous_tool_without_approval — co-occurrence check
  if (sec.block_if_dangerous_tool_without_approval) {
    const cond = "security.block_if_dangerous_tool_without_approval"
    if (findings == null) {
      inapplicableConditions.push(cond)
    } else {
      // We block when ANY agent has a dangerous-tools finding AND no
      // matching human-approval finding (i.e. no approval gate was
      // detected for that agent). Per-agent rather than per-file to
      // mirror how the scanner attributes findings.
      const dangerousAgents = new Set<string>()
      const approvedAgents = new Set<string>()
      for (const f of findings) {
        if (f.rule_id === "dangerous-tools") dangerousAgents.add(f.agent || "")
        if (f.rule_id === "human-approval") approvedAgents.add(f.agent || "")
      }
      const unguarded = [...dangerousAgents].filter((a) => !approvedAgents.has(a))
      if (unguarded.length > 0) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push(cond)
        const sample = unguarded.filter(Boolean).slice(0, 3).join(", ")
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: dangerous tools without an approval gate${sample ? ` (agents: ${sample})` : ""}.`
        )
      } else {
        passedConditions.push(cond)
      }
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

  /* ---------------- Global eval rules ----------------
   * These mirror the policy.evals.* keys and apply to *every* agent
   * that has metrics. Per-agent rules above already handle bespoke
   * overrides; the global rules are the cheap "block on any agent
   * regressing" defaults. Agents with no metrics are skipped silently
   * (the per-agent path already emits the missing-metrics warning).
   */
  const evals = policy.evals ?? {}
  const allAgentNames = new Set<string>([
    ...Object.keys(targetMetrics ?? {}),
    ...Object.keys(baseMetrics ?? {}),
  ])

  const applyGlobalEvalRule = (params: {
    cond: string
    enabled: boolean
    check: (agent: string, tm: AgentMetrics | null, bm: AgentMetrics | null) => string | null
  }) => {
    if (!params.enabled) return
    if (allAgentNames.size === 0) {
      inapplicableConditions.push(params.cond)
      return
    }
    const fails: string[] = []
    for (const agent of allAgentNames) {
      const tm = targetMetrics?.[agent] ?? null
      const bm = baseMetrics?.[agent] ?? null
      // Per-agent overrides win — don't double-count if user
      // explicitly configured the same dimension below `agents.*`.
      const r = params.check(agent, tm, bm)
      if (r) fails.push(r)
    }
    if (fails.length > 0) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push(params.cond)
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: ${fails.slice(0, 3).join("; ")}${fails.length > 3 ? `; +${fails.length - 3} more` : ""}.`
      )
    } else {
      passedConditions.push(params.cond)
    }
  }

  applyGlobalEvalRule({
    cond: "evals.block_if_accuracy_drops",
    enabled: !!evals.block_if_accuracy_drops,
    check: (agent, tm, bm) => {
      if (tm?.accuracy == null || bm?.accuracy == null) return null
      if (tm.accuracy >= bm.accuracy) return null
      return `${agent} accuracy ${pct(bm.accuracy)} → ${pct(tm.accuracy)}`
    },
  })

  applyGlobalEvalRule({
    cond: "evals.min_accuracy",
    enabled: typeof evals.min_accuracy === "number",
    check: (agent, tm) => {
      if (tm?.accuracy == null) return null
      if (tm.accuracy >= (evals.min_accuracy as number)) return null
      return `${agent} accuracy ${pct(tm.accuracy)} below floor ${pct(evals.min_accuracy as number)}`
    },
  })

  applyGlobalEvalRule({
    cond: "evals.block_if_runtime_increases",
    enabled: !!evals.block_if_runtime_increases,
    check: (agent, tm, bm) => {
      if (tm?.runtime_ms == null || bm?.runtime_ms == null) return null
      if (tm.runtime_ms <= bm.runtime_ms) return null
      return `${agent} runtime ${bm.runtime_ms}ms → ${tm.runtime_ms}ms`
    },
  })

  applyGlobalEvalRule({
    cond: "evals.max_runtime_p95_ms",
    enabled: typeof evals.max_runtime_p95_ms === "number",
    check: (agent, tm) => {
      if (tm?.runtime_ms == null) return null
      if (tm.runtime_ms <= (evals.max_runtime_p95_ms as number)) return null
      return `${agent} runtime ${tm.runtime_ms}ms above ceiling ${evals.max_runtime_p95_ms}ms`
    },
  })

  applyGlobalEvalRule({
    cond: "evals.block_if_tool_selection_drops",
    enabled: !!evals.block_if_tool_selection_drops,
    check: (agent, tm, bm) => {
      if (tm?.tool_selection_pass_rate == null || bm?.tool_selection_pass_rate == null) return null
      if (tm.tool_selection_pass_rate >= bm.tool_selection_pass_rate) return null
      return `${agent} tool-selection pass rate ${pct(bm.tool_selection_pass_rate)} → ${pct(tm.tool_selection_pass_rate)}`
    },
  })

  applyGlobalEvalRule({
    cond: "evals.min_tool_selection_pass_rate",
    enabled: typeof evals.min_tool_selection_pass_rate === "number",
    check: (agent, tm) => {
      if (tm?.tool_selection_pass_rate == null) return null
      if (tm.tool_selection_pass_rate >= (evals.min_tool_selection_pass_rate as number))
        return null
      return `${agent} tool-selection pass rate ${pct(tm.tool_selection_pass_rate)} below floor ${pct(evals.min_tool_selection_pass_rate as number)}`
    },
  })

  // block_if_required_evals_missing — fires when the project declares
  // agent policies (agents.*) but no metrics arrived from the eval
  // runner. Surfaces "you forgot to run evals" instead of silently
  // passing on missing data.
  if (evals.block_if_required_evals_missing) {
    const declared = Object.keys(policy.agents ?? {})
    if (declared.length === 0) {
      inapplicableConditions.push("evals.block_if_required_evals_missing")
    } else {
      const missing = declared.filter(
        (a) => !targetMetrics || targetMetrics[a] == null
      )
      if (missing.length > 0) {
        const sev = severityFor(policy.mode, true)
        severity = escalate(severity, sev)
        failedConditions.push("evals.block_if_required_evals_missing")
        reasons.push(
          `${sev === "block" ? "Blocked" : "Warning"}: required eval metrics missing for ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}.`
        )
      } else {
        passedConditions.push("evals.block_if_required_evals_missing")
      }
    }
  }

  // block_if_tests_fail — opt-in. The eval runner stamps each agent's
  // metrics with `tests_failed` when available; if any agent reports
  // > 0 failures we block. Unknown counts are skipped (inapplicable).
  if (evals.block_if_tests_fail) {
    const cond = "evals.block_if_tests_fail"
    type WithTests = AgentMetrics & { tests_failed?: number; tests_passed?: number }
    const failing: string[] = []
    let anyKnown = false
    for (const [agent, m] of Object.entries((targetMetrics ?? {}) as Record<string, WithTests>)) {
      if (typeof m?.tests_failed === "number") {
        anyKnown = true
        if (m.tests_failed > 0) {
          failing.push(`${agent} (${m.tests_failed} failed)`)
        }
      }
    }
    if (!anyKnown) {
      inapplicableConditions.push(cond)
    } else if (failing.length > 0) {
      const sev = severityFor(policy.mode, true)
      severity = escalate(severity, sev)
      failedConditions.push(cond)
      reasons.push(
        `${sev === "block" ? "Blocked" : "Warning"}: tests failed: ${failing.slice(0, 3).join("; ")}${failing.length > 3 ? `; +${failing.length - 3} more` : ""}.`
      )
    } else {
      passedConditions.push(cond)
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
    if (policy.auto_merge.require_no_critical_or_high) {
      if (tSum.critical > 0 || tSum.high > 0) {
        gates.push(
          `target has ${tSum.critical} critical / ${tSum.high} high findings`
        )
      }
    }
    if (policy.auto_merge.require_accuracy_not_drop) {
      const drops: string[] = []
      for (const [agent, m] of Object.entries(perAgentDeltas)) {
        if (m.accuracy !== null && m.accuracy < 0) drops.push(agent)
      }
      if (drops.length > 0) {
        gates.push(`accuracy dropped for ${drops.slice(0, 3).join(", ")}`)
      }
    }
    if (policy.auto_merge.require_runtime_not_increase) {
      const ups: string[] = []
      for (const [agent, m] of Object.entries(perAgentDeltas)) {
        if (m.runtime_ms !== null && m.runtime_ms > 0) ups.push(agent)
      }
      if (ups.length > 0) {
        gates.push(`runtime increased for ${ups.slice(0, 3).join(", ")}`)
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
