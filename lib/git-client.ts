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
