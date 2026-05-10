/**
 * Server-side helpers for the GitHub account / permission checks used by:
 *   - /api/github/status
 *   - /api/github/repo-permission
 *   - /api/git/push (pre-flight permission gate)
 *
 * This module is intentionally minimal:
 *   - We shell out to the user's `gh` CLI via spawnSync (args array — no
 *     shell strings, no interpolation) so the user's existing GitHub
 *     credentials live with `gh` / their system credential manager.
 *     We never store passwords or PATs ourselves.
 *   - When `gh` is missing we surface that clearly so the UI can show
 *     install instructions instead of crashing.
 *   - Remote URL parsing covers HTTPS and SSH GitHub URLs, with and
 *     without `.git` suffix or trailing slash.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { runGit, type ProjectPathResolution } from "@/lib/server-git"
import { getStoredAuth } from "@/lib/server-github-auth"

const GH_TIMEOUT_MS = 10_000
const GH_MAX_BUFFER = 4 * 1024 * 1024
const API_BASE = "https://api.github.com"
const API_TIMEOUT_MS = 15_000

/**
 * Common headers for every GitHub REST call. We don't add an
 * Authorization header here — callers do that conditionally so
 * unauthenticated probes (e.g. /rate_limit) still work.
 */
const API_BASE_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "edge-agent-ai",
}

/** Wraps fetch with a hard timeout via AbortController. */
async function ghFetch(
  url: string,
  init: RequestInit & { token?: string } = {}
): Promise<Response> {
  const { token, headers, ...rest } = init
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), API_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...rest,
      signal: ac.signal,
      headers: {
        ...API_BASE_HEADERS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    })
  } finally {
    clearTimeout(t)
  }
}

export class GitHubError extends Error {
  status: number
  stderr: string
  constructor(message: string, status = 500, stderr = "") {
    super(message)
    this.status = status
    this.stderr = stderr
  }
}

export type GhRunResult = {
  stdout: string
  stderr: string
  status: number | null
  /**
   * True only when `gh` couldn't be spawned at all (ENOENT / spawn
   * failure). Any other status (auth missing, 404, network error) still
   * leaves this false — those return their own non-zero `status` and
   * stderr from gh itself.
   */
  notInstalled: boolean
}

/**
 * Run a `gh` subcommand with a hard timeout. We never pass user input
 * into args without first validating it (see callers in this file).
 *
 * `GH_PROMPT_DISABLED=1` keeps gh from blocking on a TTY prompt — for
 * commands that need auth (e.g. `gh api repos/...`) gh will exit
 * non-zero with a clear stderr, which we surface as-is.
 */
export function runGh(args: string[]): GhRunResult {
  let proc: SpawnSyncReturns<string>
  try {
    proc = spawnSync("gh", args, {
      encoding: "utf-8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        // Force English so our error parsing isn't locale-sensitive.
        LANG: "C",
        LC_ALL: "C",
      },
    })
  } catch (e) {
    return {
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      status: null,
      notInstalled: true,
    }
  }
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        stdout: "",
        stderr: "gh executable not found on PATH",
        status: null,
        notInstalled: true,
      }
    }
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? proc.error.message,
      status: proc.status,
      notInstalled: false,
    }
  }
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status,
    notInstalled: false,
  }
}

/* -------------------------------------------------------------------------- */
/* GitHub remote URL parsing                                                  */
/* -------------------------------------------------------------------------- */

const OWNER_REPO_RE = /^[A-Za-z0-9._\-]+$/

export type GitHubRemote = {
  owner: string
  repo: string
  /** Original URL as returned by `git remote get-url origin`. */
  remoteUrl: string
  /** "https" | "ssh" — useful for the "switch to SSH" hint. */
  protocol: "https" | "ssh"
}

