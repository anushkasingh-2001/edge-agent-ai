"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  GitBranch,
  ArrowRight,
  ChevronRight,
  Loader2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  ShieldCheck,
  ShieldAlert,
  MessageSquare,
  Wrench,
  FileJson,
  Network,
  Package,
  Lock,
  Workflow,
  Activity,
  GitPullRequest,
} from "lucide-react"
import {
  fetchGitCompare,
  fetchGitChangeDetail,
  fetchGitCompareScan,
  type GitChangedFile,
  type GitChangeCategory,
  type GitChangeStatus,
  type GitCompareResponse,
  type GitChangeDetailResponse,
  type GitCompareScanResponse,
  type PerFileImpact,
  type CategoryImpact,
} from "@/lib/git-client"
import { SCANNER_RULE_IDS } from "@/lib/scan-report"
import { SECURITY_CHECKS } from "@/lib/security-checks"
import { evaluatePolicyApi, type PolicyApiResponse } from "@/lib/policy-client"
import { PolicyStatusCard } from "@/components/policy-status-card"
import { CreatePrDialog } from "@/components/git-pr-dialog"

/**
 * Branch Compare runs `git diff` between two branches in the open project
 * and renders the changed files. The previous version filled this page
 * with hard-coded prompt/tool/schema rows, an "Evaluation Scores" widget
 * with invented metrics, and a "Likely Cause of Regression" callout that
 * pointed at a fictional file. None of that was real, so we strip it down
 * to only what we can actually compute today: the git diff and a per-file
 * change detail dialog.
 */

interface BranchCompareProps {
  /**
   * Latest policy evaluation for the *currently checked-out* branch
   * (computed by app/page.tsx after each scan). Used as a quick preview
   * card when no comparison has been run yet, and replaced by a fresh
   * policy evaluation against the deep-compare result once the user
   * runs a comparison.
   */
  currentPolicyResponse?: PolicyApiResponse | null
  /** Currently checked-out branch — used as the default base. */
  currentBranch?: string
  /** Real local branches sourced from /api/git/branches in the parent. */
  branches?: string[]
  /** Remote-only branches surfaced separately (origin/main etc.). */
  remoteOnlyBranches?: string[]
  /** Selected project filesystem path — required for git operations. */
  projectPath?: string
  /** True if the parent confirmed the project is a git repo. */
  isGitRepo?: boolean
  /** Force-refetch branches — with `expand=1` to widen the remote refspec
   * for shallow / single-branch clones. The parent owns the actual fetch
   * so the result also updates the top-bar dropdown. Optional. */
  onRefreshBranches?: (opts?: { expand?: boolean }) => void | Promise<void>
}

const CATEGORY_LABEL: Record<GitChangeCategory, string> = {
  prompt: "Prompt",
  tool: "Tool",
  schema: "Schema",
  mcp: "MCP",
  dependency: "Dependency",
  code: "Code",
}

const CATEGORY_BADGE_CLASS: Record<GitChangeCategory, string> = {
  prompt: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  tool: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  schema: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  mcp: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  dependency: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  code: "bg-secondary text-muted-foreground border-border/60",
}

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
}

/**
 * Heuristic re-check recommendations per change category. These are
 * deliberately worded as "may affect" suggestions, not assertions —
 * actual impact is only knowable after re-running the scanner via
 * "Scan both branches" below.
 */
const CATEGORY_HINT: Record<GitChangeCategory, string> = {
  prompt:
    "Re-run prompt-injection and vague-prompts checks; tone/instruction edits often shift tool selection.",
  tool:
    "Re-run dangerous-tools and human-approval checks; new side-effects can bypass existing gates.",
  schema:
    "Re-run openapi-schema; schema drift can break tool calls and validation guarantees.",
  mcp:
    "Re-run mcp-security; new/removed MCP servers change the agent's capability surface.",
  dependency:
    "Re-run dependency-risks; pinned-version drift can pull in vulnerable packages.",
  code:
    "Application code changed — full scan recommended to surface new findings.",
}

const CATEGORY_ICON_CLASS: Record<GitChangeCategory, string> = {
  prompt: "text-purple-400",
  tool: "text-blue-400",
  schema: "text-cyan-400",
  mcp: "text-orange-400",
  dependency: "text-yellow-400",
  code: "text-muted-foreground",
}

