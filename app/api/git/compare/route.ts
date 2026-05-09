import { NextResponse } from "next/server"
import {
  GitError,
  assertGitRepo,
  parseNameStatus,
  resolveProjectPath,
  resolveRef,
  runGit,
  validateRef,
  type ChangeCategory,
  type ChangeStatus,
} from "@/lib/server-git"

/**
 * POST /api/git/compare
 *
 * Body: { projectPath, base, target }
 *
 * Runs `git diff --name-status base..target` (with `--no-renames`) and
 * returns the changed files plus per-category / per-status counts.
 *
 * `base` and `target` are user-supplied branch names from the dropdown.
 * Because the branches API strips `origin/` from remote-only refs we
 * cannot assume the bare name resolves locally — `resolveRef` walks a
 * small set of canonical alternates (`origin/<name>`, `refs/remotes/...`)
 * and the resolved canonical refs are used for the actual diff so
 * `git diff main..325` works even when `325` only exists as
 * `origin/325`.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      base?: string
      target?: string
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const baseInput = validateRef(body.base, "base")
    const targetInput = validateRef(body.target, "target")

    const { canonical: base, sha: baseSha } = resolveRef(resolved, baseInput)
    const { canonical: target, sha: targetSha } = resolveRef(
      resolved,
      targetInput
    )

    if (baseSha === targetSha) {
      return NextResponse.json({
        base: baseInput,
        target: targetInput,
        baseSha,
        targetSha,
        files: [],
        summary: {
          total: 0,
          byCategory: {
            prompt: 0,
            tool: 0,
            schema: 0,
            mcp: 0,
            dependency: 0,
            code: 0,
          } satisfies Record<ChangeCategory, number>,
          byStatus: {
            A: 0,
            M: 0,
            D: 0,
            R: 0,
            C: 0,
            T: 0,
          } satisfies Record<ChangeStatus, number>,
        },
      })
    }

    // `--no-renames` keeps the parser simple. The user can still see renames
    // as add+delete pairs; we trade visibility of moves for predictable
    // STATUS\tFILE rows.
    const diffRun = runGit(resolved, [
      "diff",
      "--name-status",
      "--no-renames",
      `${base}..${target}`,
    ])
    if (diffRun.status !== 0) {
      throw new GitError(
        "git diff --name-status failed",
        500,
        diffRun.stderr.slice(0, 4000)
      )
    }

    const files = parseNameStatus(diffRun.stdout)

    const byCategory: Record<ChangeCategory, number> = {
      prompt: 0,
      tool: 0,
      schema: 0,
      mcp: 0,
      dependency: 0,
      code: 0,
    }
    const byStatus: Record<ChangeStatus, number> = {
      A: 0,
      M: 0,
      D: 0,
      R: 0,
      C: 0,
      T: 0,
    }
    for (const f of files) {
      byCategory[f.category] += 1
      byStatus[f.status] += 1
    }

    return NextResponse.json({
      base: baseInput,
      target: targetInput,
      baseSha,
      targetSha,
      files,
      summary: {
        total: files.length,
        byCategory,
        byStatus,
      },
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