/**
 * Parse a GitHub remote URL into { owner, repo, protocol }.
 * Supports:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://username@github.com/owner/repo
 *   - git@github.com:owner/repo
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo
 *
 * Returns null for non-GitHub remotes (GitLab, Bitbucket, file://, etc.)
 * or unparseable strings — the caller decides how to communicate that.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  const stripGit = (s: string) =>
    s.endsWith(".git") ? s.slice(0, -4) : s
  const stripSlash = (s: string) =>
    s.endsWith("/") ? s.slice(0, -1) : s

  let owner = ""
  let repo = ""
  let protocol: "https" | "ssh" = "https"

  // git@github.com:owner/repo(.git)
  const sshMatch = trimmed.match(
    /^git@github\.com:([A-Za-z0-9._\-]+)\/([A-Za-z0-9._\-]+?)(?:\.git)?\/?$/
  )
  if (sshMatch) {
    owner = sshMatch[1]
    repo = sshMatch[2]
    protocol = "ssh"
  } else {
    let urlObj: URL | null = null
    try {
      urlObj = new URL(trimmed)
    } catch {
      return null
    }
    if (!/(^|\.)github\.com$/i.test(urlObj.hostname)) return null
    protocol = urlObj.protocol === "ssh:" ? "ssh" : "https"
    const pathParts = stripSlash(urlObj.pathname)
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
    if (pathParts.length < 2) return null
    owner = pathParts[0]
    repo = stripGit(pathParts[1])
  }

  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) return null
  return { owner, repo, remoteUrl: trimmed, protocol }
}

/**
 * Read `git -C <projectPath> remote get-url origin` and parse the result.
 * Returns null when the repo has no `origin` remote configured.
 */
export function readGitHubRemote(
  resolved: ProjectPathResolution["resolved"]
): GitHubRemote | null {
  const r = runGit(resolved, ["remote", "get-url", "origin"])
  if (r.status !== 0) return null
  const url = r.stdout.trim()
  if (!url) return null
  return parseGitHubRemote(url)
}

/* -------------------------------------------------------------------------- */
/* High-level helpers consumed by the API routes                              */
/* -------------------------------------------------------------------------- */

export type GitHubStatus = {
  ghInstalled: boolean
  /** True iff there's at least one usable auth source (app token OR gh CLI). */
  authenticated: boolean
  /** Login from the active auth source. */
  login: string | null
  message: string
  /** Active auth source — the UI prefers the app token when both
   *  exist because that's the one we use for git push + REST calls. */
  authSource: "app" | "gh" | null
  /** True when the user has signed in via Edge Agent AI itself
   *  (Personal Access Token or device-flow token stored on disk). */
  appAuthenticated: boolean
  /** Login captured the last time the app token was saved. */
  appLogin: string | null
  /** True when `gh` CLI is on PATH and `gh auth status` succeeds. */
  ghAuthenticated: boolean
  /** Login reported by `gh api user`. */
  ghLogin: string | null
}

/**
 * Combined GitHub auth probe. Considers two sources:
 *
 *   1. App token   — stored by /api/github/auth/login; preferred when
 *                    present because it's what we use for git push +
 *                    REST API calls (no `gh` dependency).
 *   2. gh CLI      — fallback for users who already have `gh` set up.
 *
 * The result tells the UI exactly which source is active so it can
 * render "Signed in as @user (via Edge Agent AI)" vs "via gh CLI".
 */
export function checkGitHubStatus(): GitHubStatus {
  /* ---------- App token (preferred) ---------- */
  const stored = getStoredAuth()
  const appAuthenticated = !!stored
  const appLogin = stored?.login ?? null

  /* ---------- gh CLI (fallback / additional) ---------- */
  let ghInstalled = false
  let ghAuthenticated = false
  let ghLogin: string | null = null
  let ghMessage = ""

  const versionRun = runGh(["--version"])
  if (!versionRun.notInstalled) {
    ghInstalled = true
    const authRun = runGh(["auth", "status"])
    if (authRun.status === 0) {
      const userRun = runGh(["api", "user", "--jq", ".login"])
      if (userRun.status === 0 && userRun.stdout.trim()) {
        ghAuthenticated = true
        ghLogin = userRun.stdout.trim()
      } else {
        ghMessage =
          userRun.stderr.trim() ||
          "gh CLI reports a session but `gh api user` returned no login."
      }
    } else {
      ghMessage = "gh CLI installed but no account is logged in."
    }
  } else {
    ghMessage = "gh CLI is not installed."
  }

  /* ---------- Combine ---------- */
  const authenticated = appAuthenticated || ghAuthenticated
  const authSource: "app" | "gh" | null = appAuthenticated
    ? "app"
    : ghAuthenticated
      ? "gh"
      : null
  const login = appAuthenticated ? appLogin : ghLogin

  let message: string
  if (appAuthenticated) {
    message = `Signed in as ${appLogin} via Edge Agent AI.`
  } else if (ghAuthenticated) {
    message = `Authenticated via gh CLI as ${ghLogin}.`
  } else if (ghInstalled) {
    message =
      "Sign in to GitHub from Settings, or run `gh auth login` to use the gh CLI."
  } else {
    message =
      "Sign in to GitHub from Settings — no GitHub credentials are configured yet."
  }

  return {
    ghInstalled,
    authenticated,
    login,
    message: ghMessage && !appAuthenticated ? `${message} (${ghMessage})` : message,
    authSource,
    appAuthenticated,
    appLogin,
    ghAuthenticated,
    ghLogin,
  }
}

