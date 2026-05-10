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
import type { Policy, PolicyEvaluation } from "@/lib/policy"
import type { PolicyApiResponse } from "@/lib/policy-client"
import { loadPolicy } from "@/lib/policy-client"
import { PolicyStatusCard } from "@/components/policy-status-card"
import { Lock } from "lucide-react"
import {
  fetchGitHubRepoPermission,
  type GitHubRepoPermissionResponse,
} from "@/lib/github-client"

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

/**
 * Construct a `PolicyApiResponse`-shaped object from the policy fields
 * a /api/git/commit or /api/git/push response includes. The git routes
 * embed the policy/evaluation/source/errors directly in their response
 * (instead of requiring a second round-trip), so we just shape it back
 * into what `PolicyStatusCard` expects.
 */
function toPolicyResponse(
  policy: Policy,
  evaluation: PolicyEvaluation,
  meta: { policySource?: "file" | "default"; policyErrors?: string[] }
): PolicyApiResponse {
  return {
    policy,
    policySource: meta.policySource ?? "default",
    policyErrors: meta.policyErrors ?? [],
    policyPath: null,
    evaluation,
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
  // Policy verdict pulled out of the commit response. We render it via
  // PolicyStatusCard regardless of whether the commit succeeded, so the
  // user always sees the policy decision after a pre-commit scan.
  const [policyResponse, setPolicyResponse] =
    useState<PolicyApiResponse | null>(null)
  // Mode of the project's `.edgeagent/policy.yaml` (or "block" by
  // default). When "block", the server FORCES the pre-commit scan and
  // ignores the toggle — we lock the UI to match so the user isn't
  // confused into thinking the gate is opt-in.
  const [policyMode, setPolicyMode] = useState<Policy["mode"] | null>(null)
  const policyEnforces = policyMode === "block"

  useEffect(() => {
    if (!open) return
    // Default ON. Without a pre-commit scan the policy gate never
    // runs, so any tightening of `.edgeagent/policy.yaml` would be
    // invisible to the user. Power users can toggle it off and we
    // remember the choice via LS_KEYS.runScanBeforeCommit.
    setRunScan(readBool(LS_KEYS.runScanBeforeCommit, true))
    setWarnOnCritical(readBool(LS_KEYS.warnOnCriticalCommit, true))
    setServerError(null)
    setBlockedReport(null)
    setPolicyResponse(null)
    setPolicyMode(null)
    if (typeof window !== "undefined") {
      try {
        setMessage(window.localStorage.getItem(LS_KEYS.lastCommitMessage) ?? "")
      } catch {
        setMessage("")
      }
    }
    // Fetch the policy mode so the UI can lock the toggle when the
    // project enforces. Best-effort — failure just leaves the toggle
    // user-controlled, and the server still enforces independently.
    if (projectPath) {
      let cancelled = false
      ;(async () => {
        try {
          const res = await loadPolicy(projectPath)
          if (cancelled) return
          setPolicyMode(res.policy?.mode ?? null)
          // When policy enforces, force the scan ON locally too — the
          // server will do it anyway, but this keeps the visible state
          // honest before the user clicks Commit.
          if (res.policy?.mode === "block") {
            setRunScan(true)
            setWarnOnCritical(true)
          }
        } catch {
          /* leave policyMode null; server still enforces */
        }
      })()
      return () => {
        cancelled = true
      }
    }
  }, [open, projectPath])

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
    setPolicyResponse(null)
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
    if (res.evaluation && res.policy) {
      setPolicyResponse(toPolicyResponse(res.policy, res.evaluation, res))
    }
    if (res.ok && res.noChanges) {
      toast.message("No changes to commit.")
      // Don't auto-close; the user may still want to inspect the policy
      // verdict that came back with the no-op response.
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
    if (
      res.blocked &&
      (res.reason === "critical_or_high_findings" ||
        res.reason === "policy_block")
    ) {
      setBlockedReport(res.report ?? null)
      const msg =
        res.message ??
        (res.reason === "policy_block"
          ? "Commit blocked by .edgeagent/policy.yaml."
          : "Commit blocked by pre-commit scan findings.")
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
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  Run scan before commit
                  {policyEnforces && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400"
                      title="Required by .edgeagent/policy.yaml mode: block"
                    >
                      <Lock className="h-3 w-3" />
                      enforced
                    </span>
                  )}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {policyEnforces
                    ? "Policy mode is block — the scan will always run and a regression vs main will refuse the commit."
                    : "Runs the local scanner on the project. Adds time but lets Edge Agent block on findings."}
                </p>
              </div>
              <Switch
                id="run-scan-commit"
                checked={runScan || policyEnforces}
                onCheckedChange={setRunScan}
                disabled={busy || policyEnforces}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="warn-critical-commit"
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  Block on critical / high findings
                  {policyEnforces && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400"
                      title="Required by .edgeagent/policy.yaml mode: block"
                    >
                      <Lock className="h-3 w-3" />
                      enforced
                    </span>
                  )}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {policyEnforces
                    ? "Policy is enforcing — critical findings always block, regardless of this toggle."
                    : "Only applies when the pre-commit scan is enabled."}
                </p>
              </div>
              <Switch
                id="warn-critical-commit"
                checked={warnOnCritical || policyEnforces}
                onCheckedChange={setWarnOnCritical}
                disabled={busy || policyEnforces || !runScan}
              />
            </div>
          </div>

          {policyResponse && (
            <PolicyStatusCard response={policyResponse} compact />
          )}

          {blockedReport && !policyResponse && (
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
          {serverError && !blockedReport && !policyResponse && (
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
  const [policyResponse, setPolicyResponse] =
    useState<PolicyApiResponse | null>(null)
  // Same UX as the commit dialog — when the project policy is in
  // block mode, the server forces the gate and we lock the toggle so
  // the user can't be misled into thinking they can opt out.
  const [policyMode, setPolicyMode] = useState<Policy["mode"] | null>(null)
  const policyEnforces = policyMode === "block"
  // Pre-flight GitHub permission check. Runs once when the dialog
  // opens so the user sees "wrong-account / no push" *before* clicking
  // Push. The server side enforces the same gate; this is purely UX.
  const [permission, setPermission] =
    useState<GitHubRepoPermissionResponse | null>(null)
  const [permissionLoading, setPermissionLoading] = useState(false)
  // Permission-denied details lifted out of a 403 push response so we
  // can render a tailored "wrong account / cached creds" panel.
  const [permissionDenied, setPermissionDenied] = useState<{
    message: string
    suggestions: string[]
    github?: GitPushResponse["github"]
    stderr?: string
  } | null>(null)

  useEffect(() => {
    if (!open) return
    setRunScan(readBool(LS_KEYS.runScanBeforePush, true))
    setWarnOnCritical(readBool(LS_KEYS.warnOnCriticalPush, true))
    setServerError(null)
    setBlockedReport(null)
    setPolicyResponse(null)
    setPermission(null)
    setPermissionDenied(null)
    setPolicyMode(null)
    if (projectPath) {
      setPermissionLoading(true)
      fetchGitHubRepoPermission(projectPath)
        .then((p) => setPermission(p))
        .catch(() => setPermission(null))
        .finally(() => setPermissionLoading(false))
      let cancelled = false
      ;(async () => {
        try {
          const res = await loadPolicy(projectPath)
          if (cancelled) return
          setPolicyMode(res.policy?.mode ?? null)
          if (res.policy?.mode === "block") {
            setRunScan(true)
            setWarnOnCritical(true)
          }
        } catch {
          /* leave policyMode null; server still enforces */
        }
      })()
      return () => {
        cancelled = true
      }
    }
  }, [open, projectPath])

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
    setPolicyResponse(null)
    setPermissionDenied(null)
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
    if (res.evaluation && res.policy) {
      setPolicyResponse(toPolicyResponse(res.policy, res.evaluation, res))
    }
    if (res.ok) {
      toast.success(res.message ?? "Push complete.")
      onOpenChange(false)
      void onComplete?.()
      return
    }
    if (
      res.blocked &&
      (res.reason === "no_push_permission" ||
        res.reason === "permission_denied")
    ) {
      const msg =
        res.message ??
        (res.reason === "no_push_permission"
          ? "Authenticated GitHub account doesn't have push access."
          : "GitHub rejected the push (403).")
      setPermissionDenied({
        message: msg,
        suggestions:
          res.suggestions ??
          (res.reason === "no_push_permission"
            ? [
                "Run `gh auth login` and pick the account that owns this repo.",
                "Run `gh auth status` to see who gh thinks you are.",
                "Ask the repo owner for collaborator access.",
              ]
            : []),
        github: res.github,
        stderr: res.stderr,
      })
      toast.error(msg)
      return
    }
    if (
      res.blocked &&
      (res.reason === "critical_or_high_findings" ||
        res.reason === "policy_block")
    ) {
      setBlockedReport(res.report ?? null)
      const msg =
        res.message ??
        (res.reason === "policy_block"
          ? "Push blocked by .edgeagent/policy.yaml."
          : "Push blocked by pre-push scan findings.")
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

          {/* GitHub auth + permission preview. Surfaces "wrong account"
              before the user clicks Push. The server enforces the same
              gate; this is purely a UX shortcut. */}
          <GitHubPermissionPreview
            permission={permission}
            loading={permissionLoading}
          />

          <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="run-scan-push"
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  Run scan before push
                  {policyEnforces && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400"
                      title="Required by .edgeagent/policy.yaml mode: block"
                    >
                      <Lock className="h-3 w-3" />
                      enforced
                    </span>
                  )}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {policyEnforces
                    ? "Policy mode is block — the scan will always run and a regression vs main will refuse the push."
                    : "Strongly recommended — pushes are visible to teammates / CI."}
                </p>
              </div>
              <Switch
                id="run-scan-push"
                checked={runScan || policyEnforces}
                onCheckedChange={setRunScan}
                disabled={busy || policyEnforces}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label
                  htmlFor="warn-critical-push"
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  Block on critical / high findings
                  {policyEnforces && (
                    <span
                      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-400"
                      title="Required by .edgeagent/policy.yaml mode: block"
                    >
                      <Lock className="h-3 w-3" />
                      enforced
                    </span>
                  )}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {policyEnforces
                    ? "Policy is enforcing — critical findings always block, regardless of this toggle."
                    : "Only applies when the pre-push scan is enabled."}
                </p>
              </div>
              <Switch
                id="warn-critical-push"
                checked={warnOnCritical || policyEnforces}
                onCheckedChange={setWarnOnCritical}
                disabled={busy || policyEnforces || !runScan}
              />
            </div>
          </div>

          {policyResponse && (
            <PolicyStatusCard response={policyResponse} compact />
          )}

          {blockedReport && !policyResponse && (
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
          {permissionDenied && (
            <PermissionDeniedPanel detail={permissionDenied} />
          )}
          {serverError &&
            !blockedReport &&
            !policyResponse &&
            !permissionDenied && (
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
          <Button
            type="button"
            onClick={handlePush}
            disabled={
              !canPush ||
              // Hard-block the button only when gh actually told us
              // the authenticated account has no push access. Other
              // states (gh missing, not authenticated, not GitHub)
              // fall through and let `git push` decide.
              !!(
                permission?.resolved &&
                permission.canPush === false
              )
            }
          >
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

/* -------------------------------------------------------------------------- */
/* GitHub permission helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Inline mini-card under the Push dialog showing what we know about
 * the authenticated GitHub account vs. the project's `origin`. Stays
 * compact / informational — the *real* enforcement happens server-side.
 */
function GitHubPermissionPreview({
  permission,
  loading,
}: {
  permission: GitHubRepoPermissionResponse | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border bg-secondary/10 p-2 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking GitHub account permissions…
      </div>
    )
  }
  if (!permission) return null
  if (permission.notGitHub) {
    return null
  }
  if (permission.ghMissing) {
    return (
      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
        GitHub CLI (<code>gh</code>) isn&apos;t installed, so we can&apos;t
        pre-check push permissions. Push will use whatever credentials
        your local Git is configured with.
      </div>
    )
  }
  if (permission.notAuthenticated) {
    return (
      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300">
        No GitHub CLI session detected. Run{" "}
        <code className="font-mono">gh auth login</code> to enable
        per-account permission checks.
      </div>
    )
  }
  if (!permission.resolved) {
    return (
      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-300 space-y-1">
        <div>
          Couldn&apos;t resolve push permissions for{" "}
          <span className="font-mono">
            {permission.owner}/{permission.repo}
          </span>
          .
        </div>
        {permission.message && (
          <div className="text-[11px] opacity-80">{permission.message}</div>
        )}
      </div>
    )
  }
  if (permission.canPush) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs text-emerald-300">
        ✓ Authenticated account can push to{" "}
        <span className="font-mono">
          {permission.owner}/{permission.repo}
        </span>
        .
      </div>
    )
  }
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300 space-y-1">
      <div>
        ✗ Authenticated GitHub account does <strong>not</strong> have push
        access to{" "}
        <span className="font-mono">
          {permission.owner}/{permission.repo}
        </span>
        .
      </div>
      <div className="text-[11px] opacity-80">
        Run <code>gh auth login</code> with the correct account, or ask the
        repo owner for collaborator access. Settings → GitHub Account has
        more details.
      </div>
    </div>
  )
}

/**
 * Rendered after the server returns 403 from `git push`. Shows the
 * specific failure reason (no push perm vs. cached creds) plus the
 * exact commands the user should try, so they don't have to leave the
 * dialog to copy-paste them from documentation.
 */
function PermissionDeniedPanel({
  detail,
}: {
  detail: {
    message: string
    suggestions: string[]
    github?: GitPushResponse["github"]
    stderr?: string
  }
}) {
  const isHttps = detail.github?.protocol === "https"
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300 space-y-2">
      <div className="font-medium">{detail.message}</div>
      {detail.github && (
        <div className="font-mono text-[11px] opacity-80">
          Account: {detail.github.login ?? "unknown"} · Repo:{" "}
          {detail.github.owner}/{detail.github.repo} · Remote uses{" "}
          {detail.github.protocol.toUpperCase()}
        </div>
      )}
      {isHttps && (
        <div className="text-[11px] text-yellow-300/90">
          Your browser login may be correct, but <code>git push</code> uses
          stored Git credentials. Re-authenticate Git, clear the cached
          credential, or switch the remote to SSH.
        </div>
      )}
      {detail.suggestions.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide opacity-70">
            Suggested fixes
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {detail.suggestions.map((s, i) => (
              <li key={i} className="text-[11px]">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.stderr && (
        <details className="text-[11px] opacity-80">
          <summary className="cursor-pointer">Raw git stderr</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">
            {detail.stderr}
          </pre>
        </details>
      )}
    </div>
  )
}
