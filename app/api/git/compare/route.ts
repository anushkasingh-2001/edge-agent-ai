import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import {
  GitError,
  applyBranchStashesInWorktree,
  assertGitRepo,
  parseNameStatus,
  resolveProjectPath,
  resolveRef,
  runGit,
  validateRef,
  writeWorktreeTreeSha,
  type ChangeCategory,
  type ChangeStatus,
  type StashApplyResult,
} from "@/lib/server-git"

/**
 * POST /api/git/compare
 *
 * Body: {
 *   projectPath, base, target,
 *   baseIncludeStashes?: boolean, targetIncludeStashes?: boolean
 * }
 *
 * Default mode (no stash flags): runs `git diff --name-status base..target`
 * (with `--no-renames`) and returns the changed files plus per-category /
 * per-status counts. Fast — no worktree materialisation.
 *
 * "Commits + stashes" mode (either flag = true): for each side that
 * asked for it, materialise a temporary worktree at the branch SHA,
 * layer every `git stash` entry attributed to that branch onto it
 * (oldest → newest, latest version of each file wins), then write a
 * synthetic tree object via `git write-tree`. Diff the two
 * (synthetic or real) tree SHAs with `git diff-tree --name-status`,
 * which gives us the same A/M/D output the regular path produces.
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
  let baseWt: string | null = null
  let targetWt: string | null = null
  try {
    const body = (await request.json().catch(() => ({}))) as {
      projectPath?: string
      base?: string
      target?: string
      baseIncludeStashes?: boolean
      targetIncludeStashes?: boolean
    }
    const { resolved } = resolveProjectPath(body.projectPath)
    assertGitRepo(resolved)

    const baseInput = validateRef(body.base, "base")
    const targetInput = validateRef(body.target, "target")
    const baseIncludeStashes = body.baseIncludeStashes === true
    const targetIncludeStashes = body.targetIncludeStashes === true

    const { canonical: base, sha: baseSha } = resolveRef(resolved, baseInput)
    const { canonical: target, sha: targetSha } = resolveRef(
      resolved,
      targetInput
    )

    // Same-SHA fast path only fires when neither side asks to layer
    // stashes. Once stashes enter the picture the effective trees can
    // differ even when the branch HEADs are identical (e.g. comparing
    // `main` against `main + stashes`).
    if (
      baseSha === targetSha &&
      !baseIncludeStashes &&
      !targetIncludeStashes
    ) {
      return NextResponse.json({
        base: baseInput,
        target: targetInput,
        baseSha,
        targetSha,
        files: [],
        summary: emptySummary(),
        baseStashes: stashSummary(null),
        targetStashes: stashSummary(null),
      })
    }

    let nameStatusOut: string
    let baseStashApply: StashApplyResult | null = null
    let targetStashApply: StashApplyResult | null = null

    if (!baseIncludeStashes && !targetIncludeStashes) {
      // Cheap path: ordinary commit-vs-commit diff. `--no-renames`
      // keeps the parser simple. The user can still see renames as
      // add+delete pairs; we trade visibility of moves for predictable
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
      nameStatusOut = diffRun.stdout
    } else {
      // Synthetic-tree path: build a worktree per side (only when
      // needed — if a side opted out, we still need a worktree there
      // but with no stashes layered, since `diff-tree` requires both
      // operands to be tree-ish refs and using the bare SHA on one
      // side mixed with a synthetic-tree on the other would mismatch
      // the diff direction). Easier to build both consistently.
      const stamp = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      baseWt = path.join(os.tmpdir(), `edge-cmp-diff-base-${stamp}-${rand}`)
      targetWt = path.join(
        os.tmpdir(),
        `edge-cmp-diff-target-${stamp}-${rand}`
      )

      addWorktree(resolved, baseWt, baseSha)
      addWorktree(resolved, targetWt, targetSha)

      baseStashApply = baseIncludeStashes
        ? applyBranchStashesInWorktree(resolved, baseWt, baseInput)
        : { applied: [], skipped: [] }
      targetStashApply = targetIncludeStashes
        ? applyBranchStashesInWorktree(resolved, targetWt, targetInput)
        : { applied: [], skipped: [] }

      const baseTree = writeWorktreeTreeSha(baseWt)
      const targetTree = writeWorktreeTreeSha(targetWt)
      if (!baseTree || !targetTree) {
        throw new GitError(
          "Failed to write synthetic tree(s) for stash-aware diff",
          500
        )
      }

      // Same synthetic tree on both sides → no file-level changes,
      // skip the diff and short-circuit. Echoing `files: []` matches
      // the `sameSha` shape and keeps the UI's empty-state path.
      if (baseTree === targetTree) {
        return NextResponse.json({
          base: baseInput,
          target: targetInput,
          baseSha,
          targetSha,
          files: [],
          summary: emptySummary(),
          baseStashes: stashSummary(
            baseIncludeStashes ? baseStashApply : null
          ),
          targetStashes: stashSummary(
            targetIncludeStashes ? targetStashApply : null
          ),
        })
      }

      // `diff-tree` against two arbitrary tree SHAs gives the same
      // STATUS\tFILE format `git diff` emits, so the existing
      // `parseNameStatus` parser doesn't care which path we took.
      const diffRun = runGit(resolved, [
        "diff-tree",
        "-r",
        "--name-status",
        "--no-renames",
        baseTree,
        targetTree,
      ])
      if (diffRun.status !== 0) {
        throw new GitError(
          "git diff-tree --name-status failed",
          500,
          diffRun.stderr.slice(0, 4000)
        )
      }
      nameStatusOut = diffRun.stdout
    }

    const files = parseNameStatus(nameStatusOut)

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
      baseStashes: stashSummary(baseIncludeStashes ? baseStashApply : null),
      targetStashes: stashSummary(
        targetIncludeStashes ? targetStashApply : null
      ),
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
  } finally {
    if (baseWt) safeRemoveWorktree(baseWt)
    if (targetWt) safeRemoveWorktree(targetWt)
  }
}

function emptySummary() {
  return {
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
  }
}

/**
 * Same shape as the compare-scan response so the UI can consume both
 * endpoints with one rendering helper. `null` ↔ caller didn't ask to
 * include stashes for this side; `included: true, applied: []` ↔
 * caller asked but the branch has zero stashes.
 */