function statusBadge(status: GitChangeStatus) {
  const cls =
    status === "A"
      ? "bg-green-500/10 text-green-400 border-green-500/20"
      : status === "D"
      ? "bg-red-500/10 text-red-400 border-red-500/20"
      : "bg-secondary text-muted-foreground border-border/60"
  return (
    <Badge variant="outline" className={cls}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

export function BranchCompare({
  currentBranch = "main",
  branches = [],
  remoteOnlyBranches = [],
  projectPath,
  isGitRepo = false,
  onRefreshBranches,
  currentPolicyResponse = null,
}: BranchCompareProps) {
  // Default base = currently checked-out branch when present in the list.
  const defaultBase = branches.includes(currentBranch)
    ? currentBranch
    : branches[0] ?? ""
  // Default target = first branch that isn't the base.
  const defaultTarget =
    branches.find((b) => b !== defaultBase) ?? branches[0] ?? ""

  const [baseBranch, setBaseBranch] = useState<string>(defaultBase)
  const [targetBranch, setTargetBranch] = useState<string>(defaultTarget)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GitCompareResponse | null>(null)

  // Per-file detail dialog.
  const [detailFile, setDetailFile] = useState<GitChangedFile | null>(null)
  const [detail, setDetail] = useState<GitChangeDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Filter the changed-files list by category. Default "all". A flat
  // 7,000-row diff with one badge column is unreadable; grouping by
  // category gives the user a way to drill into "just the prompts" or
  // "just the dependencies" without a global search.
  const [categoryFilter, setCategoryFilter] = useState<"all" | GitChangeCategory>(
    "all"
  )

  // Deep security scan (POST /api/git/compare-scan). Now fires
  // automatically in parallel with `runComparison` — the user shouldn't
  // need a separate "Scan both branches" click; comparing branches in
  // this app means "tell me what actually changed about quality and
  // security", not just file paths. The scan can take time on big
  // repos, so we surface its loading/error state independently of the
  // file-diff state.
  const [scanLoading, setScanLoading] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanResult, setScanResult] = useState<GitCompareScanResponse | null>(
    null
  )

  // Policy evaluation against the deep-compare result. Lives inside the
  // component because it depends on baseScan + targetScan from the
  // compare-scan endpoint, which the parent doesn't have. Reset on each
  // new comparison so we don't show stale verdicts.
  const [policyResult, setPolicyResult] = useState<PolicyApiResponse | null>(
    null
  )
  const [policyLoading, setPolicyLoading] = useState(false)

  // "Create PR from this branch" — re-uses the same dialog as the top
  // bar but pre-fills base = baseBranch (the comparison's left side)
  // and head = targetBranch (the comparison's right side). The dialog
  // itself enforces the "head must not be main/master" rule.
  const [createPrOpen, setCreatePrOpen] = useState(false)

  // Reset selection if the branches list changes (project switch / remote
  // refresh). Stale dropdown values otherwise produce confusing empty
  // dropdowns and silent comparison failures.
  useEffect(() => {
    if (!branches.length) return
    if (!branches.includes(baseBranch)) setBaseBranch(branches[0])
    if (!branches.includes(targetBranch)) {
      setTargetBranch(branches.find((b) => b !== branches[0]) ?? branches[0])
    }
    // Keep dependency list narrow on purpose — we don't want to reset the
    // user's selection just because they typed in the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.join("|")])

  const branchOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string; remote?: boolean }[] = []
    for (const b of branches) {
      if (seen.has(b)) continue
      seen.add(b)
      out.push({ value: b, label: b })
    }
    for (const b of remoteOnlyBranches) {
      if (seen.has(b)) continue
      seen.add(b)
      out.push({ value: b, label: b, remote: true })
    }
    return out
  }, [branches, remoteOnlyBranches])

  async function runComparison() {
    if (!projectPath) {
      setError("Open a project first.")
      return
    }
    if (!baseBranch || !targetBranch) {
      setError("Pick both a base and a target branch.")
      return
    }
    if (baseBranch === targetBranch) {
      setError("Base and target are the same branch — nothing to compare.")
      setResult(null)
      setScanResult(null)
      return
    }
    setLoading(true)
    setScanLoading(true)
    setError(null)
    setScanError(null)
    setResult(null)
    setScanResult(null)
    setPolicyResult(null)
    setCategoryFilter("all")

    // Fire diff and dual-branch scan in parallel — they're independent
    // and the user expects "Run Comparison" to mean *the whole picture*,
    // not just file paths. We use Promise.allSettled so one failing leg
    // (e.g. shallow worktree on the scan side) still lets the other
    // render — partial info beats a blank page.
    const path = projectPath
    const base = baseBranch
    const target = targetBranch
    const [diffRes, scanRes] = await Promise.allSettled([
      fetchGitCompare({ projectPath: path, base, target }),
      fetchGitCompareScan({ projectPath: path, base, target }),
    ])

    if (diffRes.status === "fulfilled") {
      setResult(diffRes.value)
    } else {
      setError(
        diffRes.reason instanceof Error
          ? diffRes.reason.message
          : "Failed to compare branches."
      )
    }
    if (scanRes.status === "fulfilled") {
      setScanResult(scanRes.value)
      // Once the deep compare is back we have both base + target scan
      // summaries — feed them into the policy engine so the user sees
      // the same pass/warn/block verdict the commit/push dialogs would.
      // If `sameSha` (no real diff) we skip — the engine has nothing
      // delta-shaped to evaluate beyond the per-branch absolute rules.
      if (!scanRes.value.sameSha && scanRes.value.targetScan) {
        const baseLite = scanRes.value.baseScan
        const targetLite = scanRes.value.targetScan
        setPolicyLoading(true)
        try {
          const policy = await evaluatePolicyApi({
            projectPath: path,
            // The API accepts the lite shape via PolicyReportInputSchema —
            // it only reads risk_score + summary. Cast through unknown to
            // satisfy TS without cloning into a faux ScanReport.
            targetReport: {
              risk_score: targetLite.risk_score,
              summary: targetLite.summary,
            } as unknown as Parameters<typeof evaluatePolicyApi>[0]["targetReport"],
            baseReport: baseLite
              ? ({
                  risk_score: baseLite.risk_score,
                  summary: baseLite.summary,
                } as unknown as Parameters<typeof evaluatePolicyApi>[0]["baseReport"])
              : undefined,
            context: { branch: target },
          })
          setPolicyResult(policy)
        } catch {
          // Don't surface as a blocker — the scan still rendered. The
          // PolicyStatusCard's empty state is informative enough.
          setPolicyResult(null)
        } finally {
          setPolicyLoading(false)
        }
      }
    } else {
      setScanError(
        scanRes.reason instanceof Error
          ? scanRes.reason.message
          : "Failed to scan both branches."
      )
    }
    setLoading(false)
    setScanLoading(false)
  }

  async function openDetail(file: GitChangedFile) {
    if (!projectPath || !result) return
    setDetailFile(file)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const d = await fetchGitChangeDetail({
        projectPath,
        base: result.base,
        target: result.target,
        file: file.path,
      })
      setDetail(d)
    } catch (e) {
      setDetailError(
        e instanceof Error ? e.message : "Failed to load change detail."
      )
    } finally {
      setDetailLoading(false)
    }
  }

  // Empty / disabled states ---------------------------------------------------

  if (!projectPath) {
    return (
      <div className="p-6 space-y-6">
        <Header />
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a project to compare branches.
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!isGitRepo) {
    return (
      <div className="p-6 space-y-6">
        <Header />
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            The selected project is not a git repository — branch comparison is
            only available for git-backed projects.
          </CardContent>
        </Card>
      </div>
    )
  }

  // We deliberately do NOT early-return when there are < 2 branches.
  // Hiding the dropdowns made the page look broken (just a "0 branches"
  // tile). Render the selectors regardless and surface an actionable
  // hint card below — the user can still see what's selected and try
  // refreshing branches.
  const tooFewBranches = branchOptions.length < 2

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Branch Compare</h1>
          <p className="text-muted-foreground">
            Compare changes between branches via real git diff
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onRefreshBranches && (
            <Button
              variant="outline"
              onClick={() => onRefreshBranches({ expand: true })}
              disabled={loading}
              title="Re-fetch branches and widen the remote refspec for shallow clones"
            >
              Refresh branches
            </Button>
          )}
          <Button
            onClick={runComparison}
            disabled={
              loading ||
              scanLoading ||
              tooFewBranches ||
              !baseBranch ||
              !targetBranch
            }
            title="Diff the branches AND re-scan both for security/quality findings"
          >
            {loading || scanLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Comparing…
              </>
            ) : (
              "Run Deep Comparison"
            )}
          </Button>
          {(() => {
            // We don't pre-disable for "target is main/master" — the
            // dialog renders a clearer hard-block reason than a tooltip.
            // Hard disable only when there's literally nothing to open
            // a dialog about (no project, not a git repo, no target
            // branch picked).
            const targetIsDefault =
              !!targetBranch &&
              (targetBranch.toLowerCase() === "main" ||
                targetBranch.toLowerCase() === "master")
            return (
              <Button
                variant="outline"
                onClick={() => setCreatePrOpen(true)}
                disabled={!projectPath || !isGitRepo || !targetBranch}
                title={
                  !projectPath
                    ? "Open a project to create a PR"
                    : !targetBranch
                      ? "Pick a target branch first"
                      : targetIsDefault
                        ? `Target '${targetBranch}' is the default branch — open the dialog for next steps.`
                        : `Open a PR from '${targetBranch}' into '${baseBranch}'`
                }
              >
                <GitPullRequest className="h-4 w-4 mr-2" />
                Create PR from this branch
              </Button>
            )
          })()}
        </div>
      </div>

      {projectPath && targetBranch && (
        <CreatePrDialog
          open={createPrOpen}
          onOpenChange={setCreatePrOpen}
          projectPath={projectPath}
          headBranch={targetBranch}
          baseBranchHint={baseBranch || null}
          branches={branches}
        />
      )}

      <Card className="bg-card border-border">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-sm text-muted-foreground mb-2 block">Base Branch</label>
              <Select value={baseBranch} onValueChange={setBaseBranch}>
                <SelectTrigger className="bg-secondary/50">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {branchOptions.map((b) => (
                    <SelectItem key={`base-${b.value}`} value={b.value}>
                      <span className="flex items-center gap-2">
                        {b.label}
                        {b.remote && (
                          <span className="text-[10px] text-muted-foreground">remote</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="h-5 w-5 text-muted-foreground mt-6" />
            <div className="flex-1">
              <label className="text-sm text-muted-foreground mb-2 block">Target Branch</label>
              <Select value={targetBranch} onValueChange={setTargetBranch}>
                <SelectTrigger className="bg-secondary/50">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {branchOptions.map((b) => (
                    <SelectItem key={`target-${b.value}`} value={b.value}>
                      <span className="flex items-center gap-2">
                        {b.label}
                        {b.remote && (
                          <span className="text-[10px] text-muted-foreground">remote</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {tooFewBranches && (
        <Card className="bg-card border-border border-yellow-500/30">
          <CardContent className="py-6 text-sm text-muted-foreground space-y-2">
            <p>
              {branchOptions.length === 0
                ? "No branches found in this repository yet."
                : `Only one branch detected (${branchOptions[0]?.label ?? "—"}). You need at least two branches to compare.`}
            </p>
            <p className="text-xs">
              If this repo was cloned shallow / single-branch, click{" "}
              <span className="font-medium">Refresh branches</span> above to
              widen the remote refspec and re-fetch.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Policy verdict for the comparison. Shown above the deep-compare
       *  panel so the user can see "block" / "warn" before scrolling
       *  through severity breakdowns. Falls back to the most-recent
       *  single-branch evaluation when no comparison has been run yet,
       *  so the page isn't empty before the user clicks Compare. */}
      {(policyResult || policyLoading) && (
        <PolicyStatusCard
          response={policyResult}
          loading={policyLoading}
          title="Policy decision (target branch vs base)"
        />
      )}
      {!policyResult && !policyLoading && currentPolicyResponse && (
        <PolicyStatusCard
          response={currentPolicyResponse}
          title="Policy decision (current scan)"
        />
      )}

      {/* Categorical comparison is the headline. It runs the same scan
       *  on both branches in parallel and groups deltas by check type
       *  (vulnerabilities, prompt quality, MCP, secrets, …). Heavier
       *  per-file detail lives inside, collapsed by default. */}
      {(scanLoading || scanResult || scanError) && (
        <ChecksComparisonPanel
          base={baseBranch}
          target={targetBranch}
          scanResult={scanResult}
          scanLoading={scanLoading}
          scanError={scanError}
        />
      )}

      {result ? (
        <>
          <ImpactSummary result={result} />

        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-base">Changes Detected</CardTitle>
                <CardDescription className="mt-1">
                  <span className="font-mono">
                    {result.base}@{result.baseSha.slice(0, 7)}
                  </span>{" "}
                  →{" "}
                  <span className="font-mono">
                    {result.target}@{result.targetSha.slice(0, 7)}
                  </span>
                </CardDescription>
              </div>
              <Badge variant="outline">
                {result.summary.total} change{result.summary.total === 1 ? "" : "s"}
              </Badge>
            </div>
            {/* Category chips double as filter buttons. Click a category
             * to scope the file list; click again or click "All" to
             * clear. Only categories with at least one file are shown. */}
            <div className="flex items-center flex-wrap gap-2 pt-3">
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className={`text-xs rounded-md px-2 py-0.5 border ${
                  categoryFilter === "all"
                    ? "bg-foreground/10 border-foreground/30 text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-secondary/30"
                }`}
              >
                All ({result.summary.total})
              </button>
              {(Object.entries(result.summary.byCategory) as [
                GitChangeCategory,
                number,
              ][])
                .filter(([, n]) => n > 0)
                .sort(([, a], [, b]) => b - a)
                .map(([cat, n]) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() =>
                      setCategoryFilter(categoryFilter === cat ? "all" : cat)
                    }
                    className={`text-xs rounded-md px-2 py-0.5 border ${
                      categoryFilter === cat
                        ? `${CATEGORY_BADGE_CLASS[cat]}`
                        : "border-border/60 text-muted-foreground hover:bg-secondary/30"
                    }`}
                  >
                    {CATEGORY_LABEL[cat]} ({n})
                  </button>
                ))}
            </div>
          </CardHeader>
          <CardContent>
            {result.files.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No file differences between these branches.
              </div>
            ) : (
              <div className="space-y-2">
                {result.files
                  .filter(
                    (c) =>
                      categoryFilter === "all" || c.category === categoryFilter
                  )
                  .slice(0, 200) // hard cap; huge diffs (7k files) crush the DOM
                  .map((change) => (
                    <button
                      type="button"
                      key={`${change.path}-${change.status}`}
                      onClick={() => openDetail(change)}
                      className="w-full text-left p-3 rounded-lg bg-secondary/20 border border-border hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge
                              variant="outline"
                              className={CATEGORY_BADGE_CLASS[change.category]}
                            >
                              {CATEGORY_LABEL[change.category]}
                            </Badge>
                            {statusBadge(change.status)}
                            <span className="font-mono text-sm text-muted-foreground truncate">
                              {change.path}
                            </span>
                          </div>
                          {change.oldPath && change.oldPath !== change.path && (
                            <p className="text-xs text-muted-foreground font-mono">
                              renamed from {change.oldPath}
                            </p>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
                      </div>
                    </button>
                  ))}
                {(() => {
                  const filtered = result.files.filter(
                    (c) =>
                      categoryFilter === "all" || c.category === categoryFilter
                  )
                  if (filtered.length > 200) {
                    return (
                      <div className="text-xs text-muted-foreground text-center pt-2">
                        Showing first 200 of {filtered.length} files — narrow
                        with category filter above to see more.
                      </div>
                    )
                  }
                  return null
                })()}
              </div>
            )}
          </CardContent>
        </Card>
        </>
      ) : !loading && !tooFewBranches ? (
        <Card className="bg-card border-border">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Pick a base and target branch, then run the comparison.
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={detailFile !== null} onOpenChange={(o) => !o && setDetailFile(null)}>
        <DialogContent className="sm:max-w-[760px] flex flex-col max-h-[85vh] p-0">
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
            <DialogTitle className="font-mono text-base break-all">
              {detailFile?.path ?? ""}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${STATUS_LABEL[detail.status]} · ${CATEGORY_LABEL[detail.category]} · ${detail.base} → ${detail.target}`
                : detailFile
                ? `${STATUS_LABEL[detailFile.status]} · ${CATEGORY_LABEL[detailFile.category]}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">
            {detailLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
              </div>
            )}

            {detailError && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{detailError}</span>
              </div>
            )}

            {detail && (
              <>
                <section>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Why it may matter
                  </div>
                  <p className="text-sm text-foreground/90">{detail.why}</p>
                </section>
                <section>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center justify-between">
                    <span>Diff</span>
                    {detail.truncated && (
                      <span className="text-[10px] text-muted-foreground/70 normal-case">
                        truncated
                      </span>
                    )}
                  </div>
                  <ScrollArea className="max-h-[50vh] rounded-md border border-border/60 bg-secondary/10">
                    <pre className="text-xs font-mono p-3 leading-relaxed whitespace-pre overflow-x-auto">
                      {detail.diff || "(no textual diff — likely a binary file)"}
                    </pre>
                  </ScrollArea>
                </section>
              </>
            )}
          </div>

          <DialogFooter className="px-6 py-3 border-t border-border/50 shrink-0">
            <Button variant="outline" onClick={() => setDetailFile(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Branch Compare</h1>
      <p className="text-muted-foreground">
        Compare changes between branches via real git diff
      </p>
    </div>
  )
}

/**
 * Categorical impact summary — derived purely from the diff (no scan).
 *
 * Shows total + by-status counts on the left, and per-category buckets
 * with a one-line "what to re-check" hint on the right. This is the
 * "fast" insight: it doesn't tell you whether a change improved or
 * regressed security, only what categories of risk it touched.
 */
function ImpactSummary({ result }: { result: GitCompareResponse }) {
  const total = result.summary.total
  const added = result.summary.byStatus.A
  const modified = result.summary.byStatus.M
  const deleted = result.summary.byStatus.D
  const renamed =
    result.summary.byStatus.R + result.summary.byStatus.C
  const categories = (Object.entries(result.summary.byCategory) as [
    GitChangeCategory,
    number,
  ][])
    .filter(([, n]) => n > 0)
    .sort(([, a], [, b]) => b - a)

  if (total === 0) return null

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">File Change Impact</CardTitle>
        <CardDescription>
          Heuristic breakdown from the file diff — what categories of code
          moved between branches. The deep security comparison above shows
          the actual findings delta.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Totals + status breakdown */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Totals
            </div>
            <div className="text-3xl font-bold">{total.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">
              files changed
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-2 text-xs">
              {added > 0 && (
                <Badge
                  variant="outline"
                  className="bg-green-500/10 text-green-400 border-green-500/20"
                >
                  +{added.toLocaleString()} added
                </Badge>
              )}
              {modified > 0 && (
                <Badge variant="outline" className="border-border/60">
                  ~{modified.toLocaleString()} modified
                </Badge>
              )}
              {deleted > 0 && (
                <Badge
                  variant="outline"
                  className="bg-red-500/10 text-red-400 border-red-500/20"
                >
                  −{deleted.toLocaleString()} deleted
                </Badge>
              )}
              {renamed > 0 && (
                <Badge variant="outline" className="border-border/60">
                  {renamed.toLocaleString()} renamed
                </Badge>
              )}
            </div>
          </div>

          {/* Category bars */}
          <div className="md:col-span-2 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Categories Affected
            </div>
            {categories.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No categorisable changes.
              </div>
            ) : (
              <div className="space-y-2">
                {categories.map(([cat, n]) => {
                  const pct = total > 0 ? (n / total) * 100 : 0
                  return (
                    <div key={cat} className="text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={CATEGORY_BADGE_CLASS[cat]}
                          >
                            {CATEGORY_LABEL[cat]}
                          </Badge>
                          <span className="text-muted-foreground">
                            {CATEGORY_HINT[cat]}
                          </span>
                        </span>
                        <span className="font-mono text-muted-foreground shrink-0">
                          {n.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            cat === "code"
                              ? "bg-muted-foreground/40"
                              : cat === "prompt"
                              ? "bg-purple-500"
                              : cat === "tool"
                              ? "bg-blue-500"
                              : cat === "schema"
                              ? "bg-cyan-500"
                              : cat === "mcp"
                              ? "bg-orange-500"
                              : "bg-yellow-500"
                          }`}
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Maps a scanner category (the human-readable string the rule emits)
 * to a display label, an icon, and an accent colour. Keeps the per-
 * category rows visually distinct so the user can scan for "Prompt
 * Quality" or "MCP Servers" at a glance.
 *
 * Categories not listed here fall back to a neutral icon and the raw
 * label — better than hiding a real signal because we forgot to map it.
 */
const CATEGORY_PROFILE: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tint: string }
> = {
  "Weak prompt": {
    label: "Prompt Quality",
    icon: MessageSquare,
    tint: "text-purple-400",
  },
  "Prompt injection": {
    label: "Prompt Injection",
    icon: ShieldAlert,
    tint: "text-pink-400",
  },
  "MCP configuration": {
    label: "MCP Server Definitions",
    icon: Network,
    tint: "text-orange-400",
  },
  OpenAPI: {
    label: "OpenAPI / Tool Schemas",
    icon: FileJson,
    tint: "text-cyan-400",
  },
  "Dangerous tool / side effect": {
    label: "Dangerous Tools",
    icon: Wrench,
    tint: "text-red-400",
  },
  "Missing approval gate": {
    label: "Approval Gates",
    icon: ShieldCheck,
    tint: "text-yellow-400",
  },
  "Hardcoded secret": {
    label: "Hardcoded Secrets",
    icon: Lock,
    tint: "text-amber-400",
  },
  Dependencies: {
    label: "Dependency Risks",
    icon: Package,
    tint: "text-yellow-400",
  },
  "Data flow": {
    label: "Unsafe Data Flow",
    icon: Workflow,
    tint: "text-blue-400",
  },
}

function categoryProfile(name: string) {
  return (
    CATEGORY_PROFILE[name] ?? {
      label: name,
      icon: Activity,
      tint: "text-muted-foreground",
    }
  )
}

/**
 * Compact "what changed by check" panel. The previous version showed a
 * separate big "Deep Security Comparison" card with risk tiles, severity
 * tiles, and a bulky per-file section above the categorical view. The
 * user asked for less heaviness, so we collapse everything into one
 * panel with this hierarchy:
 *
 *   1. One-line headline: risk score delta + verdict (improved / regressed
 *      / no change). Severity deltas inline as small chips.
 *   2. Per-check rows (Prompt Quality, Dangerous Tools, MCP, …) — the
 *      thing the user actually asked to focus on.
 *   3. Per-file attribution tucked behind a "Show files that moved
 *      these checks" disclosure so it stays out of the way unless asked.
 */
function ChecksComparisonPanel({
  base,
  target,
  scanResult,
  scanLoading,
  scanError,
}: {
  base: string
  target: string
  scanResult: GitCompareScanResponse | null
  scanLoading: boolean
  scanError: string | null
}) {
  const [showFiles, setShowFiles] = useState(false)

  const riskDelta = scanResult?.delta?.risk ?? 0
  const totalDelta = scanResult?.delta?.total ?? 0
  const direction =
    riskDelta < 0 ? "improvement" : riskDelta > 0 ? "regression" : "neutral"
  const directionIcon =
    direction === "improvement" ? (
      <TrendingDown className="h-4 w-4 text-green-400" />
    ) : direction === "regression" ? (
      <TrendingUp className="h-4 w-4 text-red-400" />
    ) : (
      <Minus className="h-4 w-4 text-muted-foreground" />
    )
  const directionColor =
    direction === "improvement"
      ? "text-green-400"
      : direction === "regression"
      ? "text-red-400"
      : "text-muted-foreground"

  const categories = scanResult?.byCategory ?? []
  const improvedCount = categories.filter((c) => c.delta < 0).length
  const regressedCount = categories.filter((c) => c.delta > 0).length

  // Which scanner-backed checks ran but never produced a finding on
  // either branch. We show these in a tiny footer so the user can see
  // full coverage without us adding an empty row per clean check.
  // Lookup table: scanner rule_id → user-facing label (drops to the
  // raw id if SECURITY_CHECKS hasn't been kept in sync).
  const checkLabelById = new Map(SECURITY_CHECKS.map((c) => [c.id, c.label]))
  const seenRuleIds = new Set<string>()
  for (const c of categories) for (const r of c.ruleIds) seenRuleIds.add(r)
  const cleanCheckIds = SCANNER_RULE_IDS.filter((id) => !seenRuleIds.has(id))

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-orange-400" />
              Checks Comparison
              {scanLoading && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </CardTitle>
            <CardDescription className="mt-1 truncate">
              Same checks run on{" "}
              <span className="font-mono">{base}</span> and{" "}
              <span className="font-mono">{target}</span> — vulnerabilities,
              prompt quality, MCP, secrets, …
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {scanError && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{scanError}</span>
          </div>
        )}

        {scanLoading && !scanResult && (
          <div className="py-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Scanning both branches in parallel…
          </div>
        )}

        {scanResult?.sameSha && (
          <p className="text-sm text-muted-foreground py-2">
            Both branches point at the same commit — no findings to compare.
          </p>
        )}

        {scanResult && !scanResult.sameSha && scanResult.delta && (
          <>
            {/* Compact headline row: verdict + risk + total + severity chips */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                {directionIcon}
                <span className={`font-semibold capitalize ${directionColor}`}>
                  {direction}
                </span>
              </div>
              <InlineDelta
                label="risk"
                base={scanResult.baseScan?.risk_score ?? 0}
                target={scanResult.targetScan?.risk_score ?? 0}
                delta={scanResult.delta.risk}
                lowerIsBetter
              />
              <InlineDelta
                label="findings"
                base={scanResult.baseScan?.summary.total ?? 0}
                target={scanResult.targetScan?.summary.total ?? 0}
                delta={totalDelta}
                lowerIsBetter
              />
              <div className="flex items-center gap-1.5 text-xs">
                <SeverityChip label="C" delta={scanResult.delta.critical} />
                <SeverityChip label="H" delta={scanResult.delta.high} />
                <SeverityChip label="M" delta={scanResult.delta.medium} />
                <SeverityChip label="L" delta={scanResult.delta.low} />
              </div>
              <span className="text-xs text-muted-foreground">
                {scanResult.fixedTotal ?? scanResult.fixed.length} fixed ·{" "}
                {scanResult.introducedTotal ?? scanResult.introduced.length}{" "}
                introduced · {scanResult.persistent} persistent
              </span>
            </div>

            {/* Per-check rows — the focus of this panel */}
            {categories.length > 0 ? (
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                  <span>By check</span>
                  <span>
                    {improvedCount} improved · {regressedCount} regressed
                  </span>
                </div>
                <div className="rounded-lg border border-border/60 divide-y divide-border/30">
                  {categories.map((c) => (
                    <CategoryRow key={c.category} cat={c} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No findings on either branch — nothing to compare by check.
              </p>
            )}

            {/* Per-file attribution — collapsed by default to keep the
             * panel light. Disclosure shows it when the user asks. */}
            {scanResult.perFile &&
              (scanResult.perFile.improversTotal +
                scanResult.perFile.regressorsTotal +
                scanResult.perFile.mixedTotal) >
                0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowFiles((v) => !v)}
                    className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
                    aria-expanded={showFiles}
                  >
                    <ChevronRight
                      className={`h-3 w-3 transition-transform ${
                        showFiles ? "rotate-90" : ""
                      }`}
                    />
                    {showFiles ? "Hide" : "Show"} files that moved these checks
                  </button>
                  {showFiles && (
                    <div className="mt-3">
                      <PerFileImpactSection
                        perFile={scanResult.perFile}
                        totalDelta={totalDelta}
                      />
                    </div>
                  )}
                </div>
              )}

            {/* Coverage footer: shows which checks were clean on both
             *  branches. Compact one-liner so the user knows we ran
             *  every check and these simply had no findings. */}
            {cleanCheckIds.length > 0 && (
              <div className="text-[11px] text-muted-foreground">
                <span className="text-green-400">✓ Clean on both branches: </span>
                {cleanCheckIds
                  .map((id) => checkLabelById.get(id) ?? id)
                  .join(" · ")}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Quality metrics like accuracy / latency / tool-selection need
              a real eval runner; this panel only attributes what the
              scanner can verify statically.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Compact inline "label: base → target ±delta" stat used in the
 *  headline row. Replaces the chunky DeltaTile cards. */
function InlineDelta({
  label,
  base,
  target,
  delta,
  lowerIsBetter,
}: {
  label: string
  base: number
  target: number
  delta: number
  lowerIsBetter?: boolean
}) {
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0
  const isRegression = lowerIsBetter ? delta > 0 : delta < 0
  const color = isImprovement
    ? "text-green-400"
    : isRegression
    ? "text-red-400"
    : "text-muted-foreground"
  const sign = delta > 0 ? "+" : ""
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span className="text-muted-foreground">{base}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span className="font-semibold text-sm">{target}</span>
      <span className={`font-medium ${color}`}>
        ({sign}
        {delta})
      </span>
    </div>
  )
}

/** Single-letter severity chip (C/H/M/L) with the delta. Keeps the
 *  severity breakdown legible without taking a whole row. */
function SeverityChip({ label, delta }: { label: string; delta: number }) {
  const isImprovement = delta < 0
  const isRegression = delta > 0
  const color = isImprovement
    ? "text-green-400 border-green-500/30 bg-green-500/10"
    : isRegression
    ? "text-red-400 border-red-500/30 bg-red-500/10"
    : "text-muted-foreground border-border/60 bg-secondary/30"
  const sign = delta > 0 ? "+" : ""
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-medium ${color}`}
      title={`${label} severity: ${sign}${delta}`}
    >
      {label}
      {sign}
      {delta}
    </span>
  )
}

/**
 * Single per-check row inside the Checks Comparison panel.
 * Compact, one-liner with: icon · check name · base→target counts ·
 * verdict pill · top fixing/regressing file as a hint.
 *
 * Replaces the bigger card grid so 9 categories fit on one screen
 * without dominating the page.
 */
function CategoryRow({ cat }: { cat: CategoryImpact }) {
  const profile = categoryProfile(cat.category)
  const Icon = profile.icon
  const isImprovement = cat.delta < 0
  const isRegression = cat.delta > 0
  // A brand-new category (base 0, target > 0) is treated as a regression
  // for verdict purposes, but we render "New" instead of an arbitrary %.
  const isNew = cat.baseCount === 0 && cat.targetCount > 0
  const deltaColor = isImprovement
    ? "text-green-400"
    : isRegression
    ? "text-red-400"
    : "text-muted-foreground"
  const deltaSign = cat.delta > 0 ? "+" : ""
  const verdictTint = isImprovement
    ? "bg-green-500/10 text-green-400 border-green-500/20"
    : isRegression
    ? "bg-red-500/10 text-red-400 border-red-500/20"
    : "bg-secondary text-muted-foreground border-border/60"
  const verdictLabel = isImprovement
    ? "Improved"
    : isRegression
    ? isNew
      ? "New"
      : "Regressed"
    : "Unchanged"

  // Pretty percent string: "−43%" / "+12%" / "0%" / "—" (when undefined).
  // Keep tight; this column lives in a single line so we round to 0
  // decimals once magnitude is ≥10 to avoid "−43.3%" noise.
  let pctLabel: string
  if (cat.pctDelta == null) {
    pctLabel = "—"
  } else {
    const abs = Math.abs(cat.pctDelta)
    const rounded = abs >= 10 ? Math.round(abs) : Math.round(abs * 10) / 10
    const signed =
      cat.pctDelta > 0 ? `+${rounded}` : cat.pctDelta < 0 ? `−${rounded}` : "0"
    pctLabel = `${signed}%`
  }

  // Pick the most-impactful file as a hint without dumping the full list.
  const topImproved = cat.filesImproved[0]
  const topRegressed = cat.filesRegressed[0]

  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${profile.tint}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{profile.label}</span>
          <span className="text-xs text-muted-foreground">
            {cat.baseCount} → {cat.targetCount}
          </span>
          <span className={`text-xs font-semibold ${deltaColor}`}>
            {deltaSign}
            {cat.delta}
          </span>
          {/* Percent change pill — the metric the user actually wants.
           *  Hidden for the "Unchanged + 0%" trivial case to keep noise
           *  down; shown for everything else including "New" categories
           *  (label '—'). */}
          {!(cat.delta === 0 && pctLabel === "0%") && (
            <span
              className={`text-[11px] font-medium rounded px-1.5 py-0.5 border ${
                isImprovement
                  ? "bg-green-500/10 text-green-400 border-green-500/20"
                  : isRegression
                  ? "bg-red-500/10 text-red-400 border-red-500/20"
                  : "bg-secondary text-muted-foreground border-border/60"
              }`}
              title={
                cat.pctDelta == null
                  ? "Brand-new category — no base to compute % from"
                  : `${cat.pctDelta}% change vs base`
              }
            >
              {pctLabel}
            </span>
          )}
          {/* Suppress the "X fixed · Y introduced" suffix when it's
           *  almost certainly cap churn (delta 0, equal counts).
           *  Otherwise show the breakdown — that's the only real signal
           *  for net-zero categories that DID move things around. */}
          {!cat.cappedChurn && (cat.fixedCount > 0 || cat.introducedCount > 0) && (
            <span className="text-[11px] text-muted-foreground">
              · {cat.fixedCount} fixed · {cat.introducedCount} introduced
            </span>
          )}
        </div>
        {/* Per-file hints — only render the bucket that actually moved
         *  the needle. A 0-delta capped-churn category gets neither
         *  hint, since "improved by X · regressed by X" would be
         *  misleading. */}
        {(isImprovement || isRegression) && (topImproved || topRegressed) && (
          <div className="mt-1 text-[11px] text-muted-foreground space-y-0.5">
            {isImprovement && topImproved && (
              <div className="truncate" title={topImproved.file}>
                <span className="text-green-400">↓ improved by </span>
                <span className="font-mono">{topImproved.file}</span>
                {cat.filesImproved.length > 1 && (
                  <span> +{cat.filesImproved.length - 1}</span>
                )}
              </div>
            )}
            {isRegression && topRegressed && (
              <div className="truncate" title={topRegressed.file}>
                <span className="text-red-400">↑ regressed by </span>
                <span className="font-mono">{topRegressed.file}</span>
                {cat.filesRegressed.length > 1 && (
                  <span> +{cat.filesRegressed.length - 1}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <Badge variant="outline" className={`${verdictTint} shrink-0`}>
        {verdictLabel}
      </Badge>
    </div>
  )
}

/**
 * Per-file attribution view: tells the user *which files* moved each
 * metric. Files are bucketed into Improved / Regressed / Mixed and
 * sorted by absolute risk impact so the biggest movers show first.
 */
function PerFileImpactSection({
  perFile,
  totalDelta,
}: {
  perFile?: GitCompareScanResponse["perFile"]
  totalDelta: number
}) {
  if (!perFile) return null
  const { improvers, regressors, mixed } = perFile

  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Per-file impact ·{" "}
        <span className="normal-case text-muted-foreground/80">
          attributed by file path of each finding
        </span>
      </div>

      <PerFileBucket
        title="Files that improved security"
        icon={<ShieldCheck className="h-4 w-4 text-green-400" />}
        tone="good"
        rows={improvers}
        total={perFile.improversTotal}
        emptyText={
          totalDelta > 0
            ? "No files removed findings — every change net-added risk."
            : "No files in this bucket."
        }
      />

      <PerFileBucket
        title="Files that regressed security"
        icon={<ShieldAlert className="h-4 w-4 text-red-400" />}
        tone="bad"
        rows={regressors}
        total={perFile.regressorsTotal}
        emptyText="No files introduced new findings — pure improvement."
      />

      <PerFileBucket
        title="Files with mixed impact"
        icon={<TrendingUp className="h-4 w-4 text-yellow-400" />}
        tone="neutral"
        rows={mixed}
        total={perFile.mixedTotal}
        emptyText="No files have both fixes and regressions."
      />
    </div>
  )
}

function PerFileBucket({
  title,
  icon,
  tone,
  rows,
  total,
  emptyText,
}: {
  title: string
  icon: React.ReactNode
  tone: "good" | "bad" | "neutral"
  rows: PerFileImpact[]
  total: number
  emptyText: string
}) {
  const borderClass =
    tone === "good"
      ? "border-green-500/20"
      : tone === "bad"
      ? "border-red-500/20"
      : "border-yellow-500/20"
  return (
    <div className={`rounded-lg border ${borderClass} bg-secondary/10`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        <Badge variant="outline" className="border-border/60">
          {total}
        </Badge>
      </div>
      <div className="divide-y divide-border/30 max-h-72 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {emptyText}
          </div>
        ) : (
          rows.map((r) => <PerFileRow key={r.file} row={r} />)
        )}
      </div>
      {total > rows.length && (
        <div className="text-xs text-muted-foreground text-center px-3 py-2 border-t border-border/40">
          Showing top {rows.length} of {total} (sorted by risk impact).
        </div>
      )}
    </div>
  )
}

function PerFileRow({ row }: { row: PerFileImpact }) {
  const fixedBySev = countBySeverity(row.fixed)
  const introducedBySev = countBySeverity(row.introduced)
  const riskColor =
    row.riskDelta < 0
      ? "text-green-400"
      : row.riskDelta > 0
      ? "text-red-400"
      : "text-muted-foreground"
  const riskSign = row.riskDelta > 0 ? "+" : ""
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-xs text-foreground/90 truncate"
            title={row.file}
          >
            {row.file}
          </div>
          {/* Severity-grouped fixed/introduced summary, e.g.
           *   Fixed: 1 critical, 2 high · Introduced: 1 medium */}
          <div className="text-xs mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {row.fixed.length > 0 && (
              <span className="text-green-400">
                Fixed: {summarizeBySeverity(fixedBySev)}
              </span>
            )}
            {row.introduced.length > 0 && (
              <span className="text-red-400">
                Introduced: {summarizeBySeverity(introducedBySev)}
              </span>
            )}
            {row.linesAdded > 0 || row.linesDeleted > 0 ? (
              <span className="text-muted-foreground">
                <span className="text-green-400/80">
                  +{row.linesAdded}
                </span>{" "}
                <span className="text-red-400/80">−{row.linesDeleted}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            risk
          </div>
          <div className={`text-sm font-semibold ${riskColor}`}>
            {riskSign}
            {row.riskDelta}
          </div>
        </div>
      </div>
    </div>
  )
}

function countBySeverity(
  fs: PerFileImpact["fixed"]
): Record<"critical" | "high" | "medium" | "low", number> {
  const o = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of fs) o[f.severity] += 1
  return o
}

function summarizeBySeverity(
  c: ReturnType<typeof countBySeverity>
): string {
  const parts: string[] = []
  if (c.critical) parts.push(`${c.critical} critical`)
  if (c.high) parts.push(`${c.high} high`)
  if (c.medium) parts.push(`${c.medium} medium`)
  if (c.low) parts.push(`${c.low} low`)
  return parts.join(", ") || "—"
}