export type GitHubRepoPermissions = {
  admin: boolean
  maintain: boolean
  push: boolean
  triage: boolean
  pull: boolean
}

export type GitHubRepoPermissionResult = {
  owner: string
  repo: string
  remoteUrl: string
  protocol: "https" | "ssh"
  permissions: GitHubRepoPermissions
  /** True if `permissions.admin || permissions.maintain || permissions.push`. */
  canPush: boolean
  /** True iff gh returned permissions object (not 404 / not authenticated). */
  resolved: boolean
  /** Human-readable status / error message. */
  message: string
  /** When gh exits non-zero we surface its stderr so the UI can show the cause. */
  ghStderr?: string
  /** HTTP status from the GitHub API call when gh surfaced one. */
  apiStatus?: number
}

const EMPTY_PERMS: GitHubRepoPermissions = {
  admin: false,
  maintain: false,
  push: false,
  triage: false,
  pull: false,
}

export function unknownPermissionResult(
  remote: GitHubRemote,
  message: string,
  ghStderr?: string,
  apiStatus?: number
): GitHubRepoPermissionResult {
  return {
    owner: remote.owner,
    repo: remote.repo,
    remoteUrl: remote.remoteUrl,
    protocol: remote.protocol,
    permissions: EMPTY_PERMS,
    canPush: false,
    resolved: false,
    message,
    ghStderr,
    apiStatus,
  }
}

/**
 * Look up the authenticated user's permissions on the given repo.
 *
 * Resolution order:
 *   1. App token (PAT/OAuth stored via /api/github/auth/login) →
 *      direct REST call. This is the primary path now that users can
 *      sign in inside the app.
 *   2. gh CLI (`gh api repos/<owner>/<repo>`) — fallback for users
 *      who already had gh configured.
 *
 * Either way: permissions live on the JSON object returned for the
 * *authenticated* user's view of the repo, so this implicitly tells
 * us whether *that* account has access — even when a different
 * account is cached in git credentials.
 */
