/**
 * Typed fetchers for the /api/git/* endpoints. Plain fetch + JSON, no SDK.
 * All methods throw `Error` with the server-provided message on non-2xx.
 */

export type GitBranchesResponse = {
  branches: string[]
  remoteOnly: string[]
  currentBranch: string | null
  isRepo: boolean
  /** Per-branch stash counts inferred from `git stash list` subjects.
   *  Keys are short branch names (e.g. "low", "main"). Branches with
   *  zero stashes simply don't appear in the map. Used by Branch
   *  Compare to enable/disable the per-side "commits + stashes"
   *  toggle without an extra round-trip. Optional for backward
   *  compat with older API responses. */
  stashesByBranch?: Record<string, number>
}

export type GitWorkingTreeStatus = "clean" | "uncommitted"

export type GitStatusResponse = {
  isRepo: boolean
  currentBranch: string | null
  remote: string | null
  /** "uncommitted" whenever there are tracked-modified files OR any
   * untracked files OR a `git stash` entry attributed to the current
   * branch. Stashes count too: a stash on `main` makes `main` look
   * uncommitted even when the working tree itself is empty. */
  workingTreeStatus: GitWorkingTreeStatus | null
  /** Number of tracked files with uncommitted changes on the current
   * branch. Used by the dialog to break "uncommitted" down precisely. */
  trackedModifiedCount?: number
  /** Untracked files attributed to the current branch — either the
   * user just created them here, or they were first observed on
   * this branch. Contributes to `workingTreeStatus === "uncommitted"`
   * and gets staged on commit. */
  ownBranchUntrackedCount?: number
  /** Untracked files attributed to OTHER branches that happen to be
   * physically present in the working tree (followed `git checkout`
   * here). Inclusive: still trips the yellow dot and gets committed. */
  crossBranchUntrackedCount?: number
  /** Distinct other-branch names referenced by `crossBranchUntracked`. */
  crossBranchUntrackedBranches?: string[]
  /** How many `git stash` entries were created on the current branch
   * (parsed from the stash subject "WIP on <branch>:"). When > 0 the
   * current branch is "uncommitted" even with an otherwise clean
   * working tree, and the commit dialog will offer to pop+commit
   * the latest stash. */
  currentBranchStashCount?: number
  /** Ref of the most recent stash for the current branch, e.g.
   * "stash@{0}" or "stash@{2}". Pass to `commit` to apply+commit
   * the stash. */
  latestCurrentBranchStashRef?: string | null
  /** Subject of the most recent stash for the current branch, used
   * in tooltips and the commit dialog. */
  latestCurrentBranchStashMessage?: string | null
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

/**
 * Per-side stash inclusion summary returned by `/api/git/compare` and
 * `/api/git/compare-scan`. `included: false` ↔ caller didn't ask to
 * include stashes for this side; `included: true, appliedCount: 0` ↔
 * caller asked but the branch had zero stashes attributed to it.
 * `skipped` lists stashes the route tried to layer but couldn't (the
 * usual cause is a merge conflict against earlier-applied content).
 */
export type CompareStashSummary = {
  included: boolean
  appliedCount: number
  skippedCount: number
  applied: { ref: string; subject: string }[]
  skipped: { ref: string; subject: string; reason: string }[]
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
  /** Stashes layered onto the base side before diffing. Optional for
   *  backward compat with older server responses. */
  baseStashes?: CompareStashSummary
  /** Stashes layered onto the target side before diffing. */
  targetStashes?: CompareStashSummary
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
  // cache: "no-store" so we always re-read the working tree (the
  // user can run `git add` from a terminal between renders, and any
  // stale cached response would lie about being clean).
  const res = await fetch(url, { method: "GET", cache: "no-store" })
  return jsonOrThrow<GitStatusResponse>(res)
}

export async function fetchGitCompare(args: {
  projectPath: string
  base: string
  target: string
  /** When true, layer every `git stash` attributed to the base
   *  branch (oldest → newest, latest wins on per-file conflicts)
   *  onto the base side before diffing. */
  baseIncludeStashes?: boolean
  /** Same as `baseIncludeStashes` but for the target side. */
  targetIncludeStashes?: boolean
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
  /** Stashes layered onto the base side before scanning. */
  baseStashes?: CompareStashSummary
  /** Stashes layered onto the target side before scanning. */
  targetStashes?: CompareStashSummary
}

export async function fetchGitCompareScan(args: {
  projectPath: string
  base: string
  target: string
  /** When true, every `git stash` attributed to the base branch is
   *  layered onto the base worktree before the scanner runs (oldest
   *  → newest, latest wins on per-file conflicts). No-op when the
   *  branch has zero stashes. */
  baseIncludeStashes?: boolean
  /** Same as `baseIncludeStashes` but for the target side. */
  targetIncludeStashes?: boolean
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
  reason?: "critical_or_high_findings" | "policy_block" | "stash_pop_conflict"
  noChanges?: boolean
  phase?: "scan" | "stash_pop" | "add" | "commit"
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
  /** Inclusive staging breakdown — set on successful (or no-op)
   * commits. `untrackedStaged` is every untracked file we added,
   * `untrackedFromOtherBranches` shows how many of those were
   * attributed elsewhere (informational; they were committed
   * regardless). `untrackedSkipped` stays for backward compat with
   * older UI strings — always 0 now. */
  staging?: {
    untrackedStaged: number
    untrackedSkipped: number
    untrackedFromOtherBranchCount?: number
    untrackedFromOtherBranches?: { path: string; branch: string }[]
  }
  /** Set when the route popped a `git stash` entry into the working
   * tree before committing. Mirrors what the dialog needs to show
   * "Stash <ref> applied and committed: <subject>". */
  stashPopped?: {
    ref: string
    subject: string
  } | null
}

/** Response from POST /api/git/discard — see route docstring.
 *  IMPORTANT: discard NEVER deletes untracked files. It only
 *  reverts tracked-file modifications back to HEAD. The kept-
 *  untracked counts are informational so the UI can show the
 *  user what was preserved. */
export type GitDiscardResponse = {
  ok: boolean
  branch?: string | null
  /** Number of tracked-modified files we reset back to HEAD. */
  revertedTracked?: number
  /** Number of untracked files we left in place (always equal to
   * the working tree's untracked count after revert). */
  keptUntracked?: number
  /** Per-branch breakdown of kept untracked files, e.g.
   * `{ main: 2, low: 1 }`. Used by the dialog to show "kept 3
   * untracked: 2 on main, 1 on low". */
  keptUntrackedByBranch?: Record<string, number>
  revertError?: string | null
  message?: string
  error?: string
  stderr?: string
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
  /** When set, the commit route will `git stash pop <stashRef>`
   * after the policy gate passes and before `git add -A`. Used by
   * the UI to commit "stash-only-dirty" branches in one click. The
   * ref must look like "stash@{N}". */
  stashRef?: string
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

/**
 * Discard local changes for the current branch:
 *   - reverts tracked-file modifications back to HEAD
 *   - deletes untracked files attributed to the current branch
 *   - leaves untracked files that belong to other branches alone
 *
 * Destructive — caller must show a confirmation UI before calling.
 * The route enforces `confirm: true` server-side too.
 */
export async function gitDiscard(args: {
  projectPath: string
  confirm: true
}): Promise<GitDiscardResponse> {
  const res = await fetch("/api/git/discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonAlways<GitDiscardResponse>(res)
}

/** Response from POST /api/git/reattribute. */
export type GitReattributeResponse = {
  ok: boolean
  branch?: string | null
  /** Number of entries removed from the OLD attribution map. */
  removedEntries?: number
  /** Files now attributed to the current branch after re-inference. */
  ownBranch?: string[]
  /** Files now attributed elsewhere. */
  otherBranch?: { path: string; branch: string }[]
  message?: string
  error?: string
  stderr?: string
}

/**
 * Wipe the attribution map + head snapshot and re-infer attribution
 * from scratch using the reflog + mtime heuristic. Useful when the
 * map got locked in with wrong entries (e.g. files were tagged to
 * `main` because that was the very first branch the app saw, even
 * though the files were actually created on a feature branch).
 *
 * Non-destructive to working-tree contents — only edits the
 * `.edgeagent/` bookkeeping files.
 */
export async function gitReattribute(args: {
  projectPath: string
  confirm: true
}): Promise<GitReattributeResponse> {
  const res = await fetch("/api/git/reattribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return jsonAlways<GitReattributeResponse>(res)
}
