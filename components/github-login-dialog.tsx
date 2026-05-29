"use client"

/**
 * GithubLoginDialog — in-app GitHub sign-in.
 *
 * MVP uses a Personal Access Token because it works everywhere
 * without us needing to register an OAuth App. The flow is:
 *
 *   1. User clicks "Open GitHub token page" — opens the PAT creation
 *      page in a new tab with the description and required scopes
 *      pre-filled. They click Generate, copy the token.
 *   2. They paste the token into the masked input here.
 *   3. We POST it to /api/github/auth/login which validates against
 *      GET /user, captures the login + scopes, and persists to
 *      ~/.config/edge-agent-ai/auth.json (mode 0600).
 *   4. Subsequent git push / PR create calls use the token via
 *      `git -c http.extraheader=...` and direct REST calls — no
 *      `gh` CLI required.
 *
 * If the user has already signed in we render a "Signed in as @user"
 * panel with a Sign out button instead of the form.
 *
 * Tokens are stored on the server filesystem only — never in
 * localStorage and never returned through the response body.
 */

import { useEffect, useState } from "react"
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
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  Loader2,
  LogOut,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"
import {
  fetchGitHubAuthStatus,
  loginWithGitHubToken,
  logoutGitHub,
  type GitHubAuthStatusResponse,
} from "@/lib/github-client"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called whenever the auth state changes (login or logout). The
   *  parent uses this to refresh badges, repo permissions, PR
   *  status, etc. without round-tripping. */
  onAuthChanged?: () => void
}

/**
 * Pre-filled GitHub PAT creation URL. We ask for the minimum scopes
 * needed for the PR workflow — `repo` lets us read/write repos and
 * open PRs, `read:org` is needed to list private orgs the user is a
 * member of. We do NOT request `delete_repo`, `admin:*`, or
 * `workflow` — those would be dangerous defaults.
 */
const GITHUB_NEW_TOKEN_URL =
  "https://github.com/settings/tokens/new?" +
  new URLSearchParams({
    description: "Edge Agent AI",
    scopes: "repo,read:org",
  }).toString()

const GITHUB_FINE_GRAINED_URL =
  "https://github.com/settings/personal-access-tokens/new"

