"use client"

/**
 * CreatePrDialog — policy-gated "Create Pull Request" flow.
 *
 * The button on the top bar (and Branch Compare) opens this dialog
 * instead of the legacy push dialog when the user has a GitHub remote.
 * It is a deliberately *thick* component:
 *
 *   - On open, runs three pre-flight checks in parallel so the form
 *     reflects reality before the user fills in anything:
 *       1. /api/github/status            (gh installed + logged-in)
 *       2. /api/github/repo-permission   (canPush)
 *       3. /api/github/pr/status         (existing PR for this branch)
 *
 *   - Calls /api/policy/evaluate (GET) to learn the *current* policy
 *     mode + base_branch suggestion before the user picks a base.
 *
 *   - When the user clicks "Run Gate" or "Create PR", everything runs
 *     server-side via /api/github/pr/create which atomically does
 *     scan → policy → push → gh pr create → optional auto-merge. The
 *     UI just renders whatever state the server returned.
 *
 * The dialog never directly invokes git or gh — it only reads policy
 * to pick sensible defaults and renders whatever the create endpoint
 * tells it. That keeps the actual push/PR-create flow as a single
 * server transaction with clear failure modes.
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
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GithubLoginDialog } from "@/components/github-login-dialog"
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"
import {
  createPullRequestApi,
  fetchGitHubRepoPermission,
  fetchGitHubStatus,
  fetchPrStatus,
  type CreatePrApiResponse,
  type GitHubPrStatusResponse,
  type GitHubRepoPermissionResponse,
  type GitHubStatusResponse,
} from "@/lib/github-client"
import { loadPolicy, type PolicyApiResponse } from "@/lib/policy-client"
import {
  decisionBadgeClass,
  decisionLabel,
  type Decision,
} from "@/lib/policy"

interface CreatePrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Selected project path. May be null/empty when no project is open;
   *  the dialog renders a hard-block reason instead of crashing so the
   *  user always gets feedback when they click Create PR. */
  projectPath: string | null
  /** Initial head/source branch selection — usually the top bar's
   *  current branch. The user can change it via the dropdown when
   *  `branches` is populated. May be null/empty when the branch list
   *  hasn't loaded yet. */
  headBranch: string | null
  /** Pre-filled base branch suggestion. Falls back to policy.pull_request.base_branch
   * (loaded async) and finally "main". */
  baseBranchHint?: string | null
  /** Full list of branches in the repo. When provided, both head and
   *  base render as dropdowns so users can pick a different source/
   *  target without going back to the top bar. Empty list keeps the
   *  inputs as plain text. */
  branches?: string[]
  /** Called after a successful create so the parent can refresh
   * branches / PR status / policy badges. */
  onCreated?: (resp: CreatePrApiResponse) => void
}

const LS_KEYS = {
  runGate: "edge-agent-ai.pr.runPolicyGate",
  autoMerge: "edge-agent-ai.pr.enableAutoMerge",
  draft: "edge-agent-ai.pr.draft",
} as const

function readBool(key: string, def: boolean): boolean {
  if (typeof window === "undefined") return def
  const v = window.localStorage.getItem(key)
  if (v === "true") return true
  if (v === "false") return false
  return def
}
function writeBool(key: string, val: boolean) {
  try {
    window.localStorage.setItem(key, String(val))
  } catch {
    /* QuotaExceededError / disabled storage — non-fatal. */
  }
}