export async function fetchRepoPermissions(
  remote: GitHubRemote
): Promise<GitHubRepoPermissionResult> {
  // Tight validation of owner/repo before letting them into args.
  if (!OWNER_REPO_RE.test(remote.owner) || !OWNER_REPO_RE.test(remote.repo)) {
    return unknownPermissionResult(
      remote,
      "Refusing to query GitHub: parsed owner/repo contains illegal characters."
    )
  }

  /* ----------------------- App-token path ----------------------- */
  const stored = getStoredAuth()
  if (stored) {
    try {
      const res = await ghFetch(
        `${API_BASE}/repos/${remote.owner}/${remote.repo}`,
        { token: stored.token }
      )
      if (res.status === 401) {
        return unknownPermissionResult(
          remote,
          "Stored GitHub token was rejected (401). Sign in again from Settings → GitHub Account.",
          "",
          401
        )
      }
      if (res.status === 404) {
        return unknownPermissionResult(
          remote,
          `GitHub returned 404 for ${remote.owner}/${remote.repo}. The signed-in account (@${stored.login}) may not have access, or the repo path is wrong.`,
          "",
          404
        )
      }
      if (res.status === 403) {
        return unknownPermissionResult(
          remote,
          `GitHub returned 403 for ${remote.owner}/${remote.repo}. The signed-in account (@${stored.login}) lacks access — check the token's scopes (must include 'repo').`,
          "",
          403
        )
      }
      if (!res.ok) {
        return unknownPermissionResult(
          remote,
          `GitHub returned HTTP ${res.status} for ${remote.owner}/${remote.repo}.`,
          "",
          res.status
        )
      }
      const json = (await res.json()) as { permissions?: Partial<GitHubRepoPermissions> }
      const p: GitHubRepoPermissions = {
        admin: !!json?.permissions?.admin,
        maintain: !!json?.permissions?.maintain,
        push: !!json?.permissions?.push,
        triage: !!json?.permissions?.triage,
        pull: !!json?.permissions?.pull,
      }
      const canPush = p.admin || p.maintain || p.push
      return {
        owner: remote.owner,
        repo: remote.repo,
        remoteUrl: remote.remoteUrl,
        protocol: remote.protocol,
        permissions: p,
        canPush,
        resolved: true,
        message: canPush
          ? `@${stored.login} has push access to ${remote.owner}/${remote.repo}.`
          : `@${stored.login} does NOT have push access to ${remote.owner}/${remote.repo}.`,
      }
    } catch (e) {
      // Network failure with app token — fall through to gh CLI rather
      // than failing closed, in case the user has gh configured too.
      const err = e instanceof Error ? e.message : String(e)
      // If gh isn't going to help either, return now with the network error.
      const ghVersion = runGh(["--version"])
      if (ghVersion.notInstalled) {
        return unknownPermissionResult(
          remote,
          `Could not reach GitHub: ${err}`,
          err
        )
      }
    }
  }

  /* --------------------------- gh CLI --------------------------- */
  const path = `repos/${remote.owner}/${remote.repo}`
  const run = runGh(["api", path, "--jq", "{permissions}"])
  if (run.notInstalled) {
    return unknownPermissionResult(
      remote,
      "Sign in to GitHub from Settings to check repo permissions, or install the gh CLI."
    )
  }
  if (run.status !== 0) {
    const err = run.stderr.trim()
    // gh prints "HTTP 404" / "HTTP 401" in stderr for API failures.
    const httpMatch = err.match(/HTTP (\d{3})/)
    const apiStatus = httpMatch ? Number(httpMatch[1]) : undefined
    let message = err || "Failed to query GitHub repo permissions."
    if (apiStatus === 404) {
      message = `GitHub returned 404 for ${remote.owner}/${remote.repo}. The authenticated account may not have access, or the repo path is wrong.`
    } else if (apiStatus === 401) {
      message =
        "GitHub returned 401. Run `gh auth login` to refresh your CLI credentials."
    } else if (apiStatus === 403) {
      message =
        "GitHub returned 403. The authenticated account does not have access to this repo."
    }
    return unknownPermissionResult(remote, message, err, apiStatus)
  }
  let parsed: { permissions?: Partial<GitHubRepoPermissions> } | null = null
  try {
    parsed = JSON.parse(run.stdout) as {
      permissions?: Partial<GitHubRepoPermissions>
    }
  } catch {
    return unknownPermissionResult(
      remote,
      "Could not parse permissions JSON from gh output.",
      run.stdout.slice(0, 200)
    )
  }
  const p: GitHubRepoPermissions = {
    admin: !!parsed?.permissions?.admin,
    maintain: !!parsed?.permissions?.maintain,
    push: !!parsed?.permissions?.push,
    triage: !!parsed?.permissions?.triage,
    pull: !!parsed?.permissions?.pull,
  }
  // A read-only collaborator (or anonymous read of a public repo) gets
  // an object with everything false; we treat that as "no push" cleanly.
  const canPush = p.admin || p.maintain || p.push
  return {
    owner: remote.owner,
    repo: remote.repo,
    remoteUrl: remote.remoteUrl,
    protocol: remote.protocol,
    permissions: p,
    canPush,
    resolved: true,
    message: canPush
      ? `Authenticated account has push access to ${remote.owner}/${remote.repo}.`
      : `Authenticated account does NOT have push access to ${remote.owner}/${remote.repo}.`,
  }
}

