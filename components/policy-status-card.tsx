"use client"

/**
 * PolicyStatusCard renders the result of `evaluatePolicy(...)` in a
 * compact card that's reused across:
 *   - Overview (full variant, after each scan)
 *   - Branch Compare (full variant, after deep compare)
 *   - Commit / Push dialogs (compact variant, inline above the action
 *     buttons)
 *
 * It is a pure render component: callers pass in either a
 * `PolicyApiResponse` (preferred — gives source/errors metadata) or
 * just an evaluation. Loading and error states are first-class so
 * dialogs can show "Evaluating policy…" while a scan is running.
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileWarning,
  GitBranch,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import {
  decisionBadgeClass,
  decisionLabel,
  type Decision,
  type Policy,
  type PolicyEvaluation,
} from "@/lib/policy"
import type { PolicyApiResponse } from "@/lib/policy-client"

interface PolicyStatusCardProps {
  /** Full server response when available — preferred so we can show
   * `policySource` and any parse errors. */
  response?: PolicyApiResponse | null
  /** When you only have an evaluation (e.g. mid-flight on the client),
   * pass this directly. `response` wins if both are supplied. */
  evaluation?: PolicyEvaluation | null
  policy?: Policy | null
  loading?: boolean
  error?: string | null
  /** Smaller variant for dialogs. */
  compact?: boolean
  /** Optional title override for the card header. */
  title?: string
  /** Callback to force a fresh scan of the base branch (the gate's
   *  comparison baseline). When provided, the card renders a small
   *  "Re-scan main" button so users can recover from a stale baseline
   *  without restarting the dev server or hand-editing the cache. */
  onRefreshBaseline?: () => void
  /** True while a refresh is in flight — disables the button and
   *  shows a spinner. */
  refreshing?: boolean
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

function decisionIcon(d: Decision) {
  switch (d) {
    case "pass":
      return <ShieldCheck className="h-4 w-4 text-green-400" />
    case "warn":
      return <AlertTriangle className="h-4 w-4 text-yellow-400" />
    case "block":
      return <ShieldAlert className="h-4 w-4 text-red-400" />
    case "auto_merge_allowed":
      return <CheckCircle2 className="h-4 w-4 text-blue-400" />
  }
}

function deltaCell(label: string, n: number | null, invertSign = false) {
  if (n == null) return null
  const goodWhenNegative = !invertSign
  const isImprovement = goodWhenNegative ? n < 0 : n > 0
  const isRegression = goodWhenNegative ? n > 0 : n < 0
  const cls = isRegression
    ? "text-red-400"
    : isImprovement
      ? "text-green-400"
      : "text-muted-foreground"
  const sign = n > 0 ? "+" : ""
  return (
    <span className={`text-xs font-mono ${cls}`}>
      {label} {sign}
      {n}
    </span>
  )
}

