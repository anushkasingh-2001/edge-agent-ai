"use client"

/**
 * Three confirmation dialogs that wrap the destructive git operations
 * surfaced by the top bar:
 *
 *   - PullConfirmDialog: refuses on uncommitted changes (server side too).
 *   - CommitDialog: requires a message; optional pre-commit scan gate.
 *   - PushConfirmDialog: optional pre-push scan gate.
 *
 * Each dialog runs the network call itself, shows inline status while
 * the request is in flight, and emits a Sonner toast on completion. On
 * success it calls `onComplete()` so the parent can refresh status /
 * branches. We also persist the user's "run scan before X" / "warn on
 * critical/high" preferences in localStorage so the toggles aren't lost
 * between dialog opens.
 */

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Loader2, GitPullRequest, GitCommit, ArrowUpFromLine } from "lucide-react"
import { toast } from "sonner"
import {
  gitCommit,
  gitPull,
  gitPush,
  type GitCommitResponse,
  type GitOpReportSummary,
  type GitPullResponse,
  type GitPushResponse,
} from "@/lib/git-client"

const LS_KEYS = {
  runScanBeforeCommit: "edge-agent-ai.git.runScanBeforeCommit",
  warnOnCriticalCommit: "edge-agent-ai.git.warnOnCriticalCommit",
  runScanBeforePush: "edge-agent-ai.git.runScanBeforePush",
  warnOnCriticalPush: "edge-agent-ai.git.warnOnCriticalPush",
  lastCommitMessage: "edge-agent-ai.git.lastCommitMessage",
} as const

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === "true"
  } catch {
    return fallback
  }
}

function writeBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value ? "true" : "false")
  } catch {
    /* ignore quota errors */
  }
}

type CommonProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  branch: string
  /** Called after a successful op so the caller can re-fetch status / branches. */
  onComplete?: () => void | Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                       */
/* -------------------------------------------------------------------------- */

