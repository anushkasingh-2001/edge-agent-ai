import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  classifyChangedFile,
  explainChange,
  resolveProjectPath,
  resolveRef,
  runGit,
  validateRef,
  validateRelPath,
  type ChangeStatus,
} from "@/lib/server-git"

const MAX_DIFF_BYTES = 256 * 1024 // 256 KiB

/**
 * POST /api/git/change-detail
 *
 * Body: { projectPath, base, target, file }
 *
 * Returns the per-file `git diff base..target -- <file>` plus a heuristic
 * "why this matters" line based on the file category. Truncates very
 * large diffs so the UI never receives megabytes of patch text.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      base?: string
      target?: string
      file?: string
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const baseInput = validateRef(body.base, "base")
    const targetInput = validateRef(body.target, "target")
    const file = validateRelPath(body.file, "file")

    const { canonical: base } = resolveRef(resolved, baseInput)
    const { canonical: target } = resolveRef(resolved, targetInput)

    // Determine the file's status against the diff first — the status drives
    // the "why" copy and lets the UI render Added/Deleted differently from
    // Modified.
    const statusRun = runGit(resolved, [
      "diff",
      "--name-status",
      "--no-renames",
      `${base}..${target}`,
      "--",
      file,
    ])
    if (statusRun.status !== 0) {
      throw new GitError(
        "git diff --name-status (per file) failed",
        500,
        statusRun.stderr.slice(0, 4000)
      )
    }
    const statusLine = statusRun.stdout.split("\n").find((l) => l.trim().length > 0)
    const status = (statusLine?.[0] as ChangeStatus | undefined) ?? "M"

    const diffRun = runGit(resolved, [
      "diff",
      `${base}..${target}`,
      "--",
      file,
    ])
    // For an Added/Deleted file in some scenarios git returns no diff via
    // the `..` syntax — that's fine, we still return what we have.
    if (diffRun.status !== 0 && diffRun.stderr.trim()) {
      throw new GitError(
        "git diff (per file) failed",
        500,
        diffRun.stderr.slice(0, 4000)
      )
    }

    let diff = diffRun.stdout
    let truncated = false
    if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
      const buf = Buffer.from(diff, "utf-8").subarray(0, MAX_DIFF_BYTES)
      diff = buf.toString("utf-8") + "\n... [diff truncated]"
      truncated = true
    }

    const category = classifyChangedFile(file)

    return NextResponse.json({
      file,
      status,
      category,
      diff,
      truncated,
      why: explainChange(status, category, file),
      base: baseInput,
      target: targetInput,
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