export function PolicyStatusCard({
  response,
  evaluation: rawEvaluation,
  policy: rawPolicy,
  loading = false,
  error = null,
  compact = false,
  title,
  onRefreshBaseline,
  refreshing = false,
}: PolicyStatusCardProps) {
  const [showWhy, setShowWhy] = useState(false)
  const [showErrors, setShowErrors] = useState(false)

  const evaluation = response?.evaluation ?? rawEvaluation ?? null
  const policy = response?.policy ?? rawPolicy ?? null
  const policySource = response?.policySource ?? null
  const policyErrors = response?.policyErrors ?? []
  const policyPath = response?.policyPath ?? null
  // Baseline disclosure — what we compared against. Comes from the
  // server's `baseSource`/`baseBranch`/`baseSha`/`baseCachedAt` fields.
  // Renders as "Compared against main@abc1234 · scanned 5m ago · risk 87"
  // so a user looking at "block" knows exactly which two states the
  // gate diffed (vs the deeply confusing "this scan shows 100, why
  // is it complaining about 87?" question that drove this addition).
  const baseSource = response?.baseSource ?? null
  const baseBranch = response?.baseBranch ?? null
  const baseShaShort = shortSha(response?.baseSha)
  const baseCachedAtRel = formatRelative(response?.baseCachedAt)
  const baseRiskScore = response?.baseRiskScore ?? null
  const baseSummary = response?.baseSummary ?? null
  // Dirty-tree disclosure. Three kinds of working-tree state, each
  // handled differently:
  //
  // 1. Tracked-modified files (`modified > 0`): real edits on the
  //    current branch. Included in scan; *do* skew comparison vs
  //    base. Warn loudly.
  // 2. Untracked files: every untracked file in the working tree is
  //    now scanned regardless of which branch attribution thinks
  //    it came from. They all skew comparison vs base. Warn loudly
  //    alongside (1). The cross-branch counter is reported only as
  //    an informational hint ("of N untracked, M came from `low`")
  //    so the user knows where leaked files originated.
  // 3. Blanket opt-out (`untracked_excluded_from_scan === true`):
  //    all untracked files skipped (pre-commit gate). Quiet
  //    heads-up only.
  const targetWt = response?.targetWorkingTree ?? null
  // Stash scans synthesise a working_tree object from a temp worktree,
  // not from the user's actual tree. Suppress all dirty-tree warnings
  // in that case — they'd be misleading (the warnings refer to "your
  // working tree on disk" but a stash scan didn't look at it).
  const isStashScan = targetWt?.stash_scan === true
  const trackedModified = isStashScan ? 0 : targetWt?.modified ?? 0
  const blanketOptOut =
    !isStashScan && targetWt?.untracked_excluded_from_scan === true
  const crossBranchAttributed = isStashScan
    ? 0
    : targetWt?.untracked_attributed_other_branch_count ?? 0
  // Total untracked count seen by the scanner (zero when the
  // blanket opt-out is in effect).
  const untrackedScanned = isStashScan
    ? 0
    : blanketOptOut
      ? 0
      : targetWt?.untracked ?? 0
  // Untracked files explicitly skipped by the blanket opt-out.
  const untrackedBlanketExcluded = blanketOptOut
    ? targetWt?.untracked ?? 0
    : 0
  const treeIsDirty = trackedModified > 0 || untrackedScanned > 0
  const crossBranchName = isStashScan
    ? null
    : targetWt?.untracked_attributed_other_branches?.[0]?.branch ?? null

  /* ------------------------------- Loading ------------------------------- */

  if (loading) {
    return (
      <Card className={compact ? "bg-secondary/20 border-border" : "bg-card border-border"}>
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
            Evaluating policy…
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------- Error -------------------------------- */

  if (error) {
    return (
      <Card className="bg-card border-border">
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center gap-2 text-sm text-red-400">
            <XCircle className="h-4 w-4" />
            Policy evaluation failed: {error}
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------- Empty -------------------------------- */

  if (!evaluation) {
    return (
      <Card className="bg-card border-border">
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileWarning className="h-4 w-4" />
              {policy
                ? policySource === "file"
                  ? `Policy loaded from ${policyPath ?? ".edgeagent/policy.yaml"} — run a scan to evaluate.`
                  : "Using default policy — run a scan to evaluate."
                : "No policy evaluated yet."}
            </div>
            {policy?.mode && (
              <Badge variant="outline" className="text-[10px]">
                mode: {policy.mode}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  /* ------------------------------ Populated ----------------------------- */

  const { decision, reasons, failedConditions, passedConditions, deltas } =
    evaluation
  const isBlock = decision === "block"
  const isWarn = decision === "warn"
  const isAuto = decision === "auto_merge_allowed"

  return (
    <Card className="bg-card border-border">
      <CardHeader className={compact ? "p-3 pb-1" : "pb-2"}>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            {decisionIcon(decision)}
            <span>{title ?? decisionLabel(decision)}</span>
            {(isWarn || isBlock || isAuto) && (
              <Badge
                variant="outline"
                className={`text-[10px] ${decisionBadgeClass(decision)}`}
              >
                {failedConditions.length > 0
                  ? `${failedConditions.length} ${
                      failedConditions.length === 1 ? "issue" : "issues"
                    }`
                  : isAuto
                    ? "all gates passed"
                    : "ok"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {policy?.mode && (
              <Badge variant="outline" className="text-[10px]">
                mode: {policy.mode}
              </Badge>
            )}
            {policySource && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {policySource === "file" ? ".edgeagent/policy.yaml" : "default"}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className={compact ? "p-3 pt-0 space-y-2" : "space-y-3"}>
        {/* Baseline disclosure — what the gate actually compared
            against. Tells the user "compared main@abc1234 (87) →
            yourBranch@workingTree (100)" so the verdict isn't
            mysterious. Includes a "Re-scan" button (when supplied)
            that bypasses the on-disk cache, useful when the user
            knows main moved or just wants certainty. */}
        {(baseSource === "base_branch" ||
          baseSource === "snapshot" ||
          baseSource === "none") && (
          <div className="rounded-md border border-border bg-secondary/10 p-2 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 min-w-0">
                <GitBranch className="h-3 w-3 shrink-0" />
                {baseSource === "none" ? (
                  <span>
                    No baseline available — only absolute rules apply
                    (delta rules need a base scan to compare against).
                  </span>
                ) : (
                  <span className="truncate">
                    Compared against{" "}
                    <span className="font-mono text-foreground">
                      {baseBranch ?? "?"}
                      {baseShaShort ? `@${baseShaShort}` : ""}
                    </span>
                    {baseSource === "snapshot" && (
                      <span className="ml-1 text-yellow-400">
                        (snapshot fallback)
                      </span>
                    )}
                    {baseRiskScore != null && (
                      <span className="ml-1 font-mono">
                        · risk {baseRiskScore}
                        {baseSummary &&
                          ` · ${baseSummary.critical}c/${baseSummary.high}h/${baseSummary.medium}m/${baseSummary.low}l`}
                      </span>
                    )}
                    {baseCachedAtRel && (
                      <span className="ml-1">· scanned {baseCachedAtRel}</span>
                    )}
                  </span>
                )}
              </div>
              {onRefreshBaseline && baseSource !== "none" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={onRefreshBaseline}
                  disabled={refreshing}
                  title="Force a fresh scan of the base branch, ignoring the on-disk cache."
                >
                  {refreshing ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-3 w-3 mr-1" />
                  )}
                  {refreshing ? "Re-scanning…" : `Re-scan ${baseBranch ?? "base"}`}
                </Button>
              )}
            </div>
            {baseSource === "snapshot" && (
              <div className="mt-1 text-yellow-400/80">
                Couldn&apos;t scan the base branch (no <code>main</code>{" "}
                /master, on the base branch itself, or scanner failed).
                Falling back to the last accepted commit&apos;s snapshot
                — accurate for &ldquo;you regressed since last commit&rdquo;
                but not for &ldquo;you regressed since main&rdquo;.
              </div>
            )}
          </div>
        )}

        {/* Dirty-tree warning — fires when the scan included
            uncommitted state (modified tracked files + every
            untracked file) that wouldn't exist in the base branch's
            HEAD. Cross-branch attributed files now also count
            toward this warning because they're scanned alongside
            everything else. */}
        {treeIsDirty && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-[11px] text-yellow-300">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                Scanned working tree has{" "}
                <span className="font-mono">
                  {trackedModified + untrackedScanned}
                </span>{" "}
                uncommitted file
                {trackedModified + untrackedScanned === 1 ? "" : "s"}
                {targetWt?.branch ? (
                  <>
                    {" on "}
                    <span className="font-mono text-foreground">
                      {targetWt.branch}
                    </span>
                  </>
                ) : null}
                {" "}(
                {trackedModified > 0 && (
                  <span className="font-mono">
                    +{trackedModified} modified
                  </span>
                )}
                {trackedModified > 0 && untrackedScanned > 0 && (
                  <span> · </span>
                )}
                {untrackedScanned > 0 && (
                  <span className="font-mono">
                    +{untrackedScanned} untracked
                    {crossBranchAttributed > 0 && crossBranchName
                      ? `, ${crossBranchAttributed} from ${crossBranchName}`
                      : ""}
                  </span>
                )}
                ), all included in the scan. Commit or stash them and
                re-scan to compare apples-to-apples against{" "}
                <span className="font-mono">
                  {baseBranch ?? "the base branch"}
                  {baseShaShort ? `@${baseShaShort}` : "@HEAD"}
                </span>
                .
              </div>
            </div>
          </div>
        )}

        {/* Stash-included heads-up. Fires when an in-place scan
            auto-folded EVERY stash on the current branch into the
            result (latest version of each file wins on conflicts).
            Quiet tone since this is "we did extra work for you",
            not a warning. */}
        {!isStashScan && targetWt?.stash_included && (() => {
          const stashCount =
            targetWt.stashes_included_count ??
            (targetWt.stashes_included?.length ?? 1)
          const fileCount = targetWt.stash_file_count ?? 0
          const fileWord = fileCount === 1 ? "file" : "files"
          return (
            <div className="rounded-md border border-blue-500/40 bg-blue-500/5 p-2 text-[11px] text-blue-200">
              <div className="flex items-start gap-1.5">
                <FileWarning className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div>
                  Scan also folded in{" "}
                  <span className="font-mono">{fileCount}</span> unique{" "}
                  {fileWord} from{" "}
                  {stashCount > 1 ? (
                    <>
                      <span className="font-mono">{stashCount}</span> stashes
                      on this branch (latest wins on per-file conflicts).
                      Findings include WIP from every stash plus the committed
                      code.
                      {targetWt.stashes_included &&
                        targetWt.stashes_included.length > 0 && (
                          <ul className="mt-1 pl-4 list-disc text-blue-100/80 font-mono text-[10px] space-y-0.5">
                            {targetWt.stashes_included.map((s) => (
                              <li key={s.ref} className="truncate">
                                {s.ref} — {s.message} ({s.file_count} file
                                {s.file_count === 1 ? "" : "s"})
                              </li>
                            ))}
                          </ul>
                        )}
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-foreground">
                        {targetWt.stash_ref ?? "stash@{0}"}
                      </span>
                      {targetWt.stash_message ? (
                        <>
                          {" — "}
                          <span className="text-blue-100/80 italic">
                            {targetWt.stash_message}
                          </span>
                        </>
                      ) : null}
                      . Findings include your stashed WIP alongside the
                      committed code.
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Blanket opt-out heads-up — only fires when a caller
            explicitly passed `includeUntracked: false` (pre-commit
            gate). All untracked files were skipped from this scan. */}
        {untrackedBlanketExcluded > 0 && (
          <div className="rounded-md border border-border bg-secondary/10 p-2 text-[11px] text-muted-foreground">
            <div className="flex items-start gap-1.5">
              <FileWarning className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <span className="font-mono">{untrackedBlanketExcluded}</span>{" "}
                untracked file{untrackedBlanketExcluded === 1 ? "" : "s"} in
                the working tree — skipped from this scan
                (<code>includeUntracked: false</code>).
              </div>
            </div>
          </div>
        )}

        {/* Headline reasons (top 3) */}
        {reasons.length > 0 && (
          <ul className="text-xs space-y-1">
            {reasons.slice(0, 3).map((r, i) => (
              <li
                key={i}
                className={`flex gap-2 ${
                  isBlock ? "text-red-300" : isWarn ? "text-yellow-300" : "text-muted-foreground"
                }`}
              >
                <span className="mt-0.5">•</span>
                <span>{r}</span>
              </li>
            ))}
            {reasons.length > 3 && !showWhy && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setShowWhy(true)}
                >
                  <ChevronRight className="h-3 w-3 mr-1" />
                  Show {reasons.length - 3} more
                </Button>
              </li>
            )}
            {showWhy &&
              reasons.slice(3).map((r, i) => (
                <li
                  key={`more-${i}`}
                  className="flex gap-2 text-muted-foreground"
                >
                  <span className="mt-0.5">•</span>
                  <span>{r}</span>
                </li>
              ))}
          </ul>
        )}

        {/* Delta strip */}
        {(deltas.risk != null ||
          deltas.critical != null ||
          deltas.high != null) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {deltaCell("risk", deltas.risk)}
            {deltaCell("critical", deltas.critical)}
            {deltaCell("high", deltas.high)}
            {deltaCell("medium", deltas.medium)}
            {deltaCell("low", deltas.low)}
          </div>
        )}

        {/* Per-agent deltas */}
        {Object.keys(deltas.perAgent).length > 0 && !compact && (
          <div className="rounded-md border border-border bg-secondary/10 p-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">
              Per-agent metric deltas
            </div>
            <div className="space-y-1">
              {Object.entries(deltas.perAgent).map(([agent, d]) => (
                <div
                  key={agent}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
                >
                  <span className="font-mono">{agent}</span>
                  {deltaCell("acc", d.accuracy != null ? +(d.accuracy * 100).toFixed(2) : null)}
                  {deltaCell("rt(ms)", d.runtime_ms, /* invert */ true)}
                  {deltaCell(
                    "tool",
                    d.tool_selection_pass_rate != null
                      ? +(d.tool_selection_pass_rate * 100).toFixed(2)
                      : null
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Passed conditions roll-up */}
        {!compact && passedConditions.length > 0 && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none flex items-center gap-1">
              <ChevronDown className="h-3 w-3" />
              {passedConditions.length} condition
              {passedConditions.length === 1 ? "" : "s"} passed
            </summary>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
              {passedConditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Inapplicable conditions roll-up */}
        {!compact && evaluation.inapplicableConditions.length > 0 && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none flex items-center gap-1">
              <ChevronDown className="h-3 w-3" />
              {evaluation.inapplicableConditions.length} condition
              {evaluation.inapplicableConditions.length === 1 ? "" : "s"} skipped
              (no base / no metrics)
            </summary>
            <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
              {evaluation.inapplicableConditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}

        {/* Policy file parse errors */}
        {policyErrors.length > 0 && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-[11px] text-yellow-300">
            <button
              type="button"
              className="flex items-center gap-1 font-medium"
              onClick={() => setShowErrors((v) => !v)}
            >
              {showErrors ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {policyErrors.length} policy.yaml warning
              {policyErrors.length === 1 ? "" : "s"}
            </button>
            {showErrors && (
              <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono">
                {policyErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
