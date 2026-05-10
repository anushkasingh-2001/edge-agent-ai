/**
 * Typed fetchers for the /api/git/* endpoints. Plain fetch + JSON, no SDK.
 * All methods throw `Error` with the server-provided message on non-2xx.
 */

export type GitBranchesResponse = {
  branches: string[]
  remoteOnly: string[]
  currentBranch: string | null
  isRepo: boolean
}

export type GitWorkingTreeStatus = "clean" | "uncommitted"

export type GitStatusResponse = {
  isRepo: boolean
  currentBranch: string | null
  remote: string | null
  workingTreeStatus: GitWorkingTreeStatus | null
  lastCommitSha: string | null
  lastCommitMessage: string | null
}

export type GitChangeStatus = "A" | "M" | "D" | "R" | "C" | "T"

export type GitChangeCategory =
  | "prompt"
  | "tool"
  | "schema"
  | "mcp"
  | "dependency"
  | "code"

export type GitChangedFile = {
  path: string
  oldPath?: string
  status: GitChangeStatus
  category: GitChangeCategory
}

export type GitCompareResponse = {
  base: string
  target: string
  baseSha: string
  targetSha: string
  files: GitChangedFile[]
  summary: {
    total: number
    byCategory: Record<GitChangeCategory, number>
    byStatus: Record<GitChangeStatus, number>
  }
}

