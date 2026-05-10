/**
 * GET /api/github/pr/status?projectPath=...&branch=...
 *
 * Returns the most recent PR (open or closed) whose head branch is the
 * provided one. If `branch` isn't passed we use the project's HEAD.
 *
 * Response (2xx):
 *   {
 *     branch: string
 *     repo: { owner, repo, remoteUrl, protocol } | null
 *     pr: GhPullRequestSummary | null
 *     ghInstalled: boolean
 *     authenticated: boolean
 *   }
 *
 * 4xx are returned for path validation failures only — every other
 * "couldn't determine" case (gh missing, no remote, list_failed)
 * surfaces inline so the UI can show a single status card without
 * cascading toasts.
 */

import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"
import {
  checkGitHubStatus,
  fetchPullRequestForBranch,
  readGitHubRemote,
  type GhPullRequestSummary,
} from "@/lib/server-github"

function detectCurrentBranch(cwd: string): string | null {
  const r = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (r.status !== 0) return null
  const b = r.stdout.trim()
  if (!b || b === "HEAD") return null
  return b
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const { resolved } = resolveProjectPath(url.searchParams.get("projectPath"))
    assertGitRepo(resolved)
    const branchArg = url.searchParams.get("branch")
    const branch = branchArg?.trim() || detectCurrentBranch(resolved)
    if (!branch) {
      return NextResponse.json({
        branch: null,
        repo: null,
        pr: null,
        ghInstalled: false,
        authenticated: false,
        message: "Could not determine current branch.",
      })
    }

    const remote = readGitHubRemote(resolved)
    if (!remote) {
      return NextResponse.json({
        branch,
        repo: null,
        pr: null,
        ghInstalled: false,
        authenticated: false,
        message: "No GitHub origin remote configured.",
      })
    }

    const status = checkGitHubStatus()
    if (!status.authenticated) {
      return NextResponse.json({
        branch,
        repo: {
          owner: remote.owner,
          repo: remote.repo,
          remoteUrl: remote.remoteUrl,
          protocol: remote.protocol,
        },
        pr: null,
        ghInstalled: status.ghInstalled,
        authenticated: status.authenticated,
        message: status.message,
      })
    }

    const list = await fetchPullRequestForBranch({
      cwd: resolved,
      owner: remote.owner,
      repo: remote.repo,
      branch,
    })
    let pr: GhPullRequestSummary | null = null
    let message = ""
    if (list.ok) {
      pr = list.pr
      message = pr ? `PR #${pr.number} (${pr.state.toLowerCase()})` : "No PR for this branch."
    } else {
      message = list.message
    }

    return NextResponse.json({
      branch,
      repo: {
        owner: remote.owner,
        repo: remote.repo,
        remoteUrl: remote.remoteUrl,
        protocol: remote.protocol,
      },
      pr,
      ghInstalled: status.ghInstalled,
      authenticated: status.authenticated,
      message,
    })
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
