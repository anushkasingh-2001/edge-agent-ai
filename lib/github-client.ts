/**
 * Typed fetchers for /api/github/* endpoints. Plain fetch + JSON.
 * These never throw — they return the structured response so the UI
 * can branch on `ghInstalled` / `authenticated` / `resolved` /
 * `canPush` without try/catching every call site.
 */

export type GitHubStatusResponse = {
  ghInstalled: boolean
  authenticated: boolean
  login: string | null
  message: string
  /** Which auth source is currently active. */
  authSource?: "app" | "gh" | null
  /** Has the user signed in inside Edge Agent AI itself? */
  appAuthenticated?: boolean
  appLogin?: string | null
  /** Is the gh CLI authenticated as a fallback? */
  ghAuthenticated?: boolean
  ghLogin?: string | null
  /** Server-side error string when the route itself failed. */
  error?: string
}

/* -------------------------------------------------------------------------- */
/* In-app GitHub sign-in (PAT + future device flow)                           */
/* -------------------------------------------------------------------------- */

export type GitHubAuthStatusResponse = {
  ok: boolean
  authenticated: boolean
  login: string | null
  kind: "pat" | "oauth_device" | null
  savedAt: string | null
  scopes: string | null
}

export type GitHubLoginResponse = {
  ok: boolean
  authenticated?: boolean
  login?: string
  kind?: "pat" | "oauth_device"
  savedAt?: string
  scopes?: string | null
  message?: string
  reason?: string
}

export async function fetchGitHubAuthStatus(): Promise<GitHubAuthStatusResponse> {
  const res = await fetch("/api/github/auth/status", { method: "GET" })
  return (await res.json()) as GitHubAuthStatusResponse
}

/**
 * Submit a Personal Access Token. The token is validated against
 * GitHub /user on the server, then persisted to disk (mode 0600).
 * The token never round-trips back through the response.
 */
export async function loginWithGitHubToken(
  token: string
): Promise<GitHubLoginResponse> {
  const res = await fetch("/api/github/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
  return (await res.json()) as GitHubLoginResponse
}

export async function logoutGitHub(): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const res = await fetch("/api/github/auth/logout", { method: "POST" })
  return (await res.json()) as { ok: boolean; reason?: string; message?: string }
}

export type GitHubRepoPermissions = {
  admin: boolean
  maintain: boolean
  push: boolean
  triage: boolean
  pull: boolean
}

export type GitHubRepoPermissionResponse = {
  owner?: string
  repo?: string
  remoteUrl?: string
  protocol?: "https" | "ssh"
  permissions?: GitHubRepoPermissions
  canPush?: boolean
  /** True when gh actually returned a permissions object. */
  resolved?: boolean
  message?: string
  /** Set when the project remote isn't a parseable GitHub URL. */
  notGitHub?: boolean
  /** Set when there's no `origin` remote at all. */
  noRemote?: boolean
  /** Set when `gh` itself isn't installed. */
  ghMissing?: boolean
  /** Set when gh is installed but no account is logged in. */
  notAuthenticated?: boolean
  ghStderr?: string
  apiStatus?: number
  error?: string
}

export async function fetchGitHubStatus(): Promise<GitHubStatusResponse> {
  const res = await fetch("/api/github/status", { method: "GET" })
  return (await res.json()) as GitHubStatusResponse
}

export async function fetchGitHubRepoPermission(
  projectPath: string
): Promise<GitHubRepoPermissionResponse> {
  const res = await fetch("/api/github/repo-permission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath }),
  })
  return (await res.json()) as GitHubRepoPermissionResponse
}

/* -------------------------------------------------------------------------- */
/* Pull-request fetchers                                                      */
/* -------------------------------------------------------------------------- */

import type { Policy, PolicyEvaluation, Decision, PrAction } from "@/lib/policy"

export type GitHubPrSummary = {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  mergeStateStatus?: string
  createdAt?: string
  updatedAt?: string
}

export type GitHubPrStatusResponse = {
  branch: string | null
  repo: {
    owner: string
    repo: string
    remoteUrl: string
    protocol: "https" | "ssh"
  } | null
  pr: GitHubPrSummary | null
  ghInstalled: boolean
  authenticated: boolean
  message?: string
  error?: string
}

export type CreatePrApiResponse = {
  ok: boolean
  created?: boolean
  blocked?: boolean
  url?: string
  number?: number | null
  head?: string
  base?: string
  draft?: boolean
  reason?: string
  message?: string
  stderr?: string
  decision?: Decision
  prAction?: PrAction
  autoMerge?:
    | { enabled: true }
    | { enabled: false; reason: string; message?: string }
    | null
  report?: {
    risk_score: number
    summary: { critical: number; high: number; medium: number; low: number; total: number }
  } | null
  policy?: Policy
  policySource?: "file" | "default"
  policyErrors?: string[]
  evaluation?: PolicyEvaluation | null
  github?: {
    login: string | null
    owner: string
    repo: string
    remoteUrl: string
    protocol: "https" | "ssh"
    permissions?: GitHubRepoPermissions
    canPush?: boolean
  }
}

export async function fetchPrStatus(args: {
  projectPath: string
  branch?: string
}): Promise<GitHubPrStatusResponse> {
  const params = new URLSearchParams({ projectPath: args.projectPath })
  if (args.branch) params.set("branch", args.branch)
  const res = await fetch(`/api/github/pr/status?${params.toString()}`, {
    method: "GET",
  })
  return (await res.json()) as GitHubPrStatusResponse
}

export async function createPullRequestApi(args: {
  projectPath: string
  baseBranch: string
  /** Optional head branch override. Defaults to the project's HEAD. */
  headBranch?: string
  title: string
  body: string
  draft?: boolean
  runPolicyGate?: boolean
  enableAutoMergeIfAllowed?: boolean
  mergeMethod?: "squash" | "merge" | "rebase"
}): Promise<CreatePrApiResponse> {
  const res = await fetch("/api/github/pr/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return (await res.json()) as CreatePrApiResponse
}

export type EnableAutoMergeApiResponse = {
  ok: boolean
  message?: string
  reason?: string
  stderr?: string
  stdout?: string
}

export async function enableAutoMergeApi(args: {
  projectPath: string
  prUrl: string
  mergeMethod?: "squash" | "merge" | "rebase"
}): Promise<EnableAutoMergeApiResponse> {
  const res = await fetch("/api/github/pr/auto-merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  })
  return (await res.json()) as EnableAutoMergeApiResponse
}