export function CreatePrDialog({
  open,
  onOpenChange,
  projectPath,
  headBranch,
  baseBranchHint,
  branches = [],
  onCreated,
}: CreatePrDialogProps) {
  /* ---------------- Form state ---------------- */
  const [baseBranch, setBaseBranch] = useState<string>(baseBranchHint ?? "main")
  // Head branch lives in local state too so users can override the
  // top-bar selection inside the dialog. We re-sync from the prop
  // every time the dialog opens (see useEffect below) so reopening
  // after switching branches in the top bar picks up the new value.
  const [headSel, setHeadSel] = useState<string>(headBranch ?? "")
  const [title, setTitle] = useState<string>("")
  const [body, setBody] = useState<string>("")
  const [draft, setDraft] = useState<boolean>(false)
  const [runGate, setRunGate] = useState<boolean>(true)
  const [autoMerge, setAutoMerge] = useState<boolean>(false)

  /* ---------------- Pre-flight state ---------------- */
  const [ghStatus, setGhStatus] = useState<GitHubStatusResponse | null>(null)
  const [permission, setPermission] = useState<GitHubRepoPermissionResponse | null>(null)
  const [prStatus, setPrStatus] = useState<GitHubPrStatusResponse | null>(null)
  const [policy, setPolicy] = useState<PolicyApiResponse | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)

  /* ---------------- Submit / result state ---------------- */
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CreatePrApiResponse | null>(null)

  /* ---------------- GitHub sign-in ---------------- */
  // Mounted alongside the PR dialog so users can sign in without
  // closing this one. After login we re-run the pre-flight checks so
  // ghStatus / permission / prStatus refresh against the new identity.
  const [signInOpen, setSignInOpen] = useState(false)

  // Reset everything on open. We keep last-used toggle prefs in
  // localStorage so users opening the dialog twice in a row don't
  // need to re-tick "run policy gate" every time.
  useEffect(() => {
    if (!open) return
    setRunGate(readBool(LS_KEYS.runGate, true))
    setAutoMerge(readBool(LS_KEYS.autoMerge, false))
    setDraft(readBool(LS_KEYS.draft, false))
    setResult(null)
    // Re-sync head from the prop on every open so switching the top-
    // bar branch and reopening the dialog picks up the new value.
    // The user can still override via the dropdown below.
    if (headBranch) setHeadSel(headBranch)
    setTitle((t) => t || defaultPrTitle(headBranch ?? ""))
    void runPreflight()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => writeBool(LS_KEYS.runGate, runGate), [runGate])
  useEffect(() => writeBool(LS_KEYS.autoMerge, autoMerge), [autoMerge])
  useEffect(() => writeBool(LS_KEYS.draft, draft), [draft])

  // When the policy file loads, surface its base_branch suggestion if
  // the user hasn't typed something different yet.
  useEffect(() => {
    const policyBase = policy?.policy.pull_request?.base_branch
    if (policyBase && (!baseBranch || baseBranch === "main")) {
      setBaseBranch(policyBase)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy])

  // If the user picks a head that collides with the current base
  // (very common since both default to whatever's checked out),
  // auto-pick a different base — preferring the policy default,
  // then main/master, then the first non-head branch — so the user
  // doesn't get stuck staring at "head and base are both X".
  useEffect(() => {
    if (!headSel || !baseBranch || headSel !== baseBranch) return
    const policyBase = policy?.policy.pull_request?.base_branch
    const candidates = [
      policyBase,
      "main",
      "master",
      ...branches,
    ].filter((b): b is string => !!b && b !== headSel)
    const next = candidates[0]
    if (next) setBaseBranch(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSel])

  const runPreflight = async () => {
    if (!projectPath) {
      // Still call gh-status — it's path-free and tells the user
      // whether they need to install/login regardless of which project
      // is selected. Repo-scoped checks just stay null.
      setPreflightLoading(true)
      try {
        const s = await fetchGitHubStatus()
        setGhStatus(s)
      } catch {
        setGhStatus(null)
      } finally {
        setPreflightLoading(false)
      }
      return
    }
    setPreflightLoading(true)
    try {
      const [s, p, prs, pol] = await Promise.allSettled([
        fetchGitHubStatus(),
        fetchGitHubRepoPermission(projectPath),
        // PR status query needs a branch; use the user's head selection
        // when present, else let the API fall back to HEAD.
        headSel
          ? fetchPrStatus({ projectPath, branch: headSel })
          : fetchPrStatus({ projectPath }),
        loadPolicy(projectPath),
      ])
      setGhStatus(s.status === "fulfilled" ? s.value : null)
      setPermission(p.status === "fulfilled" ? p.value : null)
      setPrStatus(prs.status === "fulfilled" ? prs.value : null)
      setPolicy(pol.status === "fulfilled" ? pol.value : null)
    } finally {
      setPreflightLoading(false)
    }
  }

  /* ---------------- Derived gates ---------------- */

  const onDefaultBranch = useMemo(() => {
    const b = (headSel || "").toLowerCase()
    return b === "main" || b === "master"
  }, [headSel])

  // checkGitHubStatus now considers BOTH the in-app token and gh CLI;
  // we only block when the user is fully signed out of both.
  const noAuth = !!ghStatus && !ghStatus.authenticated
  const ghMissing = ghStatus !== null && !ghStatus.ghInstalled && !ghStatus.appAuthenticated
  const noPushPerm = !!permission?.resolved && permission.canPush === false

  // Hard reasons that disable the Create button outright. Soft warnings
  // (warn-policy, no policy file, no scan history) are surfaced
  // separately and do not block.
  const hardBlocks: string[] = []
  if (!projectPath) hardBlocks.push("No project is open.")
  if (!headSel)
    hardBlocks.push(
      "Pick a head/source branch (the branch with your changes)."
    )
  if (onDefaultBranch)
    hardBlocks.push(
      `Pick a feature branch as the head/source — '${headSel}' is the default branch and can't be a PR source.`
    )
  if (headSel && baseBranch && headSel === baseBranch)
    hardBlocks.push(
      `Head and base are both '${headSel}'. Pick two different branches.`
    )
  if (noAuth)
    hardBlocks.push(
      "Sign in to GitHub from the dialog footer (or run `gh auth login`) to open a pull request."
    )
  if (noPushPerm)
    hardBlocks.push(
      `Authenticated GitHub account ${
        ghStatus?.login ? `'${ghStatus.login}'` : ""
      } does not have push permission to this repository.`
    )

  const canSubmit =
    !busy &&
    !!projectPath &&
    !!headSel &&
    !!title.trim() &&
    !!baseBranch.trim() &&
    hardBlocks.length === 0

  /* ---------------- Actions ---------------- */

  const handleSubmit = async () => {
    if (!canSubmit || !projectPath || !headSel) return
    setBusy(true)
    setResult(null)
    try {
      const resp = await createPullRequestApi({
        projectPath,
        baseBranch: baseBranch.trim(),
        // Always pass the user-chosen head explicitly — the API
        // validates it via validateRef and uses it for both the push
        // and the `gh pr create --head` flag.
        headBranch: headSel.trim(),
        title: title.trim(),
        body: body.trim(),
        draft,
        runPolicyGate: runGate,
        enableAutoMergeIfAllowed: autoMerge,
        // squash is the safest default for AI-agent codebases — keeps
        // history linear and avoids merge commits inheriting unsigned
        // intermediate WIP commits.
        mergeMethod: "squash",
      })
      setResult(resp)
      if (resp.ok && resp.url) {
        toast.success(
          resp.autoMerge?.enabled
            ? `PR opened with auto-merge enabled.`
            : `PR opened: ${resp.url}`
        )
        onCreated?.(resp)
        // Refresh PR status badge. Don't close — the success body links
        // straight to the PR and we want the user to click it.
        void fetchPrStatus({ projectPath, branch: headSel }).then(setPrStatus)
      } else if (resp.blocked) {
        toast.error(resp.message ?? "PR blocked by policy.")
      } else {
        toast.error(resp.message ?? "Could not create pull request.")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create PR request failed")
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- Render ---------------- */

  const decision: Decision | null = result?.decision ?? null

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5" />
            Create Pull Request
          </DialogTitle>
          <DialogDescription>
            Opens a pull request from{" "}
            <code className="font-mono">{headSel || "(no branch)"}</code>{" "}
            into <code className="font-mono">{baseBranch || "(no base)"}</code>.
            Push goes through the policy gate first so risky changes never
            reach <code>origin</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* ---------- Pre-flight strip ---------- */}
          <PreflightStrip
            loading={preflightLoading}
            ghStatus={ghStatus}
            permission={permission}
            prStatus={prStatus}
            headBranch={headSel}
            baseBranch={baseBranch}
            policy={policy}
            onDefaultBranch={onDefaultBranch}
            onSignInClick={() => setSignInOpen(true)}
          />

          {/* ---------- Hard-block reasons ---------- */}
          {hardBlocks.length > 0 && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-300 space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <ShieldAlert className="h-4 w-4" />
                PR creation is blocked
              </div>
              <ul className="list-disc pl-5 space-y-0.5">
                {hardBlocks.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ---------- Form ----------
            * Order is intentionally head → base, matching how GitHub
            * itself describes a PR ("from <head> into <base>"). The
            * dialog used to put base first which led to users typing
            * their feature branch into the wrong field.
            */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="pr-head">
                Head branch{" "}
                <span className="text-[11px] font-normal text-muted-foreground">
                  (source — your changes)
                </span>
              </Label>
              {branches.length > 0 ? (
                <Select
                  value={headSel}
                  onValueChange={setHeadSel}
                  disabled={busy}
                >
                  <SelectTrigger id="pr-head" className="font-mono">
                    <SelectValue placeholder="Pick a feature branch" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {branches.map((b) => {
                      const isDefault = b === "main" || b === "master"
                      return (
                        <SelectItem
                          key={b}
                          value={b}
                          disabled={isDefault}
                          className="font-mono"
                        >
                          {b}
                          {isDefault ? " · default branch (cannot be PR source)" : ""}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="pr-head"
                  value={headSel}
                  onChange={(e) => setHeadSel(e.target.value)}
                  className="font-mono"
                  placeholder="feature/my-branch"
                  disabled={busy}
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                The branch with the commits you want to merge. Must
                exist locally — Edge Agent AI will push it to{" "}
                <span className="font-mono">origin</span>.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pr-base">
                Base branch{" "}
                <span className="text-[11px] font-normal text-muted-foreground">
                  (target — where it merges into)
                </span>
              </Label>
              {branches.length > 0 ? (
                <Select
                  value={baseBranch}
                  onValueChange={setBaseBranch}
                  disabled={busy}
                >
                  <SelectTrigger id="pr-base" className="font-mono">
                    <SelectValue placeholder="main" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {branches.map((b) => {
                      const isHead = b === headSel
                      return (
                        <SelectItem
                          key={b}
                          value={b}
                          disabled={isHead}
                          className="font-mono"
                        >
                          {b}
                          {isHead ? " · same as head (can't merge into itself)" : ""}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="pr-base"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder="main"
                  disabled={busy}
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                {policy?.policy.pull_request?.base_branch
                  ? `policy default: ${policy.policy.pull_request.base_branch}`
                  : "default suggestion: main"}
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="pr-title">PR title</Label>
            <Input
              id="pr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add quote-extraction tool"
              disabled={busy}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="pr-body">PR description</Label>
            <Textarea
              id="pr-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What changed and why?"
              rows={4}
              disabled={busy}
              className="resize-y"
            />
          </div>

          {/* ---------- Toggles ---------- */}
          <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2">
            <ToggleRow
              id="pr-runGate"
              label="Run policy gate before creating PR"
              desc="Runs the scanner, evaluates .edgeagent/policy.yaml, and only pushes if the result is allowed."
              checked={runGate}
              onChange={setRunGate}
              disabled={busy}
            />
            <ToggleRow
              id="pr-draft"
              label="Open as draft"
              desc="Skip CI/reviewers until you mark the PR ready. Forced on if the policy returns warn."
              checked={draft}
              onChange={setDraft}
              disabled={busy}
            />
            <ToggleRow
              id="pr-autoMerge"
              label="Auto-merge if policy allows"
              desc={
                policy?.policy.auto_merge?.enabled &&
                policy.policy.mode === "auto_merge"
                  ? "Asks GitHub to merge once required checks pass. Only fires when the gate returns auto_merge_allowed."
                  : "Disabled in this project (set mode: auto_merge and auto_merge.enabled in policy.yaml to enable)."
              }
              checked={autoMerge}
              onChange={setAutoMerge}
              disabled={
                busy ||
                !policy?.policy.auto_merge?.enabled ||
                policy.policy.mode !== "auto_merge"
              }
            />
          </div>

          {/* ---------- Server response ---------- */}
          {result && (
            <ResultPanel result={result} headBranch={headSel || headBranch} />
          )}

          {/* Subtle policy-source hint at the bottom */}
          {policy && (
            <p className="text-[11px] text-muted-foreground">
              Policy source: <code>{policy.policySource}</code> ·
              mode: <code>{policy.policy.mode}</code>
              {policy.policyErrors.length > 0 &&
                ` · ${policy.policyErrors.length} parse warning${
                  policy.policyErrors.length === 1 ? "" : "s"
                }`}
            </p>
          )}
        </div>

        {/* Inline blocker hint — shown right above the footer when the
          * Create button is disabled, so users don't have to scroll up
          * past the form to discover what's wrong. We show the FIRST
          * hard block (the most actionable one) plus a "see all"
          * affordance via the existing top-of-dialog panel.
          *
          * The most common reason this fires is `noPushPerm` — the user
          * cloned an upstream repo they don't own (e.g.
          * langchain-ai/agents-from-scratch). For that case we surface
          * a "Fork it" hint so they know what to do next.
          */}
        {!canSubmit && hardBlocks.length > 0 && (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2.5 text-xs text-red-300 space-y-1">
            <div className="font-medium flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />
              Can't open PR: {hardBlocks[0]}
            </div>
            {noPushPerm && permission?.owner && permission?.repo && (
              <div className="text-[11px] opacity-90 pl-5">
                You're signed in as{" "}
                <span className="font-mono">@{ghStatus?.login}</span> but
                don't have push access to{" "}
                <span className="font-mono">
                  {permission.owner}/{permission.repo}
                </span>
                . Fork it to your account and re-clone the fork, or ask
                the owner for write access. Open{" "}
                <a
                  href={`https://github.com/${permission.owner}/${permission.repo}/fork`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  the fork page
                </a>
                .
              </div>
            )}
            {hardBlocks.length > 1 && (
              <div className="text-[11px] opacity-80 pl-5">
                +{hardBlocks.length - 1} more reason
                {hardBlocks.length - 1 === 1 ? "" : "s"} above.
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          {/* Run Gate button — fires the same endpoint with `runPolicyGate=true`
              so the server-side scan + evaluation is the source of truth. We
              just show the result without pushing/creating. To do that
              cleanly without two endpoints, we ask /api/policy/evaluate
              client-side after the dialog already loaded the policy. */}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void runPreflight()}
            disabled={busy || preflightLoading}
            title="Re-fetch GitHub status, permission, and policy file."
          >
            {preflightLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Re-check
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={
              canSubmit
                ? undefined
                : hardBlocks[0] ?? "Fill in title and pick branches first."
            }
          >
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {busy
              ? runGate
                ? "Running gate + opening PR…"
                : "Opening PR…"
              : decision === "block"
                ? "Blocked"
                : draft
                  ? "Open Draft PR"
                  : "Create Pull Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* Sign-in modal lives next to the PR dialog so the user can
          authenticate without losing their PR draft. After login we
          re-run pre-flight to refresh ghStatus/permission/prStatus. */}
      <GithubLoginDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onAuthChanged={() => void runPreflight()}
      />
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function PreflightStrip({
  loading,
  ghStatus,
  permission,
  prStatus,
  headBranch,
  baseBranch,
  policy,
  onDefaultBranch,
  onSignInClick,
}: {
  loading: boolean
  ghStatus: GitHubStatusResponse | null
  permission: GitHubRepoPermissionResponse | null
  prStatus: GitHubPrStatusResponse | null
  headBranch: string | null
  /** Live base-branch selection so the "PR base" badge stays in sync
   * with what the user actually picked (instead of always echoing the
   * policy default). */
  baseBranch: string
  policy: PolicyApiResponse | null
  onDefaultBranch: boolean
  /** Opens the in-app GitHub sign-in dialog. Optional so the strip
   *  still renders for callers that don't want to mount the auth UI. */
  onSignInClick?: () => void
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border bg-secondary/10 p-2 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running pre-flight checks…
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <PreflightRow
        label="Branch"
        value={headBranch || "(no branch)"}
        ok={!onDefaultBranch && !!headBranch}
        warn={onDefaultBranch}
        hint={onDefaultBranch ? "must not be main/master" : undefined}
      />
      <PreflightRow
        label="GitHub auth"
        value={
          !ghStatus
            ? "unknown"
            : ghStatus.appAuthenticated
              ? `@${ghStatus.appLogin} (in-app)`
              : ghStatus.ghAuthenticated
                ? `@${ghStatus.ghLogin} (gh CLI)`
                : "not signed in"
        }
        ok={!!ghStatus?.authenticated}
        warn={!!ghStatus && !ghStatus.authenticated}
        hint={
          ghStatus && !ghStatus.authenticated
            ? "click 'Sign in with GitHub' below"
            : undefined
        }
      />
      <PreflightRow
        label="Push permission"
        value={
          !permission
            ? "unknown"
            : permission.notGitHub
              ? "not a GitHub remote"
              : permission.ghMissing
                ? "gh missing"
                : permission.notAuthenticated
                  ? "not authenticated"
                  : permission.resolved && permission.canPush
                    ? "yes"
                    : permission.resolved
                      ? "no"
                      : "unknown"
        }
        ok={!!permission?.canPush}
        warn={!!permission?.resolved && permission.canPush === false}
      />
      <PreflightRow
        label="Existing PR"
        value={
          !prStatus
            ? "unknown"
            : prStatus.pr
              ? `#${prStatus.pr.number} (${prStatus.pr.state.toLowerCase()})`
              : "none"
        }
        ok={!prStatus?.pr || prStatus.pr.state !== "OPEN"}
        warn={!!prStatus?.pr && prStatus.pr.state === "OPEN"}
        hint={
          prStatus?.pr?.state === "OPEN"
            ? "creating again may fail (PR already exists)"
            : undefined
        }
        link={prStatus?.pr?.url}
      />
      <PreflightRow
        label="Policy mode"
        value={policy ? policy.policy.mode : "unknown"}
        ok={!!policy && policy.policy.mode !== "block"}
        warn={!!policy && policy.policy.mode === "block"}
        hint={
          policy?.policySource === "default"
            ? "no .edgeagent/policy.yaml — using defaults"
            : undefined
        }
      />
      <PreflightRow
        label="PR base"
        value={baseBranch || policy?.policy.pull_request?.base_branch || "main"}
        warn={!!headBranch && !!baseBranch && headBranch === baseBranch}
        hint={
          !!headBranch && !!baseBranch && headBranch === baseBranch
            ? "must differ from head"
            : undefined
        }
      />
      {/* When no auth source is available, surface a primary
        * "Sign in with GitHub" CTA. Installing the gh CLI is mentioned
        * as a fallback only — most users won't need it now that the
        * app speaks REST directly. */}
      {ghStatus && !ghStatus.authenticated && onSignInClick && (
        <div className="sm:col-span-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-200 space-y-2">
          <div className="font-medium text-sm">
            Sign in to GitHub to enable PR creation
          </div>
          <p className="text-[11px] opacity-90">
            One-click sign-in with a Personal Access Token. The app
            handles git push and PR creation directly — no GitHub CLI
            required.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onSignInClick}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2.5 py-1 text-xs font-medium"
            >
              Sign in with GitHub
            </button>
            {!ghStatus.ghInstalled && (
              <span className="text-[11px] opacity-70">
                or run <code className="font-mono">brew install gh && gh auth login</code> in your terminal
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PreflightRow({
  label,
  value,
  ok,
  warn,
  hint,
  link,
}: {
  label: string
  value: string
  ok?: boolean
  warn?: boolean
  hint?: string
  link?: string
}) {
  const badgeClass = ok
    ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
    : warn
      ? "border-yellow-500/40 text-yellow-300 bg-yellow-500/10"
      : "bg-secondary text-muted-foreground"
  return (
    <div className="rounded-md border border-border bg-secondary/10 px-3 py-2 text-xs flex items-center justify-between gap-2">
      <div className="flex flex-col">
        <span className="text-muted-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className={badgeClass}>
          {value}
        </Badge>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            title={link}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}

function ToggleRow({
  id,
  label,
  desc,
  checked,
  onChange,
  disabled,
}: {
  id: string
  label: string
  desc: string
  checked: boolean
  onChange: (b: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  )
}

function ResultPanel({
  result,
  headBranch,
}: {
  result: CreatePrApiResponse
  headBranch: string | null
}) {
  if (result.ok && result.url) {
    return (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-300 space-y-1">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          Pull request created
          {result.draft && (
            <Badge variant="outline" className="ml-1 text-[10px] py-0 border-yellow-500/40 text-yellow-300">
              draft
            </Badge>
          )}
        </div>
        <div className="font-mono break-all">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {result.url}
          </a>
        </div>
        {result.decision && (
          <div>
            Policy decision:{" "}
            <Badge
              variant="outline"
              className={`${decisionBadgeClass(result.decision)} ml-1`}
            >
              {decisionLabel(result.decision)}
            </Badge>
          </div>
        )}
        {result.autoMerge?.enabled === true && (
          <div>Auto-merge requested — GitHub will merge once required checks pass.</div>
        )}
        {result.autoMerge && result.autoMerge.enabled === false && (
          <div className="text-yellow-300">
            Auto-merge could not be enabled: {result.autoMerge.message ?? result.autoMerge.reason}
          </div>
        )}
      </div>
    )
  }
  // Failure path
  const isBlock = result.blocked || result.reason === "policy_block"
  return (
    <div
      className={`rounded-md border p-3 text-xs space-y-2 ${
        isBlock
          ? "border-red-500/40 bg-red-500/5 text-red-300"
          : "border-yellow-500/40 bg-yellow-500/5 text-yellow-300"
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        <AlertCircle className="h-4 w-4" />
        {isBlock
          ? "Pull request blocked"
          : `Pull request not created (${result.reason ?? "error"})`}
      </div>
      <div>{result.message ?? "(no message)"}</div>
      {result.evaluation?.reasons && result.evaluation.reasons.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5">
          {result.evaluation.reasons.slice(0, 5).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {result.report && (
        <div className="font-mono text-[11px] opacity-80">
          {headBranch || "(no branch)"}: risk {result.report.risk_score}/100 ·{" "}
          {result.report.summary.critical} critical ·{" "}
          {result.report.summary.high} high ·{" "}
          {result.report.summary.medium} medium ·{" "}
          {result.report.summary.low} low
        </div>
      )}
      {result.stderr && (
        <details className="text-[11px] opacity-80">
          <summary className="cursor-pointer">Raw stderr</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">
            {result.stderr.slice(0, 2000)}
          </pre>
        </details>
      )}
    </div>
  )
}

/**
 * Reasonable default title built from the branch name. Users almost
 * always edit this; we just want them to not stare at an empty input.
 *   feat/quote-extraction → "feat/quote-extraction"
 *   add-tool              → "Add tool"
 */
function defaultPrTitle(branch: string): string {
  if (!branch) return ""
  const last = branch.split("/").pop() ?? branch
  // If the name already has separators (slashes / commit-ish), keep it.
  if (branch.includes("/")) return branch
  return last
    .replace(/[-_]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
}

/* -------------------------------------------------------------------------- */
/* Lightweight "PR Gate Status" card for Overview                             */
/* -------------------------------------------------------------------------- */

interface PrGateStatusCardProps {
  projectPath: string | null
  headBranch: string | null
  policy: PolicyApiResponse | null
  /** Latest policy decision evaluated against the current scan. */
  decision: Decision | null
  lastGateRunAt: string | null
  /** Click handler: opens the Create PR dialog. */
  onCreatePr?: () => void
}

/**
 * Compact "PR Gate Status" card used by Overview. Doesn't open the
 * dialog itself — it just tells the user where things stand and
 * delegates the actual flow to whichever entry point already exists
 * (top bar / branch compare).
 */
export function PrGateStatusCard({
  projectPath,
  headBranch,
  policy,
  decision,
  lastGateRunAt,
  onCreatePr,
}: PrGateStatusCardProps) {
  const [prStatus, setPrStatus] = useState<GitHubPrStatusResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!projectPath || !headBranch) {
        setPrStatus(null)
        return
      }
      setLoading(true)
      try {
        const s = await fetchPrStatus({ projectPath, branch: headBranch })
        if (!cancelled) setPrStatus(s)
      } catch {
        if (!cancelled) setPrStatus(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [projectPath, headBranch])

  if (!projectPath || !headBranch) return null

  const baseBranch = policy?.policy.pull_request?.base_branch ?? "main"
  const onDefault =
    headBranch.toLowerCase() === "main" || headBranch.toLowerCase() === "master"

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">PR Gate Status</h3>
          {decision && (
            <Badge
              variant="outline"
              className={`text-[11px] ${decisionBadgeClass(decision)}`}
            >
              {decisionLabel(decision)}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onCreatePr}
          title={
            onDefault
              ? `On '${headBranch}' — open the dialog to see how to create a feature branch.`
              : "Open the Create PR dialog"
          }
        >
          Create PR
        </Button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="Current branch" value={headBranch} mono />
        <Stat label="Base branch" value={baseBranch} mono />
        <Stat
          label="PR"
          value={
            loading
              ? "Loading…"
              : prStatus?.pr
                ? `#${prStatus.pr.number} ${prStatus.pr.state.toLowerCase()}`
                : "none"
          }
          link={prStatus?.pr?.url ?? null}
        />
        <Stat
          label="Last gate run"
          value={
            lastGateRunAt
              ? new Date(lastGateRunAt).toLocaleString()
              : "never"
          }
        />
      </div>
      {onDefault && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 px-2 py-1 text-[11px] text-yellow-300 flex items-center gap-1.5">
          <ShieldAlert className="h-3 w-3" />
          You&apos;re on <code className="font-mono">{headBranch}</code>. Create a
          feature branch before opening a PR.
        </div>
      )}
      {!onDefault && decision === "pass" && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-[11px] text-emerald-300 flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3" />
          Latest scan passes the policy. Safe to open a PR.
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  mono,
  link,
}: {
  label: string
  value: string
  mono?: boolean
  link?: string | null
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/10 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-center gap-1">
        <span
          className={`text-xs ${mono ? "font-mono" : ""} truncate`}
          title={value}
        >
          {value}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" title={link}>
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </a>
        )}
      </div>
    </div>
  )
}