export function PullConfirmDialog({
  open,
  onOpenChange,
  projectPath,
  branch,
  workingTreeStatus,
  headBranch,
  onComplete,
}: CommonProps & {
  /** "uncommitted" | "clean" | null — taken from the latest /api/git/status. */
  workingTreeStatus: "uncommitted" | "clean" | null
  /** The repo's actual checked-out branch, if known. We warn when this
   * differs from the branch the user is pulling. */
  headBranch?: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setServerError(null)
  }, [open])

  const dirty = workingTreeStatus === "uncommitted"
  const branchMismatch = !!headBranch && headBranch !== branch
  const canPull = !!projectPath && !!branch && !dirty && !busy

  const handlePull = async () => {
    if (!canPull) return
    setBusy(true)
    setServerError(null)
    let res: GitPullResponse | null = null
    try {
      res = await gitPull({ projectPath, branch })
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Pull request failed")
      setBusy(false)
      return
    }
    setBusy(false)
    if (!res) return
    if (res.ok) {
      toast.success(res.message ?? "Pull complete.")
      onOpenChange(false)
      void onComplete?.()
      return
    }
    if (res.blocked && res.reason === "uncommitted_changes") {
      setServerError(res.message ?? "Working tree has uncommitted changes.")
      toast.error("Pull blocked: working tree has uncommitted changes.")
      return
    }
    const detail = res.message ?? res.error ?? "git pull failed"
    setServerError(`${detail}${res.stderr ? `\n${res.stderr}` : ""}`)
    toast.error(detail)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5" />
            Pull from origin
          </DialogTitle>
          <DialogDescription>
            Fast-forward only. No merge commits will be created — if a
            fast-forward isn&apos;t possible the request will fail and your
            working tree won&apos;t change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch</span>
            <Badge variant="outline">{branch || "—"}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Working tree</span>
            <Badge
              variant="outline"
              className={
                dirty
                  ? "border-yellow-500/40 text-yellow-400"
                  : workingTreeStatus === "clean"
                    ? "border-green-500/40 text-green-400"
                    : ""
              }
            >
              {workingTreeStatus ?? "unknown"}
            </Badge>
          </div>
          {branchMismatch && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
              Heads up: the repo is currently on{" "}
              <span className="font-mono">{headBranch}</span> but you&apos;re
              pulling <span className="font-mono">{branch}</span> from origin.
              Git will fast-forward your current HEAD if compatible, otherwise
              the pull will fail.
            </div>
          )}
          {dirty && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
              The working tree has uncommitted changes. Commit or stash them
              before pulling so we don&apos;t risk losing your edits.
            </div>
          )}
          {serverError && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300 whitespace-pre-wrap font-mono max-h-40 overflow-auto">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handlePull} disabled={!canPull}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {busy ? "Pulling…" : "Pull (--ff-only)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                     */
/* -------------------------------------------------------------------------- */

export function CommitDialog({
  open,
  onOpenChange,
  projectPath,
  branch,
  workingTreeStatus,
  onComplete,
}: CommonProps & {
  workingTreeStatus: "uncommitted" | "clean" | null
}) {
  const [message, setMessage] = useState("")
  const [runScan, setRunScan] = useState(false)
  const [warnOnCritical, setWarnOnCritical] = useState(true)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [blockedReport, setBlockedReport] = useState<GitOpReportSummary | null>(
    null
  )

  useEffect(() => {
    if (!open) return
    setRunScan(readBool(LS_KEYS.runScanBeforeCommit, false))
    setWarnOnCritical(readBool(LS_KEYS.warnOnCriticalCommit, true))
    setServerError(null)
    setBlockedReport(null)
    if (typeof window !== "undefined") {
      try {
        setMessage(window.localStorage.getItem(LS_KEYS.lastCommitMessage) ?? "")
      } catch {
        setMessage("")
      }
    }
  }, [open])

  useEffect(() => {
    writeBool(LS_KEYS.runScanBeforeCommit, runScan)
  }, [runScan])
  useEffect(() => {
    writeBool(LS_KEYS.warnOnCriticalCommit, warnOnCritical)
  }, [warnOnCritical])

  const trimmed = message.trim()
  const canCommit = !!projectPath && trimmed.length > 0 && !busy
  const dirty = workingTreeStatus === "uncommitted"

  const handleCommit = async () => {
    if (!canCommit) return
    setBusy(true)
    setServerError(null)
    setBlockedReport(null)
    let res: GitCommitResponse | null = null
    try {
      res = await gitCommit({
        projectPath,
        message: trimmed,
        runScanBeforeCommit: runScan,
        warnOnCriticalFindings: warnOnCritical,
      })
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Commit request failed")
      setBusy(false)
      return
    }
    setBusy(false)
    if (!res) return
    if (res.ok && res.noChanges) {
      toast.message("No changes to commit.")
      onOpenChange(false)
      void onComplete?.()
      return
    }
    if (res.ok) {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LS_KEYS.lastCommitMessage)
        }
      } catch {
        /* ignore */
      }
      toast.success(res.message ?? "Commit complete.")
      setMessage("")
      onOpenChange(false)
      void onComplete?.()
      return
    }
    if (res.blocked && res.reason === "critical_or_high_findings") {
      setBlockedReport(res.report ?? null)
      const msg =
        res.message ?? "Commit blocked by pre-commit scan findings."
      setServerError(msg)
      toast.error(msg)
      return
    }
    const detail = res.message ?? res.error ?? "git commit failed"
    setServerError(`${detail}${res.stderr ? `\n${res.stderr}` : ""}`)
    toast.error(detail)
  }

  const handleMessageChange = (next: string) => {
    setMessage(next)
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(LS_KEYS.lastCommitMessage, next)
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCommit className="h-5 w-5" />
            Commit local changes
          </DialogTitle>
          <DialogDescription>
            Stages all tracked + untracked changes (<code>git add -A</code>) and
            commits them locally. Push is a separate, explicitly confirmed
            step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch</span>
            <Badge variant="outline">{branch || "—"}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Working tree</span>
            <Badge
              variant="outline"
              className={
                dirty
                  ? "border-yellow-500/40 text-yellow-400"
                  : workingTreeStatus === "clean"
                    ? "border-green-500/40 text-green-400"
                    : ""
              }
            >
              {workingTreeStatus ?? "unknown"}
            </Badge>
          </div>

          <div className="space-y-1">
            <Label htmlFor="commit-message">Commit message</Label>
            <Textarea
              id="commit-message"
              value={message}
              onChange={(e) => handleMessageChange(e.target.value)}
              placeholder="Describe the change…"
              rows={4}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">
              First line is treated as the commit subject.
            </p>
          </div>

          <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="run-scan-commit"
                  className="text-sm font-medium"
                >
                  Run scan before commit
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Runs the local scanner on the project. Adds time but lets
                  Edge Agent block on findings.
                </p>
              </div>
              <Switch
                id="run-scan-commit"
                checked={runScan}
                onCheckedChange={setRunScan}
                disabled={busy}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="warn-critical-commit"
                  className="text-sm font-medium"
                >
                  Block on critical / high findings
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Only applies when the pre-commit scan is enabled.
                </p>
              </div>
              <Switch
                id="warn-critical-commit"
                checked={warnOnCritical}
                onCheckedChange={setWarnOnCritical}
                disabled={busy || !runScan}
              />
            </div>
          </div>

          {blockedReport && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300 space-y-1">
              <div className="font-medium">Pre-commit scan blocked the commit.</div>
              <div className="font-mono">
                Risk score {blockedReport.risk_score}/100 ·{" "}
                {blockedReport.summary.critical} critical ·{" "}
                {blockedReport.summary.high} high ·{" "}
                {blockedReport.summary.medium} medium ·{" "}
                {blockedReport.summary.low} low
              </div>
              <div>
                Review the findings, fix or accept the risk, then disable
                &ldquo;Block on critical / high&rdquo; or rerun.
              </div>
            </div>
          )}
          {serverError && !blockedReport && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300 whitespace-pre-wrap font-mono max-h-40 overflow-auto">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleCommit} disabled={!canCommit}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {busy
              ? runScan
                ? "Scanning + committing…"
                : "Committing…"
              : "Commit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

export function PushConfirmDialog({
  open,
  onOpenChange,
  projectPath,
  branch,
  headBranch,
  remote,
  onComplete,
}: CommonProps & {
  headBranch?: string | null
  remote?: string | null
}) {
  const [runScan, setRunScan] = useState(true)
  const [warnOnCritical, setWarnOnCritical] = useState(true)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [blockedReport, setBlockedReport] = useState<GitOpReportSummary | null>(
    null
  )

  useEffect(() => {
    if (!open) return
    setRunScan(readBool(LS_KEYS.runScanBeforePush, true))
    setWarnOnCritical(readBool(LS_KEYS.warnOnCriticalPush, true))
    setServerError(null)
    setBlockedReport(null)
  }, [open])

  useEffect(() => {
    writeBool(LS_KEYS.runScanBeforePush, runScan)
  }, [runScan])
  useEffect(() => {
    writeBool(LS_KEYS.warnOnCriticalPush, warnOnCritical)
  }, [warnOnCritical])

  const branchMismatch = !!headBranch && headBranch !== branch
  const canPush = !!projectPath && !!branch && !busy

  const remoteShort = useMemo(() => {
    if (!remote) return null
    return remote.length > 60 ? `…${remote.slice(-58)}` : remote
  }, [remote])

  const handlePush = async () => {
    if (!canPush) return
    setBusy(true)
    setServerError(null)
    setBlockedReport(null)
    let res: GitPushResponse | null = null
    try {
      res = await gitPush({
        projectPath,
        branch,
        runScanBeforePush: runScan,
        warnOnCriticalFindings: warnOnCritical,
      })
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Push request failed")
      setBusy(false)
      return
    }
    setBusy(false)
    if (!res) return
    if (res.ok) {
      toast.success(res.message ?? "Push complete.")
      onOpenChange(false)
      void onComplete?.()
      return
    }
    if (res.blocked && res.reason === "critical_or_high_findings") {
      setBlockedReport(res.report ?? null)
      const msg = res.message ?? "Push blocked by pre-push scan findings."
      setServerError(msg)
      toast.error(msg)
      return
    }
    const detail = res.message ?? res.error ?? "git push failed"
    setServerError(`${detail}${res.stderr ? `\n${res.stderr}` : ""}`)
    toast.error(detail)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpFromLine className="h-5 w-5" />
            Push to origin
          </DialogTitle>
          <DialogDescription>
            Pushes your local branch to <code>origin</code> using your
            existing git credentials. No <code>--force</code>, no rewrites.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Branch</span>
            <Badge variant="outline">{branch || "—"}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Remote</span>
            <span
              className="font-mono text-xs truncate max-w-[260px]"
              title={remote ?? undefined}
            >
              {remoteShort ?? "origin"}
            </span>
          </div>

          {branchMismatch && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
              Heads up: HEAD is on{" "}
              <span className="font-mono">{headBranch}</span> but you&apos;re
              about to push <span className="font-mono">{branch}</span>. Git
              will push the local branch named{" "}
              <span className="font-mono">{branch}</span> if it exists.
            </div>
          )}

          <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="run-scan-push" className="text-sm font-medium">
                  Run scan before push
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Strongly recommended — pushes are visible to teammates / CI.
                </p>
              </div>
              <Switch
                id="run-scan-push"
                checked={runScan}
                onCheckedChange={setRunScan}
                disabled={busy}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="warn-critical-push"
                  className="text-sm font-medium"
                >
                  Block on critical / high findings
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Only applies when the pre-push scan is enabled.
                </p>
              </div>
              <Switch
                id="warn-critical-push"
                checked={warnOnCritical}
                onCheckedChange={setWarnOnCritical}
                disabled={busy || !runScan}
              />
            </div>
          </div>

          {blockedReport && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300 space-y-1">
              <div className="font-medium">Pre-push scan blocked the push.</div>
              <div className="font-mono">
                Risk score {blockedReport.risk_score}/100 ·{" "}
                {blockedReport.summary.critical} critical ·{" "}
                {blockedReport.summary.high} high ·{" "}
                {blockedReport.summary.medium} medium ·{" "}
                {blockedReport.summary.low} low
              </div>
              <div>
                Review findings in the Findings tab. Disable &ldquo;Block on
                critical / high&rdquo; only if you&apos;ve consciously accepted
                the risk.
              </div>
            </div>
          )}
          {serverError && !blockedReport && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300 whitespace-pre-wrap font-mono max-h-40 overflow-auto">
              {serverError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handlePush} disabled={!canPush}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {busy
              ? runScan
                ? "Scanning + pushing…"
                : "Pushing…"
              : "Push to origin"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