function stashSummary(apply: StashApplyResult | null) {
  if (!apply) {
    return {
      included: false,
      appliedCount: 0,
      skippedCount: 0,
      applied: [] as { ref: string; subject: string }[],
      skipped: [] as { ref: string; subject: string; reason: string }[],
    }
  }
  return {
    included: true,
    appliedCount: apply.applied.length,
    skippedCount: apply.skipped.length,
    applied: apply.applied.map((s) => ({ ref: s.ref, subject: s.subject })),
    skipped: apply.skipped.map((s) => ({
      ref: s.entry.ref,
      subject: s.entry.subject,
      reason: s.reason,
    })),
  }
}

function addWorktree(repo: string, dest: string, sha: string) {
  const r = runGit(
    repo,
    ["worktree", "add", "--detach", dest, sha],
    { timeoutMs: 60_000 }
  )
  if (r.status !== 0) {
    throw new GitError(
      `git worktree add failed for ${sha}`,
      500,
      r.stderr.slice(0, 4000)
    )
  }
}

/**
 * Cleanup is best-effort and runs in the request's finally block.
 * `worktree remove --force` because the scanner / write-tree flow may
 * leave .pyc files etc. that block a clean remove. If the dir
 * survives that (rare, e.g. cross-filesystem) we nuke it directly,
 * then `worktree prune` to keep the repo's worktree list tidy.
 */
function safeRemoveWorktree(dest: string) {
  try {
    if (!fs.existsSync(dest)) return
    spawnSync("git", ["--no-pager", "worktree", "remove", "--force", dest], {
      encoding: "utf-8",
      timeout: 30_000,
    })
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
    const parent = path.dirname(dest)
    spawnSync("git", ["--no-pager", "-C", parent, "worktree", "prune"], {
      encoding: "utf-8",
      timeout: 10_000,
    })
  } catch {
    /* ignore — this is cleanup */
  }
}