export type GitChangeDetailResponse = {
  file: string
  status: GitChangeStatus
  category: GitChangeCategory
  diff: string
  truncated: boolean
  why: string
  base: string
  target: string
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as
    | (T & { error?: string })
    | { error?: string }
  if (!res.ok) {
    const msg =
      (data && "error" in data && typeof data.error === "string"
        ? data.error
        : null) || `Request failed with status ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export async function fetchGitBranches(
  projectPath: string
): Promise<GitBranchesResponse> {
  const url = `/api/git/branches?projectPath=${encodeURIComponent(projectPath)}`
  const res = await fetch(url, { method: "GET" })
  return jsonOrThrow<GitBranchesResponse>(res)
}

export async function fetchGitStatus(
  projectPath: string
): Promise<GitStatusResponse> {
  const url = `/api/git/status?projectPath=${encodeURIComponent(projectPath)}`
  const res = await fetch(url, { method: "GET" })
  return jsonOrThrow<GitStatusResponse>(res)
}

export async function fetchGitCompare(args: {
  projectPath: string
  base: string
  target: string
}): Promise<GitCompareResponse> {
  const res = await fetch("/api/git/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonOrThrow<GitCompareResponse>(res)
}

export async function fetchGitChangeDetail(args: {
  projectPath: string
  base: string
  target: string
  file: string
}): Promise<GitChangeDetailResponse> {
  const res = await fetch("/api/git/change-detail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonOrThrow<GitChangeDetailResponse>(res)
}

/* -------------------------------------------------------------------------- */
/* Compare-Scan: dual scan + findings diff                                    */
/* -------------------------------------------------------------------------- */

export type CompareScanFinding = {
  rule_id: string
  severity: "critical" | "high" | "medium" | "low"
  category: string
  title: string
  file: string
  line: number
}

type ScanLite = {
  risk_score: number
  summary: { critical: number; high: number; medium: number; low: number; total: number }
}

export type PerFileImpact = {
  file: string
  fixed: CompareScanFinding[]
  introduced: CompareScanFinding[]
  /** Approximate weighted risk delta for this file (negative = improvement). */
  riskDelta: number
  linesAdded: number
  linesDeleted: number
  verdict: "improved" | "regressed" | "mixed"
}

/**
 * Aggregated impact for a single scanner category (e.g. "Weak prompt",
 * "MCP configuration", "Dangerous tool / side effect"). Drives the
 * per-area cards in the deep comparison view.
 */
export type CategoryImpact = {
  category: string
  ruleIds: string[]
  baseCount: number
  targetCount: number
  /** target − base. Negative = fewer findings = improvement. */
  delta: number
  /**
   * Percent change relative to the base count, signed and rounded to 1
   * decimal. `null` means base was 0 and target > 0 — i.e. the category
   * is brand-new on this branch and percent change is undefined.
   */
  pctDelta: number | null
  fixedCount: number
  introducedCount: number
  /**
   * True when the net delta is 0 but fixedCount === introducedCount > 0.
   * That pattern is almost always per-rule-cap churn (same logical
   * findings, different members of the cap on each side) rather than
   * real movement, so the UI hides the noisy "X fixed · Y introduced"
   * suffix in that case.
   */
  cappedChurn: boolean
  /** Files that fixed findings in this category, sorted by count desc. */
  filesImproved: { file: string; count: number }[]
  /** Files that introduced findings in this category, sorted by count desc. */
  filesRegressed: { file: string; count: number }[]
  /** Up to 3 representative findings, for the expand view. */
  sampleFixed: CompareScanFinding[]
  sampleIntroduced: CompareScanFinding[]
}

export type GitCompareScanResponse = {
  base: string
  target: string
  baseSha: string
  targetSha: string
  sameSha: boolean
  /** Whole-branch scan summary for each side. `null` only when sameSha. */
  baseScan: ScanLite | null
  targetScan: ScanLite | null
  /** target − base (so positive = regression on totals/risk). null when sameSha. */
  delta: {
    risk: number
    total: number
    critical: number
    high: number
    medium: number
    low: number
  } | null
  /** Top 10 findings present in target but not base, severity-first. */
  introduced: CompareScanFinding[]
  /** Top 10 findings present in base but not target, severity-first. */
  fixed: CompareScanFinding[]
  /** Total counts so the UI can say "10 of N shown". */
  introducedTotal?: number
  fixedTotal?: number
  persistent: number
  /** Per-file attribution buckets: which files improved / regressed / both. */
  perFile?: {
    improvers: PerFileImpact[]
    regressors: PerFileImpact[]
    mixed: PerFileImpact[]
    improversTotal: number
    regressorsTotal: number
    mixedTotal: number
  }
  /** Per-category aggregation (Prompt Quality / MCP / Dangerous Tools / …). */
  byCategory?: CategoryImpact[]
}

export async function fetchGitCompareScan(args: {
  projectPath: string
  base: string
  target: string
}): Promise<GitCompareScanResponse> {
  const res = await fetch("/api/git/compare-scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonOrThrow<GitCompareScanResponse>(res)
}

/* -------------------------------------------------------------------------- */
/* Pull / Commit / Push                                                       */
/*                                                                            */
/* Unlike the read-only endpoints above these can FAIL with structured        */
/* `{ ok: false, blocked, phase, ... }` payloads (e.g. uncommitted-changes    */
/* on pull, critical/high findings on commit/push). Callers branch on `ok`/  */
/* `blocked`, so we don't throw on non-2xx — we surface the JSON as-is.       */
/* -------------------------------------------------------------------------- */

export type GitOpReportSummary = {
  risk_score: number
  summary: {
    critical: number
    high: number
    medium: number
    low: number
    total: number
  }
}

export type GitPullResponse = {
  ok: boolean
  branch?: string
  blocked?: boolean
  reason?: "uncommitted_changes"
  phase?: "fetch" | "pull"
  workingTreeStatus?: GitWorkingTreeStatus
  message?: string
  stdout?: string
  stderr?: string
  error?: string
}

/**
 * Policy artefacts surfaced by /api/git/commit and /api/git/push when a
 * pre-op scan was requested. We import the types lazily to avoid a
 * circular dep between the git client and the policy client.
 */
import type { Policy, PolicyEvaluation } from "@/lib/policy"

export type GitCommitResponse = {
  ok: boolean
  blocked?: boolean
  reason?: "critical_or_high_findings" | "policy_block"
  noChanges?: boolean
  phase?: "scan" | "add" | "commit"
  message?: string
  sha?: string | null
  report?: GitOpReportSummary | null
  stdout?: string
  stderr?: string
  error?: string
  policy?: Policy
  policySource?: "file" | "default"
  policyErrors?: string[]
  evaluation?: PolicyEvaluation | null
}

export type GitPushResponse = {
  ok: boolean
  branch?: string
  blocked?: boolean
  reason?:
    | "critical_or_high_findings"
    | "policy_block"
    | "no_push_permission"
    | "permission_denied"
  phase?: "scan" | "push" | "permission"
  message?: string
  report?: GitOpReportSummary | null
  stdout?: string
  stderr?: string
  error?: string
  policy?: Policy
  policySource?: "file" | "default"
  policyErrors?: string[]
  evaluation?: PolicyEvaluation | null
  /** GitHub auth + permission detail attached when the route was able
   * to query `gh`. Present on both pre-flight blocks and post-push
   * 403 errors so the UI can render the same banner either way. */
  github?: {
    login: string | null
    owner: string
    repo: string
    remoteUrl: string
    protocol: "https" | "ssh"
    permissions?: {
      admin: boolean
      maintain: boolean
      push: boolean
      triage: boolean
      pull: boolean
    }
    canPush?: boolean
  }
  /** Suggested fixes (gh auth login, clear credential helper, switch
   * to SSH, …). Only set on permission-denied 403 errors. */
  suggestions?: string[]
}

async function jsonAlways<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T
  return data
}

export async function gitPull(args: {
  projectPath: string
  branch: string
}): Promise<GitPullResponse> {
  const res = await fetch("/api/git/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonAlways<GitPullResponse>(res)
}

export async function gitCommit(args: {
  projectPath: string
  message: string
  runScanBeforeCommit: boolean
  warnOnCriticalFindings: boolean
}): Promise<GitCommitResponse> {
  const res = await fetch("/api/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonAlways<GitCommitResponse>(res)
}

export async function gitPush(args: {
  projectPath: string
  branch: string
  runScanBeforePush: boolean
  warnOnCriticalFindings: boolean
}): Promise<GitPushResponse> {
  const res = await fetch("/api/git/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonAlways<GitPushResponse>(res)
}