export function GithubLoginDialog({ open, onOpenChange, onAuthChanged }: Props) {
  const [status, setStatus] = useState<GitHubAuthStatusResponse | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoadingStatus(true)
    try {
      const s = await fetchGitHubAuthStatus()
      setStatus(s)
    } catch {
      setStatus(null)
    } finally {
      setLoadingStatus(false)
    }
  }

  useEffect(() => {
    if (open) {
      setError(null)
      setToken("")
      setShowToken(false)
      void refresh()
    }
  }, [open])

  const handleSignIn = async () => {
    const t = token.trim()
    if (!t) {
      setError("Paste your token below.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const resp = await loginWithGitHubToken(t)
      if (resp.ok && resp.login) {
        // GitHub is an OPTIONAL integration for repo/PR access only — it does
        // NOT establish the cloud session or change billing identity. The
        // Edge Agent AI account (email/password) owns the subscription and
        // credits. The GitHub token stays on the local server's disk and is
        // never returned to the renderer.
        toast.success(`Connected GitHub as @${resp.login}.`)
        setToken("")
        await refresh()
        onAuthChanged?.()
      } else {
        setError(resp.message ?? "Sign in failed.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in request failed.")
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignOut = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const resp = await logoutGitHub()
      if (resp.ok) {
        // Disconnecting GitHub does NOT sign the user out of their Edge Agent
        // AI account — the account session is independent of this optional
        // integration.
        toast.success("Disconnected GitHub.")
        await refresh()
        onAuthChanged?.()
      } else {
        setError(resp.message ?? "Sign out failed.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign out request failed.")
    } finally {
      setSubmitting(false)
    }
  }

  const isAuthed = !!status?.authenticated && !!status?.login

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            {isAuthed ? "GitHub connection" : "Connect GitHub (optional)"}
          </DialogTitle>
          <DialogDescription>
            {isAuthed
              ? "Edge Agent AI uses this optional connection to push branches, open pull requests, and check repo permissions. It does not affect your account, plan, or credits."
              : "Optional: connect GitHub for repo/PR access so Edge Agent AI can push branches and open pull requests. Your subscription and credits live on your Edge Agent AI account — GitHub is not required to use hosted AI."}
          </DialogDescription>
        </DialogHeader>

        {loadingStatus && !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking sign-in status…
          </div>
        ) : isAuthed ? (
          /* ---------------------- Signed-in view ---------------------- */
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">
                  Signed in as <span className="font-mono">@{status?.login}</span>
                </div>
                <div className="text-xs opacity-90">
                  {status?.kind === "pat"
                    ? "Authentication: Personal Access Token"
                    : "Authentication: OAuth"}
                  {status?.scopes ? ` · scopes: ${status.scopes}` : ""}
                </div>
                {status?.savedAt && (
                  <div className="text-[11px] opacity-70">
                    Saved {new Date(status.savedAt).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
            <div className="rounded-md border border-border bg-secondary/10 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">Where it's stored</div>
              <div>
                The token lives on this machine at{" "}
                <code className="font-mono">~/.config/edge-agent-ai/auth.json</code>{" "}
                with mode <code>0600</code> (owner read/write only). Sign out
                here to delete it.
              </div>
            </div>
          </div>
        ) : (
          /* ---------------------- Sign-in form ---------------------- */
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-secondary/10 p-3 text-xs space-y-2">
              <div className="font-medium text-sm flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Step 1 — Create a Personal Access Token
              </div>
              <p className="text-muted-foreground">
                Open GitHub's token page. We pre-fill a description and
                ask for the <span className="font-mono">repo</span> +{" "}
                <span className="font-mono">read:org</span> scopes — the
                minimum needed to push branches and open pull requests.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                >
                  <a
                    href={GITHUB_NEW_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5"
                  >
                    Open GitHub token page
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="text-xs text-muted-foreground"
                >
                  <a
                    href={GITHUB_FINE_GRAINED_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5"
                  >
                    Or use a fine-grained token
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              </div>
              <p className="text-muted-foreground text-[11px]">
                On GitHub: scroll to the bottom, click{" "}
                <span className="font-medium">Generate token</span>, and
                copy the value (it starts with{" "}
                <code className="font-mono">ghp_</code> or{" "}
                <code className="font-mono">github_pat_</code>).
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gh-token" className="text-sm">
                Step 2 — Paste your token
              </Label>
              <div className="relative">
                <Input
                  id="gh-token"
                  type={showToken ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_… or github_pat_…"
                  disabled={submitting}
                  className="font-mono pr-10"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSignIn()
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showToken ? "Hide token" : "Show token"}
                  tabIndex={-1}
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The token is sent to the local Edge Agent AI server only.
                It's never stored in your browser. The server saves it to{" "}
                <code className="font-mono">
                  ~/.config/edge-agent-ai/auth.json
                </code>{" "}
                with mode <code>0600</code>.
              </p>
            </div>

            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-300">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {isAuthed ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Close
              </Button>
              <Button
                variant="destructive"
                onClick={handleSignOut}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogOut className="h-4 w-4" />
                )}
                Sign out
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button onClick={handleSignIn} disabled={submitting || !token}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  <>
                    <Github className="h-4 w-4" />
                    Sign in
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Compact "Signed in as @user" pill suitable for use in headers,
 * status cards, etc. Renders a "Sign in" button when not authed.
 *
 * Both variants are real <Button>s so callers can wire onClick to
 * open the dialog directly without an intermediate wrapper.
 */
export function GithubAuthBadge({
  status,
  onSignInClick,
  size = "sm",
}: {
  status: GitHubAuthStatusResponse | null
  onSignInClick: () => void
  size?: "sm" | "default"
}) {
  if (!status || !status.authenticated) {
    return (
      <Button size={size} variant="outline" onClick={onSignInClick}>
        <Github className="h-4 w-4" />
        Sign in to GitHub
      </Button>
    )
  }
  return (
    <Button
      size={size}
      variant="ghost"
      onClick={onSignInClick}
      className="gap-1.5"
    >
      <Github className="h-4 w-4" />
      <span className="font-mono text-xs">@{status.login}</span>
      <Badge variant="outline" className="text-[10px] py-0 border-emerald-500/40 text-emerald-300">
        signed in
      </Badge>
    </Button>
  )
}