/* -------------------------------------------------------------------------- */
/* REST error helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * GitHub returns errors as `{ "message": "...", "errors": [...] }`.
 * Pick the most informative human string available without crashing
 * on non-JSON bodies.
 */
function extractGitHubErrorMessage(body: string): string {
  if (!body) return ""
  try {
    const j = JSON.parse(body) as {
      message?: string
      errors?: { message?: string }[]
    }
    const parts: string[] = []
    if (j.message) parts.push(j.message)
    if (Array.isArray(j.errors)) {
      for (const e of j.errors) {
        if (e?.message && !parts.includes(e.message)) parts.push(e.message)
      }
    }
    return parts.join(" — ")
  } catch {
    return body.slice(0, 200)
  }
}

/* -------------------------------------------------------------------------- */
/* git push 403 detection                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `git push` over HTTPS surfaces auth/permission failures with a
 * recognisable shape, e.g.:
 *
 *   remote: Permission to owner/repo.git denied to wrong-user.
 *   fatal: unable to access 'https://github.com/owner/repo.git/': The
 *   requested URL returned error: 403
 *
 * We sniff for the 403 / "Permission to ... denied" / "remote: error:"
 * patterns so the UI can show a tailored message instead of dumping
 * raw stderr.
 */
export function isGitHubPermissionError(stderr: string): boolean {
  if (!stderr) return false
  if (/error:\s*403\b/i.test(stderr)) return true
  if (/HTTP 403\b/.test(stderr)) return true
  if (/error:\s*The requested URL returned error:\s*403/i.test(stderr))
    return true
  if (/Permission to .+ denied/i.test(stderr)) return true
  if (/remote:\s*Permission denied/i.test(stderr)) return true
  return false
}

/* -------------------------------------------------------------------------- */
/* Pull-request helpers (gh pr create / merge / status)                       */
/* -------------------------------------------------------------------------- */

/**
 * Subset of the JSON fields we ask `gh pr` for. Matches the JSON
 * keys gh exposes via `--json` so we can decode without remapping.
 */
export interface GhPullRequestSummary {
  number: number
  url: string
  title: string
  state: "OPEN" | "CLOSED" | "MERGED" | string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  mergeStateStatus?: string
  /** ISO timestamp from gh. */
  createdAt?: string
  updatedAt?: string
}

export type CreatePrResult =
  | {
      ok: true
      url: string
      /** Number parsed from the URL when gh returned just a URL. */
      number: number | null
      stdout: string
    }
  | {
      ok: false
      message: string
      stderr: string
      /** "no_remote", "no_branch", "auth", "perm", "create_failed", … */
      reason: string
    }

const PR_NUM_RE = /\/pull\/(\d+)\b/

/**
 * Open a pull request. Tries the in-app token first (REST API), then
 * falls back to `gh pr create`. `--head` / args come from the caller
 * already validated through `validateRef` upstream.
 */
