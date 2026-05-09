import fs from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  GitError,
  resolveProjectPath,
  runGit,
} from "@/lib/server-git"

/**
 * GET /api/git/status?projectPath=/abs/path
 *
 * Returns the basic state of the working tree for the Git Workflow card:
 *   - currentBranch (HEAD short name, or null when detached)
 *   - remote (origin URL, or null)
 *   - workingTreeStatus ("clean" | "uncommitted")
 *   - lastCommitSha (short)
 *   - lastCommitMessage (subject only)
 *
 * Non-Git folders return `isRepo: false` with the rest as null so the UI
 * can render an empty state instead of an error.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const { resolved } = resolveProjectPath(url.searchParams.get("projectPath"))

    const dotGit = path.join(resolved, ".git")
    if (!fs.existsSync(dotGit)) {
      return NextResponse.json({
        isRepo: false,
        currentBranch: null,
        remote: null,
        workingTreeStatus: null,
        lastCommitSha: null,
        lastCommitMessage: null,
      })
    }

    const head = runGit(resolved, ["rev-parse", "--abbrev-ref", "HEAD"])
    const currentBranch =
      head.status === 0 ? head.stdout.trim() || null : null

    const remoteRun = runGit(resolved, ["remote", "get-url", "origin"])
    const remote =
      remoteRun.status === 0 && remoteRun.stdout.trim()
        ? remoteRun.stdout.trim()
        : null

    const shortStatus = runGit(resolved, ["status", "--short"])
    const workingTreeStatus =
      shortStatus.status === 0
        ? shortStatus.stdout.trim().length === 0
          ? "clean"
          : "uncommitted"
        : null

    const sha = runGit(resolved, ["rev-parse", "--short", "HEAD"])
    const lastCommitSha =
      sha.status === 0 ? sha.stdout.trim() || null : null

    const subject = runGit(resolved, ["log", "-1", "--pretty=%s"])
    const lastCommitMessage =
      subject.status === 0 ? subject.stdout.trim() || null : null

    return NextResponse.json({
      isRepo: true,
      currentBranch,
      remote,
      workingTreeStatus,
      lastCommitSha,
      lastCommitMessage,
    })
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
