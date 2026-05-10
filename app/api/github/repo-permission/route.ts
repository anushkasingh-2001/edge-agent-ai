/**
 * POST /api/github/repo-permission
 *
 * Body:
 *   { projectPath: string }
 *
 * Behaviour:
 *   1. Resolve + authorise projectPath (allow-root sandbox).
 *   2. Ensure it's a git repo, read `git remote get-url origin`.
 *   3. Parse the remote into { owner, repo, protocol }.
 *   4. Hit `gh api repos/<owner>/<repo>` and surface the
 *      `permissions` object plus a derived `canPush` boolean.
 *
 * Failure modes are non-fatal — the route always returns 200 with a
 * structured payload so the UI can render "Not a GitHub repo", "gh
 * not installed", "401" etc. without try/catching every call site.
 * The exception is the path-validation step, where we *do* return
 * the appropriate 4xx so a malicious caller can't trick us into
 * inspecting random folders.
 */

import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  resolveProjectPath,
} from "@/lib/server-git"
import {
  checkGitHubStatus,
  fetchRepoPermissions,
  readGitHubRemote,
} from "@/lib/server-github"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const remote = readGitHubRemote(resolved)
    if (!remote) {
      return NextResponse.json({
        notGitHub: true,
        canPush: false,
        resolved: false,
        message:
          "Project has no `origin` remote, or `origin` doesn't point at GitHub. Permission check skipped.",
      })
    }

    // Fast-fail when no auth source is available. checkGitHubStatus
    // now considers both the in-app token and gh CLI, so this only
    // fires when truly nothing is configured.
    const status = checkGitHubStatus()
    if (!status.authenticated) {
      return NextResponse.json({
        owner: remote.owner,
        repo: remote.repo,
        remoteUrl: remote.remoteUrl,
        protocol: remote.protocol,
        canPush: false,
        resolved: false,
        ghMissing: !status.ghInstalled,
        notAuthenticated: true,
        message: status.message,
      })
    }

    const result = await fetchRepoPermissions(remote)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json(
        { error: err.message, stderr: err.stderr || undefined },
        { status: err.status }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