export async function createPullRequest(args: {
  cwd: string
  owner: string
  repo: string
  base: string
  head: string
  title: string
  body: string
  draft: boolean
}): Promise<CreatePrResult> {
  const { cwd, owner, repo, base, head, title, body, draft } = args
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) {
    return {
      ok: false,
      message:
        "Refusing to create PR: parsed owner/repo contains illegal characters.",
      stderr: "",
      reason: "validation",
    }
  }

  /* ----------------------- App-token path ----------------------- */
  const stored = getStoredAuth()
  if (stored) {
    try {
      const res = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        token: stored.token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, head, base, draft }),
      })
      if (res.status === 201) {
        const pr = (await res.json()) as { number?: number; html_url?: string }
        const url = pr.html_url ?? ""
        return {
          ok: true,
          url,
          number: typeof pr.number === "number" ? pr.number : null,
          stdout: url,
        }
      }
      const errBody = await res.text().catch(() => "")
      let message = `GitHub returned HTTP ${res.status} when creating the PR.`
      let reason = "create_failed"
      if (res.status === 401) {
        reason = "auth"
        message =
          "Stored GitHub token was rejected (401). Sign in again from Settings → GitHub Account."
      } else if (res.status === 403) {
        reason = "perm"
        message = `@${stored.login} does not have permission to open PRs on ${owner}/${repo}. Check the token's scopes.`
      } else if (res.status === 422) {
        // Unprocessable Entity — typically "no commits between" or
        // "PR already exists". Sniff the body for the canonical strings.
        if (/no commits between/i.test(errBody)) reason = "no_commits"
        else if (/already exists/i.test(errBody)) reason = "already_exists"
        message =
          extractGitHubErrorMessage(errBody) ||
          "GitHub rejected the PR (422). Branch may have no commits or a PR may already exist."
      }
      return { ok: false, message, stderr: errBody.slice(0, 4000), reason }
    } catch (e) {
      // Network failure — fall through to gh CLI if available.
      const err = e instanceof Error ? e.message : String(e)
      const ghVersion = runGh(["--version"])
      if (ghVersion.notInstalled) {
        return {
          ok: false,
          message: `Could not reach GitHub to open the PR: ${err}`,
          stderr: err,
          reason: "network",
        }
      }
    }
  }

  /* --------------------------- gh CLI --------------------------- */
  const ghArgs = [
    "pr",
    "create",
    "--repo",
    `${owner}/${repo}`,
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ]
  if (draft) ghArgs.push("--draft")

  // gh needs to run inside the project so it can locate the local
  // branch / git config. spawnSync respects the `cwd` option; we don't
  // use shell strings.
  const proc = (() => {
    try {
      return spawnSync("gh", ghArgs, {
        encoding: "utf-8",
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        cwd,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          LANG: "C",
          LC_ALL: "C",
        },
      })
    } catch (e) {
      return {
        error: e instanceof Error ? e : new Error(String(e)),
      } as unknown as SpawnSyncReturns<string>
    }
  })()

  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        ok: false,
        message:
          "GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com/ and run `gh auth login`.",
        stderr: "",
        reason: "gh_missing",
      }
    }
    return {
      ok: false,
      message: proc.error.message,
      stderr: proc.stderr ?? "",
      reason: "spawn_failed",
    }
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr ?? ""
    let reason = "create_failed"
    if (/HTTP 401\b/.test(stderr) || /not logged into/.test(stderr)) {
      reason = "auth"
    } else if (/HTTP 403\b/.test(stderr)) {
      reason = "perm"
    } else if (/no commits between/i.test(stderr)) {
      reason = "no_commits"
    } else if (/already exists/i.test(stderr)) {
      reason = "already_exists"
    }
    return {
      ok: false,
      message:
        proc.stderr.trim() || `gh pr create exited with status ${proc.status}`,
      stderr,
      reason,
    }
  }
  const stdout = proc.stdout ?? ""
  const url = stdout.trim().split("\n").pop() ?? ""
  const numMatch = url.match(PR_NUM_RE)
  return {
    ok: true,
    url,
    number: numMatch ? Number(numMatch[1]) : null,
    stdout: stdout.trim(),
  }
}

export type EnableAutoMergeResult =
  | { ok: true; stdout: string }
  | { ok: false; message: string; stderr: string; reason: string }

/**
 * Ask GitHub to auto-merge the PR once branch protection / required
 * checks are satisfied. We never pass `--admin` — auto-merge has to go
 * through normal repository rules.
 */
export function enableAutoMerge(args: {
  cwd: string
  prUrl: string
  method: "merge" | "squash" | "rebase"
}): EnableAutoMergeResult {
  const { cwd, prUrl, method } = args
  if (!/^https:\/\/github\.com\//.test(prUrl)) {
    return {
      ok: false,
      message: "prUrl must be a https://github.com/... PR URL.",
      stderr: "",
      reason: "validation",
    }
  }
  const flag =
    method === "squash" ? "--squash" : method === "rebase" ? "--rebase" : "--merge"
  const ghArgs = ["pr", "merge", prUrl, "--auto", flag]
  const proc = runGhWithCwd(ghArgs, cwd)
  if (proc.notInstalled) {
    return {
      ok: false,
      message: "GitHub CLI (`gh`) is not installed.",
      stderr: "",
      reason: "gh_missing",
    }
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      message:
        proc.stderr.trim() ||
        `gh pr merge --auto exited with status ${proc.status}`,
      stderr: proc.stderr,
      reason: "merge_failed",
    }
  }
  return { ok: true, stdout: proc.stdout.trim() }
}

export type PrStatusResult =
  | { ok: true; pr: GhPullRequestSummary | null }
  | { ok: false; message: string; reason: string }

/**
 * Find the PR whose head branch matches `branch` in the given repo.
 * Uses the in-app token via REST when present, falling back to
 * `gh pr list` (which works for any named branch, unlike
 * `gh pr status` which requires the branch to be checked out).
 */
export async function fetchPullRequestForBranch(args: {
  cwd: string
  owner: string
  repo: string
  branch: string
}): Promise<PrStatusResult> {
  const { cwd, owner, repo, branch } = args
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repo)) {
    return {
      ok: false,
      message: "Invalid owner/repo.",
      reason: "validation",
    }
  }

  /* ----------------------- App-token path ----------------------- */
  const stored = getStoredAuth()
  if (stored) {
    try {
      // GitHub's PR list API filters head as "owner:branch".
      const headFilter = `${owner}:${branch}`
      const url = `${API_BASE}/repos/${owner}/${repo}/pulls?state=all&per_page=1&head=${encodeURIComponent(headFilter)}`
      const res = await ghFetch(url, { token: stored.token })
      if (res.status === 401) {
        return {
          ok: false,
          message: "Stored GitHub token was rejected (401). Sign in again.",
          reason: "auth",
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          message: `GitHub returned HTTP ${res.status} when listing PRs.`,
          reason: "list_failed",
        }
      }
      type RestPr = {
        number: number
        html_url: string
        title: string
        state: string
        draft: boolean
        base: { ref: string }
        head: { ref: string }
        mergeable_state?: string
        created_at?: string
        updated_at?: string
      }
      const list = (await res.json()) as RestPr[]
      if (!Array.isArray(list) || list.length === 0) {
        return { ok: true, pr: null }
      }
      const p = list[0]
      const summary: GhPullRequestSummary = {
        number: p.number,
        url: p.html_url,
        title: p.title,
        state: p.state.toUpperCase(),
        isDraft: !!p.draft,
        baseRefName: p.base.ref,
        headRefName: p.head.ref,
        mergeStateStatus: p.mergeable_state,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      }
      return { ok: true, pr: summary }
    } catch (e) {
      // Network failure — try gh fallback below.
      const ghVersion = runGh(["--version"])
      if (ghVersion.notInstalled) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          reason: "network",
        }
      }
    }
  }

  /* --------------------------- gh CLI --------------------------- */
  const ghArgs = [
    "pr",
    "list",
    "--repo",
    `${owner}/${repo}`,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "1",
    "--json",
    "number,url,title,state,isDraft,baseRefName,headRefName,mergeStateStatus,createdAt,updatedAt",
  ]
  const proc = runGhWithCwd(ghArgs, cwd)
  if (proc.notInstalled) {
    return {
      ok: false,
      message: "GitHub CLI (`gh`) is not installed.",
      reason: "gh_missing",
    }
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      message:
        proc.stderr.trim() || `gh pr list exited with status ${proc.status}`,
      reason: "list_failed",
    }
  }
  let parsed: GhPullRequestSummary[] | null = null
  try {
    parsed = JSON.parse(proc.stdout) as GhPullRequestSummary[]
  } catch {
    return {
      ok: false,
      message: "Could not parse JSON from gh pr list.",
      reason: "parse_failed",
    }
  }
  return { ok: true, pr: parsed && parsed.length > 0 ? parsed[0] : null }
}

/**
 * Variant of `runGh` that allows specifying cwd. Kept private to this
 * file — callers go through the higher-level helpers above.
 */
function runGhWithCwd(args: string[], cwd: string): GhRunResult {
  let proc: SpawnSyncReturns<string>
  try {
    proc = spawnSync("gh", args, {
      encoding: "utf-8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        LANG: "C",
        LC_ALL: "C",
      },
    })
  } catch (e) {
    return {
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      status: null,
      notInstalled: true,
    }
  }
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        stdout: "",
        stderr: "gh executable not found on PATH",
        status: null,
        notInstalled: true,
      }
    }
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? proc.error.message,
      status: proc.status,
      notInstalled: false,
    }
  }
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    status: proc.status,
    notInstalled: false,
  }
}
